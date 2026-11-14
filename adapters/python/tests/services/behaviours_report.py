"""The `flow-report` and `task-group` behaviours: the `flow` of behaviours_flow.py whose target
function reports what the helper cannot see, as a `Result` or a `ModelCallError` (helper-api
§Return Values, §`ModelCallError`, §What the Target Function Reports). The Node scenario
services read the same parameters.

    {"steps": [...], "result": result, "report": report, "onException": report}

`steps` and `result` are those of `flow`. `report` is what the target function gives once the
flow returned; without it, the flow's own value. `onException` is what it gives when the flow
raised, so the service's exception is caught and replaced; without it the exception goes on.
A report is one of:

- `{"result": fields}`: `Result(...)` with `final`, `kind`, `discardReason`, `stages`, `raw`,
  `answers`, `finishReason`, `stoppedEarly`, `usage`, `model` and `modelSnapshot` under their
  Python names. `raw` and `final` may be `{"callText": name}`, the text a named call received;
  `final` defaults to the flow's value when that is a text; `"finalFromFlow": false` next to
  `result` leaves it out, for a `Result` without `final`.
- `{"throw": fields}`: `raise ModelCallError(...)` with `message` (a fixed text by default),
  `status`, `type`, `code`, `kind`, `retryAfterMs`, `model` and `usage`. `errorOf: selector`
  adds a captured call's failure as helper-api §Target Function says to pass it,
  `ModelCallError(message=..., model=c.model, **c.error)`; `call: selector` gives the call itself
  as `call=`. A selector picks an element of the target function's third argument, read when
  the report is built: the calls with every given field (`model`, `outcome`, `systemIncludes`,
  `failed`: whether it has an `error`, `retried`), the first of them, or the `index`-th
  (`-1` for the last).

A helper that lacks `Result` or `ModelCallError`, or one of their keyword arguments, ends the
adapter with one line on stderr, so a trial that needs them cannot pass by another path.

Steps besides those of `flow`:

- `{"guard": {"check": call, "answer": call | [call, ...], "alongside": [call, ...],
  "blockText": text, "cut": "cancel" | "break" | "stopWaiting"}}`: the check, the answer
  requests (one after another in one task, or on the sync backend in one thread that carries
  the trial context) and the `alongside` calls sent together. When the
  check failed or its text contains `blockText` (default `block`), the answers are cut in the
  style the client has (helper-scenarios, cut styles per client): `cancel` (default,
  asynchronous backends) cancels the awaited read, `break` leaves the stream's read loop at its
  next event, `stopWaiting` leaves the requests running and no longer waits for them.
  Otherwise the step waits for the answers. It always waits for the `alongside` calls.
- `{"taskGroup": [call, ...], "except": "raise" | "swallow"}` (`task-group`, Python 3.11): the
  calls as tasks of one `asyncio.TaskGroup`, a call's exception cancelling the others; see
  py311_report.py.
- `{"poolWait": call, "waitMs": n, "then": [step, ...]}`: the request through
  `ThreadPoolExecutor().submit`, which passes no context, and `fut.result(timeout=)`; when the
  wait ends first, the `then` steps run inside the `with` block, whose exit waits for the late
  response.

Call fields besides those of `flow`:

- `read: {"untilText": text}`: `break` after the stream event whose collected text contains it;
  `read: {"untilMs": n}`: `break` at the first event after n ms since the request was sent.
- `waitMs` on the sync backend: the request in a worker thread with `future.result(timeout=)`,
  which stops waiting and leaves it running (`flow`'s asynchronous `waitMs` is the same style).
- `processMs`: an awaited pause after each stream event, the service's work on each chunk.
- `uncaptured: true`: the request sent with `urllib` (uncaptured_post.py) in a worker thread,
  outside every captured transport, so leaving it is only stopping to wait.

A streaming call keeps the tool calls its events carry, so `after` continues a streaming tool
loop as it continues a non-stream one.
"""

