"""Targets whose own code raises where the helper calls it: `reply_call`, a `discard_on`
function, or the target function raising `asyncio.CancelledError` itself. Each target makes one
model request, so the trial has a captured call; `reply-call-unfinished` leaves it running when
it returns. `MODEL_EVAL_SCENARIO` gives the API as for
the scenario service."""

from __future__ import annotations

import asyncio
import importlib
import json
import os
from typing import Any

from model_eval_adapter import Adapter

API = json.loads(os.environ["MODEL_EVAL_SCENARIO"])["api"]


class ServiceError(Exception):
    """The service's own exception, which `discard_on` is asked about."""


async def one_request(model: str) -> None:
    sdk = importlib.import_module("anthropic" if API == "messages" else "openai")
    client = (sdk.AsyncAnthropic if API == "messages" else sdk.AsyncOpenAI)(max_retries=0)
    messages = [{"role": "user", "content": "Say hello."}]
    if API == "chat-completions":
        await client.chat.completions.create(model=model, messages=messages)
    elif API == "responses":
        await client.responses.create(model=model, input=messages)
    else:
        await client.messages.create(model=model, messages=messages, max_tokens=64)
    await client.close()


def broken_reply_call(call: Any) -> bool:
    raise ValueError("reply_call is broken")


def broken_discard_on(error: BaseException) -> bool:
    raise ValueError("discard_on is broken")


adapter = Adapter(name="raising-targets", version="0.0.1")
# Requests left running when a target function returns, held so they are not collected early.
BACKGROUND: set[asyncio.Future[None]] = set()


@adapter.target("reply-call", reply_call=broken_reply_call)
async def reply_call_raises(case: Any, variant: Any) -> str:
    await one_request(variant.model)
    return "Hello."


@adapter.target("reply-call-unfinished", reply_call=broken_reply_call)
async def reply_call_raises_with_a_call_running(case: Any, variant: Any) -> str:
    # The request is still running when the function returns; it is not awaited here. The SDK
    # is imported first, so the request leaves before the function returns.
    importlib.import_module("anthropic" if API == "messages" else "openai")
    BACKGROUND.add(asyncio.ensure_future(one_request(variant.model)))
    await asyncio.sleep(0.2)
    return "Hello."


@adapter.target("reply-call-cancelled", reply_call=broken_reply_call)
async def reply_call_raises_after_a_cancel(case: Any, variant: Any) -> str:
    # The first request's failure (a 401 in the test) is swallowed; the tool cancels the trial
    # while the second request waits.
    try:
        await one_request(variant.model)
    except Exception:
        pass
    await one_request(variant.model)
    return "Hello."


@adapter.target("discard-on", discard_on=broken_discard_on)
async def discard_on_raises(case: Any, variant: Any) -> str:
    await one_request(variant.model)
    raise ServiceError("rejected")


@adapter.target("cancelled")
async def raises_cancelled(case: Any, variant: Any) -> str:
    await one_request(variant.model)
    raise asyncio.CancelledError


if __name__ == "__main__":
    adapter.run()
