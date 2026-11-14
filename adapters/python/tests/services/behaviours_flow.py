"""The `flow` behaviour: a service whose model calls, error handling, concurrency and return value
are given as data in `service.params`, so one fixture row describes one service shape for every
API and backend. The Node scenario services read the same parameters.

    {"steps": [step, ...], "result": result, "sharedClient": {"maxConnections": n}}

`sharedClient` gives every call of the flow one asynchronous HTTP client with that many
connections, so a call can wait for the connection pool. Steps, run in order:

- `{"call": call}`: one model request; see `CallSpec`.
- `{"parallel": [call, ...], "wait": "all" | "first"}`: the requests sent together. `first`
  takes the first that succeeds and cancels the rest (asynchronous backends only).
- `{"thread": call, "context": "copy" | "none", "join": bool}`: the request from a new thread,
  with a copy of the trial context or none; `join` waits for the thread (default true).
- `{"executor": call}`: the request through `loop.run_in_executor`, which passes no context
  (asynchronous backends only).
- `{"background": call | {"raise": ...}, "delayMs": n}`: started and not awaited, so it runs on
  after the function returned; `raise` makes that work raise (asynchronous backends only).
- `{"afterCertificateError": call}`: a plain HTTPS GET of the API base URL with the standard
  library fails on the server's certificate, and the request is made while that error is
  being handled, so the certificate error is the request exception's `__context__`.
- `{"uncaptured": call}`, `{"child": call}`: the request sent with `urllib`, in this process or
  from a child process, so the helper cannot capture it.
- `{"http": {"method": m, "path": p, "json": body, "status": n, "name": label, "onError": e}}`:
  one request through the transport's own client (httpx or httpx2, whichever the SDK uses) to
  the API's base URL with `stream=False`, with one connection in its pool; `status` makes a
  different status raise.
- `{"notLoaded": [module, ...]}`: raises when one of the modules is already imported, so the
  SDK the next call imports is imported inside the service function.
- `{"sleepMs": n}`.
- `{"raise": {"class": name, "message": text}}`.

`result`, what the function ends with after the steps (default: the text of the last call that
succeeded, or an empty text):

- `{"text": text}`, `{"fallback": text}`: that text, or `fallback(text)`.
- `{"callText": name}`, `{"fallbackCallText": name}`: the text a named call received.
- `{"raise": {"class": name, "message": text}}`.
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
import urllib.error
import urllib.request
from collections.abc import Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import uncaptured_post

from model_eval_adapter import fallback

JsonObject = dict[str, Any]

DEFAULT_SYSTEM = "You are a helpful assistant."
DEFAULT_USER = "Say hello."
DEFAULT_MAX_TOKENS = 256
TOOL_RESULT = "tool result"
FOLLOW_UP = "Check the answer."
TOOL_PARAMETERS: JsonObject = {
    "type": "object",
    "properties": {"text": {"type": "string"}},
    "required": ["text"],
}


class ServiceTimeout(Exception):
    """The service's own time limit fired (`limitMs`, `waitMs`)."""


# --- Requests ---------------------------------------------------------------------------------


@dataclass
class CallSpec:
    """One model request of a `flow`.

    `name` labels it for later steps; `api` sends it to another API than the case's; `model`
    defaults to the variant model; `system` and `user` give the prompt, `userBytes` a user
    message of that many characters; `tools` names function tools and `toolChoice` forces one;
    `n` and `maxTokens` are request fields; `kwargs` are merged into the SDK call as they are.
    `baseUrl` replaces the API's base URL and `basePath` is appended to it; `plainMock` sends
    to the mock server's plain HTTP address (`MODEL_EVAL_MOCK_URL`), also in a TLS case.
    `startAfterMs` waits before sending.

    `after` continues the conversation of an earlier call: its tool calls answered with tool
    results when it ended in a tool call (a tool-loop step), else its text and `user` as a new
    user message (a new branch). `same` sends an earlier call's request again, with `stream`
    when given.

    `stream` asks for SSE. `read` says how much of a stream the service reads: `all` (default),
    `none` (left unread and open), `close` (closed unread) or `{"events": n}` (`break` after
    n events); `closeAfterMs` has other work close the stream while the read waits (asynchronous
    backends). `streamingResponse` uses the SDK's `with_streaming_response`: `all` reads the
    body, `headers` returns after the headers, `chunk` after one chunk.

    `maxRetries` is the SDK's resend count (default 0); `timeoutMs`, `connectTimeoutMs` and
    `poolTimeoutMs` are its time limits.
    `limitMs` is the service's own time limit, which cancels the request (asynchronous
    backends), and `waitMs` one that only stops waiting and leaves the request running.

    `onError` says what the service does when the call raises: `raise` (default), `swallow`,
    or `{"raise": {"class": name, "message": text}}` to raise its own exception instead.
    """

    data: JsonObject

    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, default)

    @property
    def name(self) -> str | None:
        name = self.data.get("name")
        return None if name is None else str(name)