from __future__ import annotations

import asyncio
import importlib
import contextvars
import json
import os
import sys
import threading
import time
from collections.abc import Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from typing import Any

import uncaptured_post
from behaviours_flow import (
    RESPONSES_END_EVENTS,
    CallSpec,
    Flow,
    Received,
    ServiceTimeout,
    event_text,
    resource,
    send_async,
    send_sync,
    sync_client,
)

JsonObject = dict[str, Any]

DEFAULT_ERROR_MESSAGE = "The model call failed."
# Exit code of an adapter whose helper cannot build the report (`built`).
SETUP_ERROR_EXIT = 70
RESULT_FIELDS = {
    "final": "final",
    "kind": "kind",
    "discardReason": "discard_reason",
    "stages": "stages",
    "raw": "raw",
    "answers": "answers",
    "finishReason": "finish_reason",
    "stoppedEarly": "stopped_early",
    "usage": "usage",
    "model": "model",
    "modelSnapshot": "model_snapshot",
}
ERROR_FIELDS = {
    "message": "message",
    "status": "status",
    "type": "type",
    "code": "code",
    "kind": "kind",
    "retryAfterMs": "retry_after_ms",
    "model": "model",
    "usage": "usage",
}


# --- Streams the service collects itself ----------------------------------------------------


class StreamAnswer:
    """The text and tool calls of one stream as the service collected them."""

    def __init__(self, api: str) -> None:
        self.api = api
        self.pieces: list[str] = []
        self.tools: dict[int, JsonObject] = {}
        self.responses_final: Any = None
        self.model = ""

    @property
    def text(self) -> str:
        return "".join(self.pieces)

    def add(self, event: Any) -> None:
        self.pieces.append(event_text(self.api, event))
        if self.api == "chat-completions":
            self.add_chat(event)
        elif self.api == "responses":
            if getattr(event, "type", "") in RESPONSES_END_EVENTS:
                self.responses_final = event.response
        else:
            self.add_messages(event)

    def add_chat(self, event: Any) -> None:
        self.model = str(getattr(event, "model", "") or self.model)
        for choice in getattr(event, "choices", None) or []:
            for call in getattr(choice.delta, "tool_calls", None) or []:
                entry = self.tools.setdefault(call.index, {"id": "", "name": "", "arguments": ""})
                function = call.function
                if call.id:
                    entry["id"] = call.id
                if function is not None and function.name:
                    entry["name"] = function.name
                if function is not None and function.arguments:
                    entry["arguments"] += function.arguments

    def add_messages(self, event: Any) -> None:
        kind = getattr(event, "type", "")
        if kind == "message_start":
            self.model = str(event.message.model)
        elif kind == "content_block_start" and event.content_block.type == "tool_use":
            block = event.content_block
            self.tools[event.index] = {"id": block.id, "name": block.name, "arguments": ""}
        elif kind == "content_block_delta" and event.delta.type == "input_json_delta":
            self.tools[event.index]["arguments"] += event.delta.partial_json

    def response(self) -> Any:
        """An SDK response object that ends in these tool calls, so `after` continues the tool
        loop; None when the stream called no tool."""
        if self.api == "responses":
            return self.responses_final
        if not self.tools:
            return None
        calls = [self.tools[index] for index in sorted(self.tools)]
        if self.api == "chat-completions":
            types = importlib.import_module("openai.types.chat")
            message: JsonObject = {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": call["id"],
                        "type": "function",
                        "function": {"name": call["name"], "arguments": call["arguments"]},
                    }
                    for call in calls
                ],
            }
            if self.text:
                message["content"] = self.text
            body = {
                "id": "chatcmpl-stream",
                "object": "chat.completion",
                "created": 0,
                "model": self.model,
                "choices": [{"index": 0, "finish_reason": "tool_calls", "message": message}],
            }
            return types.ChatCompletion.model_validate(body)
        types = importlib.import_module("anthropic.types")
        content: list[JsonObject] = [{"type": "text", "text": self.text}] if self.text else []
        content.extend(
            {
                "type": "tool_use",
                "id": call["id"],
                "name": call["name"],
                "input": json.loads(call["arguments"] or "{}"),
            }
            for call in calls
        )
        return types.Message.model_validate(
            {
                "id": "msg-stream",
                "type": "message",
                "role": "assistant",
                "model": self.model,
                "content": content,
                "stop_reason": "tool_use",
                "stop_sequence": None,
                "usage": {"input_tokens": 0, "output_tokens": 0},
            }
        )


