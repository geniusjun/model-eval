"""A service that reads a `with_streaming_response` body which the server drops mid-body
(S-CONN-22). It reports the exception it received, so that the SDK's resends and that exception
can be compared with and without the helper:

    MODEL_EVAL_WITHOUT_HELPER=1 python capture_streaming_drop.py   # prints the report as JSON
    python capture_streaming_drop.py                                # an adapter with the helper

With the helper the report is also printed, so it reaches stderr through the helper's stdout
protection. `MODEL_EVAL_SCENARIO` gives the API as for the scenario service.
"""

from __future__ import annotations

import importlib
import json
import os
from typing import Any

WITHOUT_HELPER = os.environ.get("MODEL_EVAL_WITHOUT_HELPER") == "1"
if not WITHOUT_HELPER:
    from model_eval_adapter import Adapter

API = json.loads(os.environ["MODEL_EVAL_SCENARIO"])["api"]
MAX_RETRIES = 2


def request(model: str) -> dict[str, Any]:
    messages = [{"role": "user", "content": "Say hello."}]
    if API == "chat-completions":
        return {"model": model, "messages": messages}
    if API == "responses":
        return {"model": model, "input": messages}
    return {"model": model, "messages": messages, "max_tokens": 64}


def report(model: str) -> str:
    """`<exception class>: <message>` of what the service got, or `read <n> bytes`."""
    sdk = importlib.import_module("anthropic" if API == "messages" else "openai")
    client = (sdk.Anthropic if API == "messages" else sdk.OpenAI)(max_retries=MAX_RETRIES)
    resource = {
        "chat-completions": lambda: client.chat.completions,
        "responses": lambda: client.responses,
        "messages": lambda: client.messages,
    }[API]()
    try:
        with resource.with_streaming_response.create(**request(model)) as response:
            body = response.read()
    except Exception as error:
        return f"{type(error).__name__}: {error}"
    return f"read {len(body)} bytes"


if WITHOUT_HELPER:
    print(json.dumps({"report": report("model-b")}))
else:
    adapter = Adapter(name="streaming-drop", version="0.0.1")

    @adapter.target("chat")
    def chat(case: Any, variant: Any) -> str:
        text = report(variant.model)
        print(json.dumps({"report": text}), flush=True)
        return text

    if __name__ == "__main__":
        adapter.run()
