"""The `reply` and `steps` behaviours of the scenario service (services/scenario.py).

- `reply`: one model request with `service.params` as a `call` step, then returns its text.
- `steps`: runs `service.params.steps` in order and returns the last call's text unless a step
  ends the function first. Steps:
  - `{"call": request, "swallow": bool}`: one model request (`model`, `user`, `system`,
    `stream`, `maxTokens`, `tools`); `swallow` goes on after the SDK's exception.
  - `{"print": text}`, `{"write-fd": text, "times": n}` (descriptor 1, the text repeated n
    times, 1 by default), `{"child": text}` (a child process prints it): output the service
    writes.
  - `{"sleep": ms}`; `{"raise": {"class": name, "message": text}}`.
  - `{"background": request, "delay": ms}` (asynchronous backends): an asyncio task, not
    awaited, that sends the request after the delay, or raises when the request is
    `{"raise": ...}`; its exception is never retrieved.
  - `{"thread": request}`: the request from a new thread that runs in an empty context, so
    it carries no trial context; the step waits for the thread.
  - `{"child-request": request}`: a child process sends the request with the standard
    library, outside every captured transport.
  - `{"return": text}`, `{"fallback": text | true}` (true: the last call's text).
  - `{"report": "case" | "variant" | "calls" | "thread", "toolArgs": [name, ...]}`: returns,
    as JSON text, the case's fields, the variant's, the call fields of the target function's
    third argument (with `tool_args(name)` for each name of `toolArgs`), or whether the
    function runs on the main thread.

The SDK client is created per trial with `max_retries` from `service.params.maxRetries` (0 by
default, so each scripted response is one call) and `timeout` from `timeoutS`.
"""

from __future__ import annotations

import asyncio
import contextvars
import importlib
import json
import os
import subprocess
import sys
import threading
from collections.abc import Awaitable, Callable
from typing import Any

from model_eval_adapter import fallback

JsonObject = dict[str, Any]

SDK_OF_API = {"chat-completions": "openai", "responses": "openai", "messages": "anthropic"}
CLIENT_CLASSES = {
    ("openai", False): "OpenAI",
    ("openai", True): "AsyncOpenAI",
    ("anthropic", False): "Anthropic",
    ("anthropic", True): "AsyncAnthropic",
}
DEFAULT_USER = "Say hello."
DEFAULT_MAX_TOKENS = 256
CALL_FIELDS = (
    "model",
    "messages",
    "tool_names",
    "text",
    "tool_calls",
    "finish_reason",
    "usage",
    "outcome",
    "error",
    "retried",
)
# The `child-request` step's child process: one POST with urllib to the API the harness set.
CHILD_REQUEST = """
import json, os, sys, urllib.request
api, body = sys.argv[1], sys.argv[2]
if api == "messages":
    url = os.environ["ANTHROPIC_BASE_URL"] + "/v1/messages"
    headers = {"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01"}
else:
    path = "/chat/completions" if api == "chat-completions" else "/responses"
    url = os.environ["OPENAI_BASE_URL"] + path
    headers = {"authorization": "Bearer " + os.environ["OPENAI_API_KEY"]}
headers["content-type"] = "application/json"
request = urllib.request.Request(url, data=body.encode(), headers=headers, method="POST")
urllib.request.urlopen(request, timeout=10).read()
"""
# Tasks of the `background` step, held until they end so that they are not collected early.
BACKGROUND: set[asyncio.Task[Any]] = set()


# --- Requests ---------------------------------------------------------------------------------


def make_client(api: str, backend: str, params: JsonObject) -> Any:
    """A new SDK client; the SDK module is imported here, inside the service, after the helper."""
    sdk = importlib.import_module(SDK_OF_API[api])
    options: JsonObject = {"max_retries": int(params.get("maxRetries", 0))}
    if "timeoutS" in params:
        options["timeout"] = float(params["timeoutS"])
    if backend == "aiohttp":
        options["http_client"] = sdk.DefaultAioHttpClient()
    return getattr(sdk, CLIENT_CLASSES[(SDK_OF_API[api], backend != "sync")])(**options)


