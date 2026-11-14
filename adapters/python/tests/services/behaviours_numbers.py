"""The `flow-report-numbers` behaviour: `flow-report` (behaviours_report.py) with report values
that JSON cannot hold. In the `throw` fields of `report` and `onException`, a value
`{"number": "NaN" | "Infinity" | "-Infinity"}` becomes that float, so a fixture can throw
`ModelCallError(retry_after_ms=float("nan"))` (helper-scenarios S-PAR-11)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

import behaviours_report

JsonObject = dict[str, Any]

NON_FINITE = {"NaN": float("nan"), "Infinity": float("inf"), "-Infinity": float("-inf")}


def number(value: Any) -> Any:
    if isinstance(value, dict) and set(value) == {"number"}:
        return NON_FINITE[value["number"]]
    return value


def with_numbers(report: JsonObject) -> JsonObject:
    if "throw" not in report:
        return report
    return {**report, "throw": {key: number(value) for key, value in report["throw"].items()}}


async def flow_report_numbers(run: Any) -> Any:
    for key in ("report", "onException"):
        if key in run.params:
            run.params = {**run.params, key: with_numbers(run.params[key])}
    return await behaviours_report.flow_report(run)


BEHAVIOURS: dict[str, Callable[[Any], Awaitable[Any]]] = {
    "flow-report-numbers": flow_report_numbers
}
