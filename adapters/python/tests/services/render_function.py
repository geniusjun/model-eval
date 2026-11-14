"""An adapter whose target `chat` has a render function that builds the render result from its
`(case, variant)` arguments and returns tool definitions, and no post-processing; its target
function calls no model, so a render result can come only from the render function. The user
message is the JSON of the arguments' fields, keys sorted and no spaces. The target `plain` has
neither render mode nor `postprocess=False` (S-RESP-15)."""

from __future__ import annotations

import json
from typing import Any

from model_eval_adapter import Adapter

CASE_FIELDS = ("id", "lang", "input", "repeat", "seed")
VARIANT_FIELDS = ("id", "model", "params")
TOOLS = [
    {
        "type": "function",
        "function": {"name": "lookup", "parameters": {"type": "object", "properties": {}}},
    }
]

adapter = Adapter(name="render-function", version="0.0.1")


def arguments_text(case: Any, variant: Any) -> str:
    fields = {
        "case": {name: getattr(case, name) for name in CASE_FIELDS},
        "variant": {name: getattr(variant, name) for name in VARIANT_FIELDS},
    }
    return json.dumps(fields, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def render_chat(case: Any, variant: Any) -> dict[str, Any]:
    return {
        "messages": [
            {"role": "system", "content": "Answer the user."},
            {"role": "user", "content": arguments_text(case, variant)},
        ],
        "tools": TOOLS,
        "maxOutputTokens": 32,
    }


@adapter.target("chat", languages=["en"], render=render_chat, postprocess=False)
def chat(case: Any, variant: Any) -> str:
    return "Hello."


@adapter.target("plain", languages=["en"])
def plain(case: Any, variant: Any) -> str:
    return "Hello."


if __name__ == "__main__":
    adapter.run()
