"""Targets whose `ModelCallError` reaches the helper inside an `ExceptionGroup` (Python 3.11), as
from an `asyncio.TaskGroup`: the group is the service's own exception, not a reported failure
(helper-api §`ModelCallError`). `discarded` lists `ExceptionGroup` in `discard_on`; `raised` does
not. Each target answers one model request first. `MODEL_EVAL_SCENARIO` gives the API."""

from __future__ import annotations

import json
import os
from typing import Any

from behaviours_steps import create_method, make_client, request_arguments, response_text

from model_eval_adapter import Adapter, ModelCallError

API = json.loads(os.environ["MODEL_EVAL_SCENARIO"])["api"]

adapter = Adapter(name="grouped-failure", version="0.0.1")


async def answer_then_group(model: str) -> str:
    client = make_client(API, "async", {})
    try:
        arguments = request_arguments(API, {"model": model}, model, "Say hello.")
        response_text(API, await create_method(client, API)(**arguments))
    finally:
        await client.close()
    failure = ModelCallError(message="The model call failed.", status=429)
    raise ExceptionGroup("check failed", [failure])


@adapter.target("discarded", languages=["en"], discard_on=(ExceptionGroup,))
async def discarded(case: Any, variant: Any) -> str:
    return await answer_then_group(variant.model)


@adapter.target("raised", languages=["en"])
async def raised(case: Any, variant: Any) -> str:
    return await answer_then_group(variant.model)


if __name__ == "__main__":
    adapter.run()
