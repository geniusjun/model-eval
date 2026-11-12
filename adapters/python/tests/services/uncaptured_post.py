"""A model request sent with the standard library's `urllib`, outside every transport the helper
captures: in the adapter process (the `flow` step `uncaptured`) or from a child process, like an
SDK that calls the model from a process of its own (`child`):

    python uncaptured_post.py <api> <request body as JSON>

prints the answer text.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from typing import Any

PATHS = {"chat-completions": "/chat/completions", "responses": "/responses"}


def post(api: str, body: dict[str, Any]) -> str:
    """Sends the request to the base URL of the API's SDK and returns the answer text."""
    if api == "messages":
        url = os.environ["ANTHROPIC_BASE_URL"].rstrip("/") + "/v1/messages"
        headers = {"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01"}
    else:
        url = os.environ["OPENAI_BASE_URL"].rstrip("/") + PATHS[api]
        headers = {"authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"}
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={**headers, "content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return answer_text(api, json.loads(response.read()))


def answer_text(api: str, body: dict[str, Any]) -> str:
    if api == "chat-completions":
        return str(body["choices"][0]["message"].get("content") or "")
    if api == "responses":
        return "".join(
            part.get("text", "")
            for item in body.get("output", [])
            if item.get("type") == "message"
            for part in item.get("content", [])
        )
    return "".join(block.get("text", "") for block in body["content"] if block["type"] == "text")


if __name__ == "__main__":
    print(post(sys.argv[1], json.loads(sys.argv[2])))