def tool_definitions(api: str, names: list[str]) -> list[JsonObject]:
    schema = {"type": "object", "properties": {"text": {"type": "string"}}}
    if api == "chat-completions":
        return [{"type": "function", "function": {"name": n, "parameters": schema}} for n in names]
    if api == "responses":
        return [{"type": "function", "name": name, "parameters": schema} for name in names]
    return [{"name": name, "input_schema": schema} for name in names]


def request_arguments(api: str, request: JsonObject, model: str, user: str) -> JsonObject:
    """The keyword arguments of the SDK's create method."""
    arguments: JsonObject = {"model": str(request.get("model", model))}
    text = str(request.get("user", user))
    system = request.get("system")
    max_tokens = request.get("maxTokens")
    if request.get("tools"):
        arguments["tools"] = tool_definitions(api, list(request["tools"]))
    if api == "chat-completions":
        leading = [{"role": "system", "content": system}] if system else []
        arguments["messages"] = [*leading, {"role": "user", "content": text}]
        if max_tokens is not None:
            arguments["max_completion_tokens"] = max_tokens
    elif api == "responses":
        arguments["input"] = [{"role": "user", "content": text}]
        if system:
            arguments["instructions"] = system
        if max_tokens is not None:
            arguments["max_output_tokens"] = max_tokens
    else:
        arguments["messages"] = [{"role": "user", "content": text}]
        arguments["max_tokens"] = max_tokens or DEFAULT_MAX_TOKENS
        if system:
            arguments["system"] = system
    if request.get("stream"):
        arguments["stream"] = True
    return arguments


def create_method(client: Any, api: str) -> Any:
    if api == "chat-completions":
        return client.chat.completions.create
    if api == "responses":
        return client.responses.create
    return client.messages.create


def response_text(api: str, response: Any) -> str:
    if api == "chat-completions":
        return response.choices[0].message.content or ""
    if api == "responses":
        return str(response.output_text)
    return "".join(block.text for block in response.content if block.type == "text")


def event_text(api: str, event: Any) -> str:
    if api == "chat-completions":
        return (event.choices[0].delta.content or "") if event.choices else ""
    if api == "responses":
        return str(event.delta) if event.type == "response.output_text.delta" else ""
    if event.type == "content_block_delta" and event.delta.type == "text_delta":
        return str(event.delta.text)
    return ""


# --- Steps ------------------------------------------------------------------------------------


