"""The `stream-report` behaviour: the `flow-report` of behaviours_report.py, whose target
function reports as a `Result` or a `ModelCallError`, with streams the service cuts in the styles
of data-model §Cut Streams. The Node scenario services read the same parameters.

    {"steps": [...], "result": result, "report": report, "onException": report}

`steps`, `result`, `report` and `onException` are those of `flow-report`. Every streamed call
other than `uncaptured` and `streamingResponse` ones is read here: it keeps the text and tool
calls it received when it fails or is cut, and also takes:

- `cut`: `{"at": at, "style": style}`, where the service stops reading the stream.
  - `at`: `{"text": s}` once the received text contains `s` (a content check or a configured
    stop string); `{"ms": n}` once n ms passed since the request was sent (the service's time
    limit); `{"event": type}` at the first event of that type, or `{"event": "finish"}` at the
    event that carries the finish reason (Chat Completions `finish_reason`, Anthropic
    `message_delta`, a Responses end event).
  - `style`: `break` leaves the read loop; `close` closes the stream, then leaves; `cancel`
    (asynchronous backends) cancels the read the service is awaiting; `stop-waiting` stops
    waiting and leaves the read running: an `asyncio.wait` without cancelling, or with the
    synchronous client `future.result(timeout=)` on a pool thread. With `ms`, `break` and
    `close` act at the first event after the deadline.
  - The text kept is what was received up to and including the event where the cut happens.
- `processMs`: an awaited pause after each event (asynchronous backends), the service's work on
  each chunk, so a time limit (`limitMs`) can fire while no read is awaited.
- `streamHelper`: true reads a Chat Completions stream through the SDK's stream helper
  (`client.chat.completions.stream()`), whose text comes from its `content.delta` events and
  whose `content.done` event `{"event": "content.done"}` names.

One more step: `{"closeStream": name}` closes the stream of that earlier call.
"""

from __future__ import annotations

import asyncio
import contextvars
import threading
import time
from collections.abc import Awaitable, Callable
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass, field
from typing import Any

from behaviours_flow import (
    RESPONSES_END_EVENTS,
    CallSpec,
    Received,
    ServiceTimeout,
    async_client,
    resource,
    sync_client,
)
from behaviours_report import ReportFlow, StreamAnswer, run_report

JsonObject = dict[str, Any]

HELPER_TEXT_EVENT = "content.delta"


# --- What a stream gave the service -------------------------------------------------------------


class CutStream:
    """The text and tool calls of one stream as the service took them, up to its cut."""

    def __init__(self, api: str, helper: bool) -> None:
        self.answer = StreamAnswer(api)
        self.helper = helper
        self.cut = False
        self.stream: Any = None

    @property
    def text(self) -> str:
        return self.answer.text

    def add(self, event: Any) -> None:
        if self.cut:
            return
        if not self.helper:
            self.answer.add(event)
        elif getattr(event, "type", "") == HELPER_TEXT_EVENT:
            self.answer.pieces.append(str(event.delta))

    def result(self) -> tuple[Any, str]:
        """The response `after` continues a tool loop from, and the text."""
        return (None if self.helper else self.answer.response()), self.text


def finish_event(api: str, event: Any) -> bool:
    """Whether the event carries the finish reason of the answer."""
    kind = getattr(event, "type", "")
    if api == "chat-completions":
        choices = getattr(event, "choices", None) or []
        return any(choice.finish_reason is not None for choice in choices)
    if api == "responses":
        return kind in RESPONSES_END_EVENTS
    return kind == "message_delta"


@dataclass
class Cut:
    """Where and how the service stops reading a stream (`cut`)."""

    at: JsonObject
    style: str
    started: float = field(default_factory=time.monotonic)

    @property
    def outside(self) -> bool:
        """Whether other work cuts the read loop while it waits (`cancel`, `stop-waiting`)."""
        return self.style in ("cancel", "stop-waiting")

    def reached(self, api: str, taken: CutStream, event: Any) -> bool:
        if "text" in self.at:
            return str(self.at["text"]) in taken.text
        if "ms" in self.at:
            return self.elapsed_ms() >= float(self.at["ms"])
        wanted = str(self.at["event"])
        if wanted == "finish":
            return finish_event(api, event)
        return getattr(event, "type", "") == wanted

    def elapsed_ms(self) -> float:
        return (time.monotonic() - self.started) * 1000

    def remaining_s(self) -> float | None:
        if "ms" not in self.at:
            return None
        return max(0.0, (float(self.at["ms"]) - self.elapsed_ms()) / 1000)


