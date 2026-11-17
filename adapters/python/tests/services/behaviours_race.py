"""The `race-report` behaviour: `flow-report` (behaviours_report.py) with one more step, for
services on the synchronous client that send the same request several ways and take the first
answer, as `parallel` with `wait: first` does on the asynchronous backends:

- `{"race": [call, ...]}`: the requests sent together from pool threads, each with a copy of
  the trial context. The service takes the first that succeeds (`concurrent.futures.wait` with
  `FIRST_COMPLETED`) and stops waiting for the rest, which keep running in their threads: a
  synchronous client cannot cancel a read that another thread awaits.
"""

from __future__ import annotations

import contextvars
from collections.abc import Awaitable, Callable
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from typing import Any

from behaviours_flow import CallSpec, Received
from behaviours_report import ReportFlow, run_report

JsonObject = dict[str, Any]


class RaceFlow(ReportFlow):
    async def step(self, step: JsonObject) -> None:
        if "race" in step:
            self.race([CallSpec(data) for data in step["race"]])
        else:
            await super().step(step)

    def race(self, specs: list[CallSpec]) -> None:
        if not self.sync:
            raise ValueError("`race` is for the synchronous client; use `parallel` with `first`")
        # Clients are built first so that `startAfterMs` delays only the send, as in `parallel`.
        clients = [self.client_for(spec, True) for spec in specs]
        pool = ThreadPoolExecutor(max_workers=len(specs))
        futures: dict[Future[Received], CallSpec] = {
            pool.submit(contextvars.copy_context().run, self.call_in_thread, spec, client): spec
            for spec, client in zip(specs, clients, strict=True)
        }
        pending = set(futures)
        first: Received | None = None
        failed: list[tuple[CallSpec, Received]] = []
        while pending and first is None:
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                spec, received = futures[future], future.result()
                self.record(spec, received)
                if received.error is None:
                    first = first or received
                else:
                    failed.append((spec, received))
        pool.shutdown(wait=False)
        if first is None:
            self.finish(*failed[0])


async def race_report(run: Any) -> Any:
    return await run_report(RaceFlow(run))


BEHAVIOURS: dict[str, Callable[[Any], Awaitable[Any]]] = {"race-report": race_report}