def reads_itself(spec: CallSpec) -> bool:
    """Whether the service reads this call's stream with the loop below rather than the flow's:
    every whole read and the reads this module adds."""
    if spec.get("uncaptured"):
        return False
    read = spec.get("read", "all")
    plain = read == "all" or (isinstance(read, dict) and ("untilText" in read or "untilMs" in read))
    others = ("streamingResponse", "closeAfterMs")
    return bool(spec.get("stream")) and plain and not any(key in spec.data for key in others)


class Leaving:
    """When the service leaves a stream's read loop after an event: once the collected text holds
    `read.untilText`, once `read.untilMs` passed since the request was sent (at the first event
    after that deadline), or once a guard's check blocked (`signal`)."""

    def __init__(self, spec: CallSpec, signal: threading.Event | None) -> None:
        read = spec.get("read")
        read = read if isinstance(read, dict) else {}
        self.text = str(read["untilText"]) if "untilText" in read else None
        self.deadline = None
        if "untilMs" in read:
            self.deadline = time.monotonic() + int(read["untilMs"]) / 1000
        self.signal = signal

    def now(self, answer: StreamAnswer) -> bool:
        if self.text is not None and self.text in answer.text:
            return True
        if self.deadline is not None and time.monotonic() >= self.deadline:
            return True
        return self.signal is not None and self.signal.is_set()


def read_stream_sync(
    api: str,
    spec: CallSpec,
    kwargs: JsonObject,
    client: Any = None,
    signal: threading.Event | None = None,
) -> tuple[Any, str]:
    answer = StreamAnswer(api)
    leaving = Leaving(spec, signal)
    client = client if client is not None else sync_client(api, spec)
    for event in resource(client, api).create(**kwargs):
        answer.add(event)
        if leaving.now(answer):
            break
    return answer.response(), answer.text


async def read_stream_async(
    api: str,
    spec: CallSpec,
    kwargs: JsonObject,
    client: Any,
    signal: threading.Event | None = None,
) -> tuple[Any, str]:
    answer = StreamAnswer(api)
    leaving = Leaving(spec, signal)
    pause = spec.get("processMs")
    stream = await resource(client, api).create(**kwargs)
    async for event in stream:
        answer.add(event)
        if leaving.now(answer):
            break
        if pause is not None:
            await asyncio.sleep(int(pause) / 1000)
    return answer.response(), answer.text


def post_uncaptured(api: str, kwargs: JsonObject) -> str:
    body = {key: value for key, value in kwargs.items() if key != "stream"}
    return uncaptured_post.post(api, body)


# --- Running a reporting flow ---------------------------------------------------------------


