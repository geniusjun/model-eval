"""One chat turn: assemble the prompt, ask the model, clean up the answer."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from typing import Any

from openai import AsyncOpenAI

from .prompts import build_messages

DEFAULT_BASE_URL = "http://127.0.0.1:8787/v1"
DEFAULT_API_KEY = "example-key"
MAX_OUTPUT_TOKENS = 256

client = AsyncOpenAI(
    base_url=os.environ.get("OPENAI_BASE_URL") or DEFAULT_BASE_URL,
    api_key=os.environ.get("OPENAI_API_KEY") or DEFAULT_API_KEY,
)


def postprocess(text: str) -> str:
    """Collapses runs of spaces."""
    return re.sub(r" {2,}", " ", text).strip()


async def reply(lang: str, turn: Mapping[str, Any], model: str) -> str:
    """Pogo's answer to one user message in `turn`, with the app state it carries."""
    completion = await client.chat.completions.create(
        model=model,
        messages=build_messages(lang, turn),
        max_completion_tokens=MAX_OUTPUT_TOKENS,
    )
    return postprocess(completion.choices[0].message.content or "")