@dataclass
class Conversation:
    system: str
    tools: list[str] = field(default_factory=list)
    items: list[JsonObject] = field(default_factory=list)


@dataclass
class Received:
    """What the service got from one call."""

    kwargs: JsonObject
    conversation: Conversation
    response: Any = None
    text: str = ""
    error: BaseException | None = None


def tool_definitions(api: str, names: list[str]) -> list[JsonObject]:
    if api == "chat-completions":
        return [
            {"type": "function", "function": {"name": name, "parameters": TOOL_PARAMETERS}}
            for name in names
        ]
    if api == "responses":
        return [{"type": "function", "name": name, "parameters": TOOL_PARAMETERS} for name in names]
    return [{"name": name, "input_schema": TOOL_PARAMETERS} for name in names]


def forced_tool(api: str, name: str) -> JsonObject:
    if api == "chat-completions":
        return {"type": "function", "function": {"name": name}}
    if api == "responses":
        return {"type": "function", "name": name}
    return {"type": "tool", "name": name}


def request_kwargs(api: str, conversation: Conversation, spec: CallSpec, model: str) -> JsonObject:
    kwargs: JsonObject = {"model": model}
    if api == "chat-completions":
        kwargs["messages"] = [{"role": "system", "content": conversation.system}]
        kwargs["messages"].extend(conversation.items)
        if "n" in spec.data:
            kwargs["n"] = spec.data["n"]
        if "maxTokens" in spec.data:
            kwargs["max_tokens"] = spec.data["maxTokens"]
    elif api == "responses":
        kwargs["instructions"] = conversation.system
        kwargs["input"] = list(conversation.items)
        if "maxTokens" in spec.data:
            kwargs["max_output_tokens"] = spec.data["maxTokens"]
    else:
        kwargs["system"] = conversation.system
        kwargs["messages"] = list(conversation.items)
        kwargs["max_tokens"] = spec.get("maxTokens", DEFAULT_MAX_TOKENS)
    if conversation.tools:
        kwargs["tools"] = tool_definitions(api, conversation.tools)
    if "toolChoice" in spec.data:
        kwargs["tool_choice"] = forced_tool(api, spec.data["toolChoice"])
    if spec.get("stream"):
        kwargs["stream"] = True
    kwargs.update(spec.get("kwargs", {}))
    return kwargs


def dump(value: Any) -> Any:
    """An SDK model as JSON values, without the fields the response left out."""
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", exclude_none=True, exclude_unset=True)
    return value


def response_text(api: str, response: Any) -> str:
    if api == "chat-completions":
        return str(response.choices[0].message.content or "")
    if api == "responses":
        return str(response.output_text)
    return "".join(block.text for block in response.content if block.type == "text")


def tool_call_ids(api: str, response: Any) -> list[str]:
    if api == "chat-completions":
        return [call.id for call in response.choices[0].message.tool_calls or []]
    if api == "responses":
        return [item.call_id for item in response.output if item.type == "function_call"]
    return [block.id for block in response.content if block.type == "tool_use"]