def cut_of(spec: CallSpec) -> Cut | None:
    data = spec.get("cut")
    if data is None:
        return None
    return Cut(dict(data["at"]), str(data["style"]))


# --- Running the flow -----------------------------------------------------------------------


class StreamReportFlow(ReportFlow):
    """A `flow-report` that reads and cuts its streams itself."""

    def __init__(self, run: Any) -> None:
        super().__init__(run)
        self.taken: dict[str, CutStream] = {}
        self.readers: set[asyncio.Future[None]] = set()

    @staticmethod
    def cut_here(spec: CallSpec) -> bool:
        others = ("uncaptured", "streamingResponse", "closeAfterMs")
        return bool(spec.get("stream")) and not any(key in spec.data for key in others)

    @staticmethod
    def stream_kwargs(spec: CallSpec, kwargs: JsonObject) -> JsonObject:
        """The stream helper takes the request without `stream`."""
        if spec.get("streamHelper"):
            return {key: value for key, value in kwargs.items() if key != "stream"}
        return kwargs

    def keep(self, spec: CallSpec, received: Received, taken: CutStream) -> Received:
        if spec.name is not None:
            self.taken[spec.name] = taken
        received.response, received.text = taken.result()
        return received

    # Synchronous streams

    def call_in_thread(self, spec: CallSpec, client: Any = None) -> Received:
        if not self.cut_here(spec):
            return super().call_in_thread(spec, client)
        cut = cut_of(spec)
        if cut is not None and cut.style == "cancel":
            raise ValueError("cut style cancel needs an asynchronous backend")
        if "startAfterMs" in spec.data:
            threading.Event().wait(spec.data["startAfterMs"] / 1000)
        api = self.api_of(spec)
        kwargs, conversation = self.prepare(spec)
        received = Received(kwargs, conversation)
        taken = CutStream(api, bool(spec.get("streamHelper")))
        if cut is not None:
            cut.started = time.monotonic()
        if client is None:
            client = sync_client(api, spec)
        reached = threading.Event()

        def consume() -> None:
            try:
                if spec.get("streamHelper"):
                    helper = client.chat.completions.stream(**self.stream_kwargs(spec, kwargs))
                    with helper as stream:
                        self.read_sync(api, stream, taken, cut, reached)
                else:
                    self.read_sync(api, resource(client, api).create(**kwargs), taken, cut, reached)
            finally:
                reached.set()

        try:
            if cut is None or not cut.outside:
                consume()
            else:
                self.stop_waiting_sync(consume, taken, cut, reached)
        except Exception as error:
            received.error = error
        return self.keep(spec, received, taken)

    @staticmethod
    def read_sync(
        api: str, stream: Any, taken: CutStream, cut: Cut | None, reached: threading.Event
    ) -> None:
        """As `read_async`, for the synchronous client."""
        taken.stream = stream
        for event in stream:
            taken.add(event)
            if cut is not None and not reached.is_set() and cut.reached(api, taken, event):
                taken.cut = True
                if cut.outside:
                    reached.set()
                    continue
                if cut.style == "close":
                    stream.close()
                return

    @staticmethod
    def stop_waiting_sync(
        consume: Callable[[], None], taken: CutStream, cut: Cut, reached: threading.Event
    ) -> None:
        """The request and its read loop run in a pool thread with the trial context, and the
        service waits with `future.result(timeout=)` until the cut point; then it stops waiting
        and leaves the thread reading."""
        pool = ThreadPoolExecutor(max_workers=1)
        future = pool.submit(contextvars.copy_context().run, consume)
        pool.shutdown(wait=False)
        reached.wait(cut.remaining_s())
        try:
            future.result(timeout=0)
        except FutureTimeout:
            taken.cut = True

    # Asynchronous streams

    async def call_awaited(self, spec: CallSpec, client: Any = None) -> Received:
        if not self.cut_here(spec):
            return await super().call_awaited(spec, client)
        if "startAfterMs" in spec.data:
            await asyncio.sleep(spec.data["startAfterMs"] / 1000)
        api = self.api_of(spec)
        kwargs, conversation = self.prepare(spec)
        received = Received(kwargs, conversation)
        taken = CutStream(api, bool(spec.get("streamHelper")))
        if client is None:
            client = async_client(api, self.backend, spec, self.shared)
        sending = self.send_stream(api, spec, kwargs, client, taken)
        try:
            if "limitMs" in spec.data:
                await asyncio.wait_for(sending, spec.data["limitMs"] / 1000)
            elif "waitMs" in spec.data:
                await self.wait_without_cutting(sending, spec.data["waitMs"])
            else:
                await sending
        except asyncio.TimeoutError:
            received.error = ServiceTimeout("the service's time limit fired")
        except Exception as error:
            received.error = error
        return self.keep(spec, received, taken)

    async def send_stream(
        self, api: str, spec: CallSpec, kwargs: JsonObject, client: Any, taken: CutStream
    ) -> tuple[Any, str]:
        cut = cut_of(spec)
        if cut is not None:
            cut.started = time.monotonic()
        reached = asyncio.Event()

        async def consume() -> None:
            if spec.get("streamHelper"):
                helper = client.chat.completions.stream(**self.stream_kwargs(spec, kwargs))
                async with helper as stream:
                    await self.read_async(api, spec, stream, taken, cut, reached)
                return
            stream = await resource(client, api).create(**kwargs)
            await self.read_async(api, spec, stream, taken, cut, reached)

        if cut is None or not cut.outside:
            await consume()
        else:
            await self.cut_from_outside(consume(), taken, cut, reached)
        return taken.result()

    @staticmethod
    async def read_async(
        api: str,
        spec: CallSpec,
        stream: Any,
        taken: CutStream,
        cut: Cut | None,
        reached: asyncio.Event,
    ) -> None:
        """Reads the stream. At the cut point the `break` and `close` styles leave the loop; the
        other styles signal `reached` and read on until the service cuts from outside."""
        taken.stream = stream
        pause_s = float(spec.get("processMs", 0)) / 1000
        async for event in stream:
            taken.add(event)
            if cut is not None and not reached.is_set() and cut.reached(api, taken, event):
                taken.cut = True
                if cut.outside:
                    reached.set()
                    continue
                if cut.style == "close":
                    await stream.close()
                return
            if pause_s:
                await asyncio.sleep(pause_s)

    async def cut_from_outside(
        self, consume: Awaitable[None], taken: CutStream, cut: Cut, reached: asyncio.Event
    ) -> None:
        """The request and its read loop run as their own task. At the cut point the service
        cancels that task, which is then awaiting the next read, or stops waiting for it."""
        reader = asyncio.ensure_future(consume)
        waiter = asyncio.ensure_future(reached.wait())
        await asyncio.wait(
            {reader, waiter}, timeout=cut.remaining_s(), return_when=asyncio.FIRST_COMPLETED
        )
        waiter.cancel()
        if reader.done():
            reader.result()
            return
        taken.cut = True
        if cut.style == "cancel":
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
            return
        # Held until it ends, so the loop does not collect the task the service left reading.
        self.readers.add(reader)
        reader.add_done_callback(self.readers.discard)

    # Steps

    async def parallel(self, specs: list[CallSpec], wait_for: str) -> None:
        """`wait: first` with the synchronous client: the calls run on pool threads, the
        service takes the first that succeeds with `concurrent.futures.wait` and stops waiting
        for the others, which go on reading."""
        if not (self.sync and wait_for == "first"):
            await super().parallel(specs, wait_for)
            return
        clients = [self.client_for(spec, True) for spec in specs]
        pool = ThreadPoolExecutor(max_workers=len(specs))
        futures = [
            pool.submit(contextvars.copy_context().run, self.call_in_thread, spec, client)
            for spec, client in zip(specs, clients, strict=True)
        ]
        pool.shutdown(wait=False)
        pending: set[Future[Received]] = set(futures)
        winner: Future[Received] | None = None
        while pending and winner is None:
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            winner = next((future for future in done if future.result().error is None), None)
        for spec, future in zip(specs, futures, strict=True):
            if future.done():
                self.record(spec, future.result())
        if winner is None:
            self.finish(specs[0], futures[0].result())

    async def step(self, step: JsonObject) -> None:
        if "closeStream" not in step:
            await super().step(step)
            return
        stream = self.taken[str(step["closeStream"])].stream
        if self.sync:
            stream.close()
        else:
            await stream.close()


async def stream_report(run: Any) -> Any:
    return await run_report(StreamReportFlow(run))


BEHAVIOURS: dict[str, Callable[[Any], Awaitable[Any]]] = {"stream-report": stream_report}
