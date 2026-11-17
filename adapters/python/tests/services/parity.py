"""Parity driver: the Python half of test/contract/helper/parity.test.ts, which runs the same
trials through services/parity.mjs and compares the values of spec FR-024 byte for byte
(helper-scenarios §Two-Language Parity). Every target sends Chat Completions requests through the
OpenAI SDK without retries; the trial's `case.input` carries the vector.

- `reply`: one request; returns its text (S-PAR-01).
- `discard`: one request, then raises an exception of class `exceptionName` with `message`, which
  `discard_on` takes (S-PAR-02).
- `answer-tool`: one request with the tool `reply`, whose argument `text` is the answer
  (`answer_tool`); returns a fixed text (S-PAR-03 to S-PAR-06).
- `retry`: one request, whose 429 response carries the vector's headers, read at the clock time
  `nowMs` (S-PAR-09, S-PAR-10, S-PAR-12).
- `throw-model-call-error`: raises `ModelCallError` with status 429 and `retryAfter` as its
  `retry_after_ms`, the text `nan` standing for NaN (S-PAR-11).

The clock the helper reads (`time.time`) is the trial's `nowMs` while that trial runs.
"""

from __future__ import annotations

import importlib
import json
import os
import time
from typing import Any

import model_eval_adapter as helper
from model_eval_adapter import Adapter

API = json.loads(os.environ.get("MODEL_EVAL_SCENARIO", "{}")).get("api", "chat-completions")
USER = {"role": "user", "content": "Say hello."}
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "reply",
            "parameters": {"type": "object", "properties": {"text": {"type": "string"}}},
        },
    }
]
REAL_TIME = time.time
CLOCK: dict[str, float | None] = {"now_ms": None}


def clock() -> float:
    now_ms = CLOCK["now_ms"]
    return REAL_TIME() if now_ms is None else now_ms / 1000


time.time = clock

adapter = Adapter(name="parity", version="0.0.1")


async def ask(model: str, **extra: Any) -> str:
    # The SDK is imported here, inside the service, after the helper.
    openai = importlib.import_module("openai")
    client = openai.AsyncOpenAI(max_retries=0)
    try:
        response = await client.chat.completions.create(model=model, messages=[USER], **extra)
        return response.choices[0].message.content or ""
    finally:
        await client.close()


@adapter.target("reply", languages=["en"])
async def reply(case: Any, variant: Any) -> str:
    return await ask(variant.model)


@adapter.target("discard", languages=["en"], discard_on=lambda error: True)
async def discard(case: Any, variant: Any) -> str:
    await ask(variant.model)
    raise type(str(case.input["exceptionName"]), (Exception,), {})(case.input["message"])


@adapter.target("answer-tool", languages=["en"], answer_tool=("reply", "text"))
async def answer_tool(case: Any, variant: Any) -> str:
    await ask(variant.model, tools=TOOLS)
    return "Shipped."


@adapter.target("retry", languages=["en"])
async def retry(case: Any, variant: Any) -> str:
    CLOCK["now_ms"] = float(case.input["nowMs"])
    return await ask(variant.model)


@adapter.target("throw-model-call-error", languages=["en"])
async def throw_model_call_error(case: Any, variant: Any) -> str:
    given = case.input["retryAfter"]
    raise helper.ModelCallError(
        message="rate limited",
        status=429,
        retry_after_ms=float("nan") if given == "nan" else given,
        usage={"input": 0, "output": 0},
    )


if __name__ == "__main__":
    adapter.run()