def continued(api: str, earlier: Received, follow_up: str) -> Conversation:
    """The conversation after an earlier call: a tool-loop step when it ended in tool calls,
    else its text and a new user message (data-model §Call Branches)."""
    base = earlier.conversation
    conversation = Conversation(base.system, list(base.tools), list(base.items))
    response = earlier.response
    ids = tool_call_ids(api, response) if response is not None else []
    if not ids:
        conversation.items.append({"role": "assistant", "content": earlier.text})
        conversation.items.append({"role": "user", "content": follow_up})
        return conversation
    if api == "chat-completions":
        conversation.items.append(dump(response.choices[0].message))
        for call_id in ids:
            conversation.items.append(
                {"role": "tool", "tool_call_id": call_id, "content": TOOL_RESULT}
            )
    elif api == "responses":
        conversation.items.extend(dump(item) for item in response.output)
        for call_id in ids:
            conversation.items.append(
                {"type": "function_call_output", "call_id": call_id, "output": TOOL_RESULT}
            )
    else:
        content = [dump(block) for block in response.content]
        conversation.items.append({"role": "assistant", "content": content})
        results = [
            {"type": "tool_result", "tool_use_id": call_id, "content": TOOL_RESULT}
            for call_id in ids
        ]
        conversation.items.append({"role": "user", "content": results})
    return conversation


def http_text(api: str, body: bytes) -> str:
    """The answer text of a JSON model response body, or the body itself for other responses."""
    text = body.decode("utf-8", "replace")
    try:
        return uncaptured_post.answer_text(api, json.loads(text))
    except (ValueError, KeyError, TypeError, IndexError, AttributeError):
        return text


def event_text(api: str, event: Any) -> str:
    """The answer text one stream event carries."""
    if api == "chat-completions":
        choices = getattr(event, "choices", None) or []
        delta = choices[0].delta if choices else None
        return str(getattr(delta, "content", None) or "")
    kind = getattr(event, "type", "")
    if api == "responses":
        return str(event.delta) if kind == "response.output_text.delta" else ""
    if kind == "content_block_delta" and getattr(event.delta, "type", "") == "text_delta":
        return str(event.delta.text)
    return ""


# --- SDK clients ------------------------------------------------------------------------------


def sdk(api: str) -> Any:
    return importlib.import_module("anthropic" if api == "messages" else "openai")


def transport_module(module: Any) -> Any:
    """`httpx` or `httpx2`, whichever the SDK's default client is built on."""
    base = module.DefaultHttpxClient.__mro__[1]
    return importlib.import_module(base.__module__.split(".")[0])


def client_kwargs(api: str, spec: CallSpec) -> JsonObject:
    """`maxRetries`; `timeoutMs`, `connectTimeoutMs` and `poolTimeoutMs` for the SDK's time
    limits; `baseUrl` for a server other than the mock API server's."""
    module = sdk(api)
    kwargs: JsonObject = {"max_retries": int(spec.get("maxRetries", 0))}
    total = spec.get("timeoutMs", 30_000) / 1000
    if "connectTimeoutMs" in spec.data or "poolTimeoutMs" in spec.data:
        kwargs["timeout"] = module.Timeout(
            total,
            connect=spec.get("connectTimeoutMs", 30_000) / 1000,
            pool=spec.get("poolTimeoutMs", 30_000) / 1000,
        )
    elif "timeoutMs" in spec.data:
        kwargs["timeout"] = total
    if spec.get("plainMock"):
        plain = os.environ["MODEL_EVAL_MOCK_URL"]
        kwargs["base_url"] = plain if api == "messages" else f"{plain}/v1"
    elif "baseUrl" in spec.data:
        kwargs["base_url"] = spec.data["baseUrl"]
    elif "basePath" in spec.data:
        kwargs["base_url"] = base_url(api) + spec.data["basePath"]
    return kwargs


def base_url(api: str) -> str:
    """The base URL the harness gave the SDK of this API."""
    name = "ANTHROPIC_BASE_URL" if api == "messages" else "OPENAI_BASE_URL"
    return os.environ[name].rstrip("/")


def sync_client(api: str, spec: CallSpec) -> Any:
    module = sdk(api)
    factory = module.Anthropic if api == "messages" else module.OpenAI
    return factory(**client_kwargs(api, spec))


def async_client(api: str, backend: str, spec: CallSpec, shared: Any = None) -> Any:
    module = sdk(api)
    factory = module.AsyncAnthropic if api == "messages" else module.AsyncOpenAI
    kwargs = client_kwargs(api, spec)
    if shared is not None:
        kwargs["http_client"] = shared
    elif backend == "aiohttp":
        kwargs["http_client"] = module.DefaultAioHttpClient()
    return factory(**kwargs)


def shared_async_transport(api: str, options: JsonObject) -> Any:
    """One asynchronous HTTP client for every call of a flow, with `maxConnections`
    connections, so a call can wait for the connection pool."""
    module = sdk(api)
    limits = transport_module(module).Limits(max_connections=int(options["maxConnections"]))
    return module.DefaultAsyncHttpxClient(limits=limits)


