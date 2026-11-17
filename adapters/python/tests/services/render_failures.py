"""An adapter whose targets each have a render function that fails one way, for the render
function rules of helper-api §Render Mode (S-RV-22, S-RV-23): one that raises, synchronous and
asynchronous, and ones that return a value that is not a render result. `smallest` returns the
smallest render result: one message, an empty `tools` list and `maxOutputTokens` 1, and
`none-as-absent` gives `tools` and `maxOutputTokens` as None, which count as not given. No target
function calls a model."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

from model_eval_adapter import Adapter

adapter = Adapter(name="render-failures", version="0.0.1")


class RenderError(Exception):
    """The exception the raising render functions raise."""


def raises_sync(case: Any, variant: Any) -> Any:
    raise RenderError("no template for this case")


async def raises_async(case: Any, variant: Any) -> Any:
    raise RenderError("no template for this case")


async def cancels_async(case: Any, variant: Any) -> Any:
    raise asyncio.CancelledError


HELLO = {"role": "user", "content": "Hello."}


def returning(value: Any) -> Callable[[Any, Any], Any]:
    return lambda case, variant: value


RENDER_FUNCTIONS: dict[str, Callable[[Any, Any], Any]] = {
    "raises-sync": raises_sync,
    "raises-async": raises_async,
    "cancels-async": cancels_async,
    "returns-none": returning(None),
    "returns-string": returning("Hello."),
    "returns-list": returning([{"role": "user", "content": "Hello."}]),
    "no-messages": returning({"tools": []}),
    "messages-string": returning({"messages": "Hello."}),
    "messages-string-element": returning({"messages": ["Hello."]}),
    "empty-messages": returning({"messages": []}),
    "message-without-role": returning({"messages": [{"content": "Hello."}]}),
    "tools-dict": returning({"messages": [HELLO], "tools": {"name": "lookup"}}),
    "max-output-tokens-0": returning({"messages": [HELLO], "maxOutputTokens": 0}),
    "max-output-tokens-string": returning({"messages": [HELLO], "maxOutputTokens": "100"}),
    "tools-object": returning({"messages": [HELLO], "tools": [object()]}),
    "tools-nan": returning({"messages": [HELLO], "tools": [{"name": "lookup", "x": float("nan")}]}),
    "part-object": returning(
        {
            "messages": [
                {"role": "user", "content": [{"type": "input_image", "image_url": object()}]}
            ]
        }
    ),
    # Python integers have no size limit; JSON numbers are doubles (001 data-model §Canonical JSON).
    "max-output-tokens-huge": returning({"messages": [HELLO], "maxOutputTokens": 10**400}),
    "smallest": returning({"messages": [HELLO], "tools": [], "maxOutputTokens": 1}),
    "none-as-absent": returning({"messages": [HELLO], "tools": None, "maxOutputTokens": None}),
}


async def target(case: Any, variant: Any) -> str:
    return "Hello."


for name, render in RENDER_FUNCTIONS.items():
    adapter.target(name, languages=["en"], render=render)(target)


if __name__ == "__main__":
    adapter.run()