class ReportFlow(Flow):
    """A `flow` with the steps, call fields and reports of this module."""

    def __init__(self, run: Any) -> None:
        super().__init__(run)
        # The SDK and its API resource are loaded when the trial starts, as a service that
        # creates its client at start-up has them, so the first request of a step that runs
        # under a time limit or in a pool thread is not held up by loading them.
        client = sync_client(self.api, CallSpec({}))
        resource(client, self.api).create
        client.close()
        # Set by a guard whose check blocked with the cut style `break`; the stream reads of
        # the answer leave their loop at the next event.
        self.cut_signal = threading.Event()

    def call_in_thread(self, spec: CallSpec, client: Any = None) -> Received:
        if not (reads_itself(spec) or spec.get("uncaptured") or "waitMs" in spec.data):
            return super().call_in_thread(spec, client)
        if "startAfterMs" in spec.data:
            threading.Event().wait(spec.data["startAfterMs"] / 1000)
        kwargs, conversation = self.prepare(spec)
        received = Received(kwargs, conversation)
        try:
            if "waitMs" in spec.data:
                outcome = self.wait_in_thread(spec, kwargs, client)
            else:
                outcome = self.send_in_thread(spec, kwargs, client)
            received.response, received.text = outcome
        except FutureTimeout:
            received.error = ServiceTimeout("the service's time limit fired")
        except Exception as error:
            received.error = error
        return received

    def send_in_thread(self, spec: CallSpec, kwargs: JsonObject, client: Any) -> tuple[Any, str]:
        api = self.api_of(spec)
        if spec.get("uncaptured"):
            return None, post_uncaptured(api, kwargs)
        if reads_itself(spec):
            return read_stream_sync(api, spec, kwargs, client, self.cut_signal)
        return send_sync(api, spec, kwargs, client)

    def wait_in_thread(self, spec: CallSpec, kwargs: JsonObject, client: Any) -> tuple[Any, str]:
        """`waitMs` on a synchronous client: `future.result(timeout=)` stops waiting and leaves
        the request running in its worker thread, which carries the trial context."""
        pool = ThreadPoolExecutor(max_workers=1)
        try:
            snapshot = contextvars.copy_context()
            future = pool.submit(snapshot.run, self.send_in_thread, spec, kwargs, client)
            return future.result(timeout=int(spec.data["waitMs"]) / 1000)
        finally:
            pool.shutdown(wait=False)

    async def call_awaited(self, spec: CallSpec, client: Any = None) -> Received:
        if not (reads_itself(spec) or spec.get("uncaptured")):
            return await super().call_awaited(spec, client)
        if "startAfterMs" in spec.data:
            await asyncio.sleep(spec.data["startAfterMs"] / 1000)
        kwargs, conversation = self.prepare(spec)
        received = Received(kwargs, conversation)
        if client is None and not spec.get("uncaptured"):
            client = self.client_for(spec, False)
        try:
            outcome = await self.limited(spec, self.sending(spec, kwargs, client))
            received.response, received.text = outcome
        except asyncio.TimeoutError:
            received.error = ServiceTimeout("the service's time limit fired")
        except Exception as error:
            received.error = error
        return received

    async def sending(self, spec: CallSpec, kwargs: JsonObject, client: Any) -> tuple[Any, str]:
        api = self.api_of(spec)
        if spec.get("uncaptured"):
            loop = asyncio.get_running_loop()
            return None, await loop.run_in_executor(None, post_uncaptured, api, kwargs)
        if reads_itself(spec):
            return await read_stream_async(api, spec, kwargs, client, self.cut_signal)
        return await send_async(api, self.backend, spec, kwargs, client)

    def clients_for(self, specs: list[CallSpec]) -> list[Any]:
        """The asynchronous clients of calls sent together, built before the first one starts,
        as `flow`'s `parallel` does, so `startAfterMs` delays only the send."""
        return [None if spec.get("uncaptured") else self.client_for(spec, False) for spec in specs]

    async def limited(self, spec: CallSpec, sending: Awaitable[tuple[Any, str]]) -> tuple[Any, str]:
        """The service's own time limits of `flow`: `limitMs` cuts, `waitMs` stops waiting."""
        if "limitMs" in spec.data:
            return await asyncio.wait_for(sending, spec.data["limitMs"] / 1000)
        if "waitMs" in spec.data:
            return await self.wait_without_cutting(sending, spec.data["waitMs"])
        return await sending

    async def step(self, step: JsonObject) -> None:
        if "guard" in step:
            await self.guard(step["guard"])
        elif "taskGroup" in step:
            py311 = importlib.import_module("py311_report")
            await py311.task_group(self, step)
        elif "poolWait" in step:
            await self.pool_wait(step)
        else:
            await super().step(step)

    async def guard(self, data: JsonObject) -> None:
        check = CallSpec(data["check"])
        answer = data["answer"]
        answers = [CallSpec(item) for item in (answer if isinstance(answer, list) else [answer])]
        alongside = [CallSpec(item) for item in data.get("alongside", [])]
        if self.sync:
            self.guard_in_threads(data, check, answers, alongside)
            return
        check_client, *answer_clients = self.clients_for([check, *answers])
        side_clients = self.clients_for(alongside)
        answer_task = asyncio.ensure_future(self.answer_in_turn(answers, answer_clients))
        side_tasks = [
            asyncio.ensure_future(self.call_awaited(spec, client))
            for spec, client in zip(alongside, side_clients, strict=True)
        ]
        checked = await self.call_awaited(check, check_client)
        blocked = checked.error is not None or str(data.get("blockText", "block")) in checked.text
        style = data.get("cut", "cancel")
        if not blocked:
            await answer_task
        elif style == "cancel":
            answer_task.cancel()
            await asyncio.gather(answer_task, return_exceptions=True)
        elif style == "break":
            self.cut_signal.set()
            await asyncio.gather(answer_task, return_exceptions=True)
            self.cut_signal.clear()
        for spec, task in zip(alongside, side_tasks, strict=True):
            self.finish(spec, await task)
        self.finish(check, checked)

    def guard_in_threads(
        self, data: JsonObject, check: CallSpec, answers: list[CallSpec], alongside: list[CallSpec]
    ) -> None:
        """A guard on a synchronous client: the answer requests in one thread and each
        `alongside` call in its own, all carrying the trial context, the check in this one. Cut
        styles are those a synchronous client has, `break` and `stopWaiting`."""
        style = data.get("cut", "cancel")
        if style == "cancel":
            raise ValueError("a synchronous guard takes `cut` break or stopWaiting")
        check_client = self.client_for(check, True)
        answer_clients = [self.client_for(spec, True) for spec in answers]
        side_clients = [self.client_for(spec, True) for spec in alongside]
        side_calls: list[Received | None] = [None] * len(alongside)
        errors: list[Exception] = []

        def answer_in_turn() -> None:
            try:
                for spec, client in zip(answers, answer_clients, strict=True):
                    self.finish(spec, self.call_in_thread(spec, client))
            except Exception as error:
                errors.append(error)

        def side(index: int) -> None:
            side_calls[index] = self.call_in_thread(alongside[index], side_clients[index])

        snapshot = contextvars.copy_context()
        worker = threading.Thread(target=snapshot.run, args=(answer_in_turn,), daemon=True)
        sides = [
            threading.Thread(target=contextvars.copy_context().run, args=(side, index))
            for index in range(len(alongside))
        ]
        worker.start()
        for thread in sides:
            thread.start()
        checked = self.call_in_thread(check, check_client)
        blocked = checked.error is not None or str(data.get("blockText", "block")) in checked.text
        if not blocked:
            worker.join()
            if errors:
                raise errors[0]
        elif style == "break":
            self.cut_signal.set()
            worker.join()
            self.cut_signal.clear()
        for index, (spec, thread) in enumerate(zip(alongside, sides, strict=True)):
            thread.join()
            received = side_calls[index]
            if received is not None:
                self.finish(spec, received)
        self.finish(check, checked)

    async def answer_in_turn(self, specs: list[CallSpec], clients: list[Any]) -> None:
        for spec, client in zip(specs, clients, strict=True):
            self.finish(spec, await self.call_awaited(spec, client))

    async def pool_wait(self, step: JsonObject) -> None:
        spec = CallSpec(step["poolWait"])
        with ThreadPoolExecutor() as pool:
            future = pool.submit(self.call_in_thread, spec)
            try:
                received = future.result(timeout=int(step["waitMs"]) / 1000)
            except FutureTimeout:
                for later in step.get("then", []):
                    await self.step(later)
                return
        self.finish(spec, received)

    # Reports

    def value(self, given: Any) -> Any:
        if isinstance(given, dict) and "callText" in given:
            return self.received[given["callText"]].text
        return given

    def report(self, report: JsonObject, returned: Any) -> Any:
        """What the target function gives: the flow's value, a `Result`, or a raised
        `ModelCallError`. The helper's names are looked up here, at report time."""
        if report.get("flow"):
            return returned
        if "result" in report:
            fields = report["result"]
            kwargs = {RESULT_FIELDS[key]: self.value(value) for key, value in fields.items()}
            fill = report.get("finalFromFlow", True)
            if fill and "final" not in kwargs and isinstance(returned, str):
                kwargs["final"] = returned
            return built("Result", kwargs)
        fields = dict(report["throw"])
        kwargs = {"message": DEFAULT_ERROR_MESSAGE}
        if "errorOf" in fields:
            call = self.select(fields.pop("errorOf"))
            kwargs.update(model=call.model, **call.error)
        if "call" in fields:
            kwargs["call"] = self.select(fields.pop("call"))
        kwargs.update({ERROR_FIELDS[key]: value for key, value in fields.items()})
        raise built("ModelCallError", kwargs)

    def select(self, selector: JsonObject) -> Any:
        """The call of the third argument the selector names."""
        matching = [call for call in self.run.calls if call_matches(call, selector)]
        index = int(selector.get("index", 0))
        if not -len(matching) <= index < len(matching):
            raise LookupError(f"no captured call {json.dumps(selector)} among {len(matching)}")
        return matching[index]