def resource(client: Any, api: str) -> Any:
    if api == "chat-completions":
        return client.chat.completions
    if api == "responses":
        return client.responses
    return client.messages


def send_sync(api: str, spec: CallSpec, kwargs: JsonObject, client: Any = None) -> tuple[Any, str]:
    """Sends one request with the synchronous client, made here unless given: (response or
    None, text read)."""
    client = client if client is not None else sync_client(api, spec)
    mode = spec.get("streamingResponse")
    if mode is not None:
        with resource(client, api).with_streaming_response.create(**kwargs) as response:
            if mode == "headers":
                return None, ""
            if mode == "chunk":
                next(iter(response.iter_bytes()), b"")
                return None, ""
            parsed = response.parse()
            if kwargs.get("stream"):
                return None, "".join(event_text(api, event) for event in parsed)
            return parsed, response_text(api, parsed)
    result = resource(client, api).create(**kwargs)
    if not kwargs.get("stream"):
        return result, response_text(api, result)
    return read_sync(api, spec, result)


class Collected:
    """What the service took from a stream: its text and, for Responses, the final response
    object of the end event, so a tool loop can continue from it."""

    def __init__(self, api: str) -> None:
        self.api = api
        self.pieces: list[str] = []
        self.response: Any = None

    def add(self, event: Any) -> None:
        self.pieces.append(event_text(self.api, event))
        if getattr(event, "type", "") in RESPONSES_END_EVENTS:
            self.response = event.response

    def result(self) -> tuple[Any, str]:
        return self.response, "".join(self.pieces)


RESPONSES_END_EVENTS = ("response.completed", "response.incomplete", "response.failed")


def read_sync(api: str, spec: CallSpec, stream: Any) -> tuple[Any, str]:
    collected = Collected(api)
    read = spec.get("read", "all")
    if read == "none":
        return collected.result()
    if read == "close":
        stream.close()
        return collected.result()
    limit = read.get("events") if isinstance(read, dict) else None
    for count, event in enumerate(stream, start=1):
        collected.add(event)
        if limit is not None and count >= limit:
            break
    return collected.result()


async def send_async(
    api: str, backend: str, spec: CallSpec, kwargs: JsonObject, client: Any = None
) -> tuple[Any, str]:
    client = client if client is not None else async_client(api, backend, spec)
    mode = spec.get("streamingResponse")
    if mode is not None:
        async with resource(client, api).with_streaming_response.create(**kwargs) as response:
            if mode == "headers":
                return None, ""
            if mode == "chunk":
                async for _ in response.iter_bytes():
                    break
                return None, ""
            parsed = await response.parse()
            if kwargs.get("stream"):
                return None, "".join([event_text(api, event) async for event in parsed])
            return parsed, response_text(api, parsed)
    result = await resource(client, api).create(**kwargs)
    if not kwargs.get("stream"):
        return result, response_text(api, result)
    return await read_async(api, spec, result)


async def read_async(api: str, spec: CallSpec, stream: Any) -> tuple[Any, str]:
    """As `read_sync`; `closeAfterMs` also has other work close the body while the read
    waits for a chunk."""
    collected = Collected(api)
    read = spec.get("read", "all")
    if read == "none":
        return collected.result()
    if read == "close":
        await stream.close()
        return collected.result()
    limit = read.get("events") if isinstance(read, dict) else None
    closing = None
    if "closeAfterMs" in spec.data:
        closing = asyncio.get_running_loop().call_later(
            spec.data["closeAfterMs"] / 1000, lambda: asyncio.ensure_future(stream.close())
        )
    try:
        count = 0
        async for event in stream:
            collected.add(event)
            count += 1
            if limit is not None and count >= limit:
                break
    finally:
        if closing is not None:
            closing.cancel()
    return collected.result()


# --- Running a flow ---------------------------------------------------------------------------


