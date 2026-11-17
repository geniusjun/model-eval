"""The `returns` behaviour of the scenario service (services/scenario.py): the steps of the
`flow` behaviour, then a return value that is not text (helper-api §Return Values).

    {"steps": [step, ...], "value": "none" | "fallback-number" | "coroutine"}

- `none`: the function returns None, as one with a missing `return` does.
- `fallback-number`: it returns `fallback(123)`, a fallback of a value that is not text.
- `coroutine`: the function returns, unawaited, the coroutine of an asynchronous service
  function that makes one model request and returns its text, so the helper awaits it; with the
  `sync` backend the target function is synchronous.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from behaviours_flow import CallSpec, Conversation, Flow, request_kwargs, send_async

from model_eval_adapter import fallback


async def answer(run: Any) -> str:
    """An asynchronous service function: one request through an asynchronous client."""
    spec = CallSpec({})
    conversation = Conversation("You are a helpful assistant.")
    conversation.items.append({"role": "user", "content": "Say hello."})
    kwargs = request_kwargs(run.api, conversation, spec, run.variant.model)
    _, text = await send_async(run.api, "async", spec, kwargs)
    return text


async def returns(run: Any) -> Any:
    runner = Flow(run)
    for step in run.params.get("steps", []):
        await runner.step(step)
    if run.params["value"] == "coroutine":
        return answer(run)
    if run.params["value"] == "fallback-number":
        return fallback(123)  # type: ignore[arg-type]
    return None


BEHAVIOURS: dict[str, Callable[[Any], Awaitable[Any]]] = {"returns": returns}