class Steps:
    """One trial of the `steps` behaviour."""

    def __init__(self, run: Any) -> None:
        self.run = run
        self.api: str = run.api
        self.sync = run.backend == "sync"
        self.last_text = ""
        self.client: Any = None

    def user(self) -> str:
        return str((self.run.case.input or {}).get("user", DEFAULT_USER))

    async def call(self, request: JsonObject) -> str:
        if self.client is None:
            self.client = make_client(self.api, self.run.backend, self.run.params)
        create = create_method(self.client, self.api)
        arguments = request_arguments(self.api, request, self.run.variant.model, self.user())
        response = create(**arguments) if self.sync else await create(**arguments)
        if not arguments.get("stream"):
            self.last_text = response_text(self.api, response)
        elif self.sync:
            self.last_text = "".join(event_text(self.api, event) for event in response)
        else:
            self.last_text = "".join([event_text(self.api, event) async for event in response])
        return self.last_text

    async def close(self) -> None:
        if self.client is None:
            return
        if self.sync:
            self.client.close()
        else:
            await self.client.close()

    async def step(self, step: JsonObject) -> tuple[bool, Any]:
        """Runs one step; returns (True, value) when the step ends the function with that value."""
        if "call" in step:
            try:
                await self.call(step["call"])
            except Exception:
                if not step.get("swallow"):
                    raise
        elif "print" in step:
            print(step["print"], flush=True)
        elif "write-fd" in step:
            text = str(step["write-fd"]) * int(step.get("times", 1))
            os.write(1, text.encode("utf-8"))
        elif "child" in step:
            code = f"print({str(step['child'])!r})"
            subprocess.run([sys.executable, "-c", code], check=True)
        elif "thread" in step:
            self.without_context(step["thread"])
        elif "child-request" in step:
            self.child_request(step["child-request"])
        elif "background" in step:
            self.background(step["background"], int(step.get("delay", 0)) / 1000)
        elif "sleep" in step:
            await self.sleep(int(step["sleep"]) / 1000)
        elif "raise" in step:
            raise self.run.exception(step["raise"]["class"], step["raise"].get("message", ""))
        elif "return" in step:
            return True, step["return"]
        elif "fallback" in step:
            return True, fallback(self.last_text if step["fallback"] is True else step["fallback"])
        elif "report" in step:
            report = self.report(step["report"], list(step.get("toolArgs", [])))
            return True, json.dumps(report, ensure_ascii=False)
        else:
            raise ValueError(f"unknown step {step}")
        return False, None

    def background(self, request: JsonObject, delay_s: float) -> None:
        if self.sync:
            raise ValueError("the background step needs an asynchronous backend")
        client = make_client(self.api, self.run.backend, self.run.params)
        model, user = self.run.variant.model, self.user()

        async def work() -> None:
            await asyncio.sleep(delay_s)
            if "raise" in request:
                raise self.run.exception(
                    request["raise"]["class"], request["raise"].get("message", "")
                )
            create = create_method(client, self.api)
            await create(**request_arguments(self.api, request, model, user))

        task = asyncio.get_running_loop().create_task(work())
        BACKGROUND.add(task)
        task.add_done_callback(BACKGROUND.discard)

    def without_context(self, request: JsonObject) -> None:
        client = make_client(self.api, "sync", self.run.params)
        arguments = request_arguments(self.api, request, self.run.variant.model, self.user())
        errors: list[Exception] = []

        def send() -> None:
            try:
                create_method(client, self.api)(**arguments)
            except Exception as error:
                errors.append(error)

        thread = threading.Thread(target=contextvars.Context().run, args=(send,))
        thread.start()
        thread.join()
        client.close()
        if errors:
            raise errors[0]

    def child_request(self, request: JsonObject) -> None:
        arguments = request_arguments(self.api, request, self.run.variant.model, self.user())
        arguments.pop("stream", None)
        subprocess.run(
            [sys.executable, "-c", CHILD_REQUEST, self.api, json.dumps(arguments)], check=True
        )

    async def sleep(self, seconds: float) -> None:
        if self.sync:
            threading.Event().wait(seconds)
        else:
            await asyncio.sleep(seconds)

    def report(self, what: str, tool_args: list[str]) -> Any:
        if what == "case":
            names = ("id", "lang", "input", "repeat", "seed", "rendering")
            return {name: getattr(self.run.case, name) for name in names}
        if what == "variant":
            return {name: getattr(self.run.variant, name) for name in ("id", "model", "params")}
        if what == "thread":
            return {"mainThread": threading.current_thread() is threading.main_thread()}
        if what == "calls":
            return [self.call_fields(call, tool_args) for call in self.run.calls]
        raise ValueError(f"unknown report {what}")

    @staticmethod
    def call_fields(call: Any, tool_args: list[str]) -> JsonObject:
        """A call's fields; a field the call does not have is null."""
        fields: JsonObject = {name: getattr(call, name, None) for name in CALL_FIELDS}
        fields["tool_args"] = {name: call.tool_args(name) for name in tool_args}
        return fields


async def run_steps(run: Any, steps: list[JsonObject]) -> Any:
    trial = Steps(run)
    try:
        for step in steps:
            done, value = await trial.step(step)
            if done:
                return value
        return trial.last_text
    finally:
        await trial.close()


async def reply(run: Any) -> Any:
    return await run_steps(run, [{"call": run.params}])


async def steps(run: Any) -> Any:
    return await run_steps(run, run.params["steps"])


BEHAVIOURS: dict[str, Callable[[Any], Awaitable[Any]]] = {"reply": reply, "steps": steps}