class Flow:
    """One run of the `flow` behaviour inside a target function."""

    def __init__(self, run: Any) -> None:
        self.run = run
        self.api: str = run.api
        self.backend: str = run.backend
        self.sync = run.backend == "sync"
        self.received: dict[str, Received] = {}
        self.last_ok: Received | None = None
        self.transport: Any = None
        self.background_tasks: set[asyncio.Future[None]] = set()
        shared = run.params.get("sharedClient")
        self.shared = None if shared is None else shared_async_transport(self.api, shared)

    def exception(self, raise_spec: JsonObject) -> Exception:
        """`{"class": name, "message": text}` as the scenario service's exception of that
        class, the class `discard_on` names."""
        error: Exception = self.run.exception(raise_spec["class"], raise_spec.get("message", ""))
        return error

    def user_text(self) -> str:
        user = (self.run.case.input or {}).get("user", DEFAULT_USER)
        return str(user)

    def api_of(self, spec: CallSpec) -> str:
        return str(spec.get("api", self.api))

    def prepare(self, spec: CallSpec) -> tuple[JsonObject, Conversation]:
        api = self.api_of(spec)
        model = str(spec.get("model", self.run.variant.model))
        if "same" in spec.data:
            earlier = self.received[spec.data["same"]]
            kwargs = dict(earlier.kwargs, model=model)
            if "stream" in spec.data:
                kwargs.pop("stream", None)
                if spec.data["stream"]:
                    kwargs["stream"] = True
            return kwargs, earlier.conversation
        if "after" in spec.data:
            follow_up = str(spec.get("user", FOLLOW_UP))
            conversation = continued(api, self.received[spec.data["after"]], follow_up)
        else:
            conversation = Conversation(
                str(spec.get("system", DEFAULT_SYSTEM)), list(spec.get("tools", []))
            )
            user = str(spec.get("user", self.user_text()))
            if "userBytes" in spec.data:
                user = "x" * int(spec.data["userBytes"])
            conversation.items.append({"role": "user", "content": user})
        return request_kwargs(api, conversation, spec, model), conversation

    def record(self, spec: CallSpec, received: Received) -> Received:
        if spec.name is not None:
            self.received[spec.name] = received
        if received.error is None:
            self.last_ok = received
        return received

    def finish(self, spec: CallSpec, received: Received) -> Received:
        """Applies `onError` to a call that raised."""
        self.record(spec, received)
        error = received.error
        if error is None:
            return received
        on_error = spec.get("onError", "raise")
        if on_error == "swallow":
            return received
        if isinstance(on_error, dict) and "raise" in on_error:
            raise self.exception(on_error["raise"]) from error
        raise error

    # One call in each mode

    def client_for(self, spec: CallSpec, sync: bool) -> Any:
        """The SDK client of one call, built before the call starts, with its API resource
        resolved: the SDKs import their resource modules on first access, which takes longer
        than a member's `startAfterMs`."""
        api = self.api_of(spec)
        client = (
            sync_client(api, spec) if sync else async_client(api, self.backend, spec, self.shared)
        )
        resource(client, api)
        return client

    def call_in_thread(self, spec: CallSpec, client: Any = None) -> Received:
        """A request with the synchronous client, for the sync backend and for threads."""
        if "startAfterMs" in spec.data:
            threading.Event().wait(spec.data["startAfterMs"] / 1000)
        kwargs, conversation = self.prepare(spec)
        received = Received(kwargs, conversation)
        try:
            received.response, received.text = send_sync(self.api_of(spec), spec, kwargs, client)
        except Exception as error:
            received.error = error
        return received

    async def call_awaited(self, spec: CallSpec, client: Any = None) -> Received:
        if "startAfterMs" in spec.data:
            await asyncio.sleep(spec.data["startAfterMs"] / 1000)
        kwargs, conversation = self.prepare(spec)
        received = Received(kwargs, conversation)
        if client is None:
            client = self.client_for(spec, False)
        sending = send_async(self.api_of(spec), self.backend, spec, kwargs, client)
        try:
            if "limitMs" in spec.data:
                outcome = await asyncio.wait_for(sending, spec.data["limitMs"] / 1000)
            elif "waitMs" in spec.data:
                outcome = await self.wait_without_cutting(sending, spec.data["waitMs"])
            else:
                outcome = await sending
            received.response, received.text = outcome
        except asyncio.TimeoutError:
            received.error = ServiceTimeout("the service's time limit fired")
        except Exception as error:
            received.error = error
        return received

    async def wait_without_cutting(
        self, sending: Awaitable[tuple[Any, str]], wait_ms: int
    ) -> tuple[Any, str]:
        task = asyncio.ensure_future(sending)
        done, _ = await asyncio.wait({task}, timeout=wait_ms / 1000)
        if task not in done:
            raise asyncio.TimeoutError
        return task.result()

    async def call(self, spec: CallSpec) -> Received:
        if self.sync:
            received = self.call_in_thread(spec)
        else:
            received = await self.call_awaited(spec)
        return self.finish(spec, received)

    # Steps

    async def parallel(self, specs: list[CallSpec], wait: str) -> None:
        # The SDK is imported and every client built before the first member starts, so that
        # `startAfterMs` delays only the send and the members leave in the order given.
        clients = [self.client_for(spec, self.sync) for spec in specs]
        if self.sync:
            if wait != "all":
                raise ValueError("`first` needs an asynchronous backend")
            with ThreadPoolExecutor(max_workers=len(specs)) as pool:
                futures = [
                    pool.submit(contextvars.copy_context().run, self.call_in_thread, spec, client)
                    for spec, client in zip(specs, clients, strict=True)
                ]
                outcomes = [future.result() for future in futures]
            for spec, received in zip(specs, outcomes, strict=True):
                self.finish(spec, received)
            return
        tasks = [
            asyncio.ensure_future(self.call_awaited(spec, client))
            for spec, client in zip(specs, clients, strict=True)
        ]
        if wait == "all":
            outcomes = await asyncio.gather(*tasks)
            for spec, received in zip(specs, outcomes, strict=True):
                self.finish(spec, received)
            return
        await self.first_success(specs, tasks)

    async def first_success(
        self, specs: list[CallSpec], tasks: list[asyncio.Task[Received]]
    ) -> None:
        pending = set(tasks)
        winner: int | None = None
        while pending and winner is None:
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                if task.result().error is None and winner is None:
                    winner = tasks.index(task)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for index, spec in enumerate(specs):
            task = tasks[index]
            if not task.cancelled():
                self.record(spec, task.result())
        if winner is None:
            failed = next(task.result() for task in tasks if not task.cancelled())
            self.finish(specs[0], failed)

    async def thread(self, spec: CallSpec, context: str, join: bool) -> None:
        def work() -> None:
            self.record(spec, self.call_in_thread(spec))

        target: Callable[[], None] = work
        if context == "copy":
            snapshot = contextvars.copy_context()

            def target() -> None:
                snapshot.run(work)

        worker = threading.Thread(target=target, daemon=True)
        worker.start()
        if join:
            if self.sync:
                worker.join()
            else:
                await asyncio.get_running_loop().run_in_executor(None, worker.join)

    async def executor(self, spec: CallSpec) -> None:
        if self.sync:
            raise ValueError("`executor` needs an asynchronous backend")
        loop = asyncio.get_running_loop()
        received = await loop.run_in_executor(None, self.call_in_thread, spec)
        self.finish(spec, received)

    def background(self, step: JsonObject) -> None:
        delay = int(step.get("delayMs", 0)) / 1000
        work = step["background"]
        if self.sync:
            if "raise" in work:
                raise ValueError("a raising background step needs an asynchronous backend")
            spec = CallSpec(work)

            def later() -> None:
                threading.Event().wait(delay)
                self.record(spec, self.call_in_thread(spec))

            snapshot = contextvars.copy_context()
            threading.Thread(target=snapshot.run, args=(later,), daemon=True).start()
            return
        # The loop keeps only weak references to tasks; hold one until the work ends, then let
        # it go as a service that never awaits the task does.
        task = asyncio.ensure_future(self.background_async(work, delay))
        self.background_tasks.add(task)
        task.add_done_callback(self.background_tasks.discard)

    async def background_async(self, work: JsonObject, delay: float) -> None:
        await asyncio.sleep(delay)
        if "raise" in work:
            raise self.exception(work["raise"])
        spec = CallSpec(work)
        self.record(spec, await self.call_awaited(spec))

    async def step(self, step: JsonObject) -> None:
        if "call" in step:
            await self.call(CallSpec(step["call"]))
        elif "parallel" in step:
            specs = [CallSpec(data) for data in step["parallel"]]
            await self.parallel(specs, str(step.get("wait", "all")))
        elif "thread" in step:
            spec = CallSpec(step["thread"])
            await self.thread(spec, str(step.get("context", "none")), bool(step.get("join", True)))
        elif "executor" in step:
            await self.executor(CallSpec(step["executor"]))
        elif "background" in step:
            self.background(step)
        elif "uncaptured" in step or "child" in step:
            await self.uncaptured(
                CallSpec(step.get("uncaptured") or step["child"]), "child" in step
            )
        elif "notLoaded" in step:
            loaded = [name for name in step["notLoaded"] if name in sys.modules]
            if loaded:
                raise RuntimeError(f"imported before the service function: {loaded}")
        elif "http" in step:
            await self.http(step["http"])
        elif "afterCertificateError" in step:
            await self.after_certificate_error(CallSpec(step["afterCertificateError"]))
        elif "sleepMs" in step:
            if self.sync:
                threading.Event().wait(step["sleepMs"] / 1000)
            else:
                await asyncio.sleep(step["sleepMs"] / 1000)
        elif "raise" in step:
            raise self.exception(step["raise"])
        else:
            raise ValueError(f"unknown flow step {json.dumps(step)}")

    async def uncaptured(self, spec: CallSpec, child: bool) -> None:
        kwargs, conversation = self.prepare(spec)
        received = Received(kwargs, conversation)
        api = self.api_of(spec)
        try:
            if child:
                script = str(Path(uncaptured_post.__file__))
                done = subprocess.run(
                    [sys.executable, script, api, json.dumps(kwargs)],
                    capture_output=True,
                    check=True,
                    text=True,
                )
                received.text = done.stdout.rstrip("\n")
            else:
                received.text = uncaptured_post.post(api, kwargs)
        except (OSError, subprocess.CalledProcessError) as error:
            received.error = error
        self.finish(spec, received)

    def http_client(self) -> Any:
        """One client of the SDK's transport for the flow's `http` steps, with one connection,
        so a response left open makes the next step wait for the pool."""
        if self.transport is None:
            module = transport_module(sdk(self.api))
            limits = module.Limits(max_connections=1)
            timeout = module.Timeout(10.0, pool=1.0)
            factory = module.Client if self.sync else module.AsyncClient
            self.transport = factory(limits=limits, timeout=timeout)
        return self.transport

    async def http(self, data: JsonObject) -> None:
        spec = CallSpec(data)
        url = base_url(self.api) + str(data["path"])
        headers = {"authorization": "Bearer test", "x-api-key": "test"}
        received = Received({}, Conversation(""))
        try:
            request = self.http_client().build_request(
                str(data.get("method", "POST")), url, json=data.get("json"), headers=headers
            )
            if self.sync:
                response = self.http_client().send(request, stream=False)
            else:
                response = await self.http_client().send(request, stream=False)
            body = response.content
            if "status" in data and response.status_code != data["status"]:
                raise RuntimeError(f"status {response.status_code}, not {data['status']}")
            received.text = http_text(self.api, body)
        except Exception as error:
            received.error = error
        self.finish(spec, received)

    async def after_certificate_error(self, spec: CallSpec) -> None:
        try:
            urllib.request.urlopen(f"{base_url(self.api)}/models", timeout=10)
        except urllib.error.URLError:
            await self.call(spec)
            return
        raise RuntimeError("the HTTPS request was expected to fail on the certificate")

    def result(self, spec: JsonObject | None) -> Any:
        if spec is None:
            return self.last_ok.text if self.last_ok is not None else ""
        if "text" in spec:
            return spec["text"]
        if "fallback" in spec:
            return fallback(spec["fallback"])
        if "callText" in spec:
            return self.received[spec["callText"]].text
        if "fallbackCallText" in spec:
            return fallback(self.received[spec["fallbackCallText"]].text)
        if "raise" in spec:
            raise self.exception(spec["raise"])
        raise ValueError(f"unknown flow result {json.dumps(spec)}")


async def flow(run: Any) -> Any:
    runner = Flow(run)
    for step in run.params.get("steps", []):
        await runner.step(step)
    return runner.result(run.params.get("result"))


# `sdk-at-import` and `alias-httpx` are the same flow in a process that the services
# capture_import_order.py and capture_alias.py prepare before the scenario service starts.
BEHAVIOURS: dict[str, Callable[[Any], Awaitable[Any]]] = {
    "flow": flow,
    "sdk-at-import": flow,
    "alias-httpx": flow,
}
