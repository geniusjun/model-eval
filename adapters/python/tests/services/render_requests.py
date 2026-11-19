"""An adapter whose render functions send model requests or sleep (helper-api §Render Mode,
S-RV-24). `MODEL_EVAL_API` names the API the requests go to.

- `sends-sync` and `sends-async`: the render function sends one request to the variant model and
  one to `model-a`, synchronous or asynchronous, and returns a render result whose user message
  is the JSON of how each request ended (services/behaviours_render.py `error_note`), keys sorted
  and no spaces.
- `sleeps`: a synchronous render function that sleeps `SLEEP_S` before returning.

Every target function sends one request to the variant model and returns its text, so a
`generate` can run beside a render.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable
from typing import Any

from behaviours_render import error_note
from behaviours_steps import create_method, make_client, request_arguments, response_text

from model_eval_adapter import Adapter

API = os.environ["MODEL_EVAL_API"]
OTHER_MODEL = "model-a"
USER = "Probe."
SLEEP_S = 5.0
HELLO = {"role": "user", "content": "Hello."}

adapter = Adapter(name="render-requests", version="0.0.1", max_concurrency=2)


def arguments(model: str) -> dict[str, Any]:
    return request_arguments(API, {"model": model}, model, USER)


def report(notes: list[dict[str, Any]]) -> dict[str, Any]:
    text = json.dumps(notes, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return {
        "messages": [{"role": "system", "content": "Report."}, {"role": "user", "content": text}]
    }


def sends_sync(case: Any, variant: Any) -> dict[str, Any]:
    client = make_client(API, "sync", {})
    notes = []
    for model in (variant.model, OTHER_MODEL):
        try:
            create_method(client, API)(**arguments(model))
            notes.append({"model": model, "status": 200})
        except Exception as error:
            notes.append(error_note(model, error))
    client.close()
    return report(notes)


async def sends_async(case: Any, variant: Any) -> dict[str, Any]:
    client = make_client(API, "async", {})
    notes = []
    for model in (variant.model, OTHER_MODEL):
        try:
            await create_method(client, API)(**arguments(model))
            notes.append({"model": model, "status": 200})
        except Exception as error:
            notes.append(error_note(model, error))
    await client.close()
    return report(notes)


def sleeps(case: Any, variant: Any) -> dict[str, Any]:
    time.sleep(SLEEP_S)
    return {"messages": [HELLO]}


async def answer(case: Any, variant: Any) -> str:
    client = make_client(API, "async", {})
    try:
        return response_text(API, await create_method(client, API)(**arguments(variant.model)))
    finally:
        await client.close()


RENDER_FUNCTIONS: dict[str, Callable[[Any, Any], Any]] = {
    "sends-sync": sends_sync,
    "sends-async": sends_async,
    "sleeps": sleeps,
}

for name, render in RENDER_FUNCTIONS.items():
    adapter.target(name, languages=["en"], render=render)(answer)


if __name__ == "__main__":
    adapter.run()
