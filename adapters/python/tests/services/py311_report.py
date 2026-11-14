"""The `taskGroup` step of the `task-group` behaviour (behaviours_report.py), which needs Python
3.11: the calls run as tasks of one `asyncio.TaskGroup`, so a call's exception cancels the
others, as a service that sends a safety check and the answer stream together does
(helper-api §Trials Stopped by Another Call's Failure, rule 2).

    {"taskGroup": [call, ...], "except": "raise" | "swallow"}

`raise` (default) lets the group's `ExceptionGroup` go on; `swallow` catches it with
`except* Exception` and the flow goes on to its `result`.
"""

from __future__ import annotations

import asyncio
from typing import Any

from behaviours_flow import CallSpec

JsonObject = dict[str, Any]


async def task_group(flow: Any, step: JsonObject) -> None:
    if flow.sync:
        raise ValueError("`taskGroup` needs an asynchronous backend")
    specs = [CallSpec(data) for data in step["taskGroup"]]
    calls = list(zip(specs, flow.clients_for(specs), strict=True))

    async def one(spec: CallSpec, client: Any) -> None:
        received = await flow.call_awaited(spec, client)
        flow.record(spec, received)
        if received.error is not None:
            raise received.error

    if step.get("except", "raise") == "swallow":
        try:
            async with asyncio.TaskGroup() as group:
                for spec, client in calls:
                    group.create_task(one(spec, client))
        except* Exception:
            pass
        return
    async with asyncio.TaskGroup() as group:
        for spec, client in calls:
            group.create_task(one(spec, client))