def built(name: str, kwargs: JsonObject) -> Any:
    """The helper's `Result` or `ModelCallError` built from the report's fields. A helper that
    lacks the name or its keyword arguments ends the adapter at once: an exception here would
    reach the helper's outcome decision as the service's own and could match an expectation."""
    helper = importlib.import_module("model_eval_adapter")
    try:
        return getattr(helper, name)(**kwargs)
    except (AttributeError, TypeError) as error:
        print(f"scenario service: cannot build {name}: {error!r}", file=sys.stderr, flush=True)
        os._exit(SETUP_ERROR_EXIT)


def call_matches(call: Any, selector: JsonObject) -> bool:
    if "model" in selector and call.model != selector["model"]:
        return False
    if "outcome" in selector and getattr(call, "outcome", None) != selector["outcome"]:
        return False
    if "failed" in selector and (getattr(call, "error", None) is not None) != selector["failed"]:
        return False
    if "retried" in selector and getattr(call, "retried", None) != selector["retried"]:
        return False
    if "systemIncludes" in selector:
        systems = [str(m.get("content", "")) for m in call.messages if m.get("role") == "system"]
        if not any(selector["systemIncludes"] in text for text in systems):
            return False
    return True


async def run_report(runner: ReportFlow) -> Any:
    """Runs a reporting flow's steps and gives what its target function gives: `report` after
    the steps, `onException` when they raised."""
    params = runner.run.params
    try:
        for step in params.get("steps", []):
            await runner.step(step)
        returned = runner.result(params.get("result"))
    except Exception as error:
        on_exception = params.get("onException")
        if on_exception is None:
            raise
        return runner.report(on_exception, error)
    report = params.get("report")
    return returned if report is None else runner.report(report, returned)


async def flow_report(run: Any) -> Any:
    return await run_report(ReportFlow(run))


BEHAVIOURS: dict[str, Callable[[Any], Awaitable[Any]]] = {
    "flow-report": flow_report,
    "task-group": flow_report,
}
