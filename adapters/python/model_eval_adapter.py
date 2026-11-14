"""model-eval adapter helper for Python services.

One file, standard library only. Copy it next to the adapter (`model-eval init --adapter python`)
and import it before the service. Contract: specs/003-adapter-helpers/contracts/helper-api.md.
"""

from __future__ import annotations

import asyncio
import calendar
import codecs
import contextvars
import errno
import functools
import hashlib
import importlib.abc
import importlib.machinery
import inspect
import json
import math
import os
import re
import select
import socket
import ssl
import stat
import subprocess
import sys
import threading
import time
import traceback
import weakref
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from types import ModuleType
from typing import Any, TypeAlias

HELPER_VERSION = "0.1.0"
PROTOCOL_VERSION = "1"

JsonValue: TypeAlias = "None | bool | int | float | str | list[JsonValue] | dict[str, JsonValue]"
JsonObject: TypeAlias = "dict[str, Any]"

__all__ = ["Adapter", "Call", "Case", "ModelCallError", "Result", "Variant", "fallback"]


# --- stdout protection (helper-api §stdout Protection) -------------------------------------


def protect_stdout() -> int:
    """Keeps a duplicate of descriptor 1 for protocol output and points descriptor 1 at stderr,
    so `print`, C extensions and child processes all write to stderr."""
    if sys.stdout is not None:
        sys.stdout.flush()
    kept = os.dup(1)
    os.dup2(2, 1)
    return kept


PROTOCOL_FD = protect_stdout()


# --- Comparing text (data-model §Comparing Text) -------------------------------------------

# The 25 Unicode White_Space code points of 001 data-model §Trial Outcomes. str.strip() also
# removes U+001C to U+001F, so the helper names them.
WHITE_SPACE = frozenset(
    chr(code_point)
    for code_point in (
        *range(0x0009, 0x000E),
        0x0020,
        0x0085,
        0x00A0,
        0x1680,
        *range(0x2000, 0x200B),
        0x2028,
        0x2029,
        0x202F,
        0x205F,
        0x3000,
    )
)


def trim_text(text: str) -> str:
    """The text without White_Space code points at either end."""
    start, end = 0, len(text)
    while start < end and text[start] in WHITE_SPACE:
        start += 1
    while end > start and text[end - 1] in WHITE_SPACE:
        end -= 1
    return text[start:end]


def is_empty_text(text: str) -> bool:
    """Nothing remains after trimming White_Space from both ends."""
    return trim_text(text) == ""


# --- Canonical JSON (001 data-model §Canonical JSON) ---------------------------------------

SHORT_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\f": "\\f",
    "\r": "\\r",
}


def canonical_json(value: Any) -> str:
    """The canonical JSON text of a value. Raises ValueError for numbers without a canonical
    form (NaN, infinity) and TypeError for values that are not JSON."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return number_text(value)
    if isinstance(value, str):
        return string_text(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        return object_text(value)
    raise TypeError(f"{type(value).__name__} is not a JSON value")


def object_text(value: dict[Any, Any]) -> str:
    for key in value:
        if not isinstance(key, str):
            raise TypeError(f"object keys are strings, not {type(key).__name__}")
    keys = sorted(value, key=utf16_units)
    return "{" + ",".join(f"{string_text(key)}:{canonical_json(value[key])}" for key in keys) + "}"


def utf16_units(text: str) -> bytes:
    """Sorting by these bytes sorts by UTF-16 code units, lone surrogates included."""
    return text.encode("utf-16-be", "surrogatepass")


# What JSON.stringify escapes: `"`, `\\`, U+0000 to U+001F and lone surrogates.
ESCAPED = re.compile(r'["\\\x00-\x1f\ud800-\udfff]')
SURROGATES = re.compile(r"[\ud800-\udfff]")


def string_text(text: str) -> str:
    """A JSON string written as ECMAScript JSON.stringify writes it."""
    return '"' + ESCAPED.sub(escape, as_utf16_chars(text)) + '"'


def escape(match: re.Match[str]) -> str:
    char = match.group()
    return SHORT_ESCAPES.get(char) or f"\\u{ord(char):04x}"


def as_utf16_chars(text: str) -> str:
    """The text with a high surrogate followed by a low one joined into one character, as a
    UTF-16 string reads them; lone surrogates stay."""
    if SURROGATES.search(text) is None:
        return text
    units = utf16_units(text)
    chars, index = [], 0
    while index < len(units):
        unit = int.from_bytes(units[index : index + 2], "big")
        following = int.from_bytes(units[index + 2 : index + 4], "big")
        if 0xD800 <= unit <= 0xDBFF and 0xDC00 <= following <= 0xDFFF:
            chars.append(chr(0x10000 + ((unit - 0xD800) << 10) + (following - 0xDC00)))
            index += 4
        else:
            chars.append(chr(unit))
            index += 2
    return "".join(chars)


def number_text(number: int | float) -> str:
    """The number as an IEEE 754 double in ECMAScript Number::toString notation."""
    try:
        value = float(number)
    except OverflowError:
        raise ValueError(f"{number} does not fit in a double") from None
    if not math.isfinite(value):
        raise ValueError(f"{value} has no canonical JSON form")
    if value == 0:
        return "0"
    if value < 0:
        return "-" + number_text(-value)
    digits, point = shortest_digits(value)
    return ecmascript_layout(digits, point)


def shortest_digits(value: float) -> tuple[str, int]:
    """The shortest digits that read back as `value`, and `point` with value = 0.digits × 10^point.
    repr() gives the shortest round-trip digits, the same digits ECMAScript chooses."""
    mantissa, _, exponent = repr(value).partition("e")
    whole, _, fraction = mantissa.partition(".")
    digits = whole + fraction
    point = len(whole) + int(exponent or "0")
    stripped = digits.lstrip("0")
    point -= len(digits) - len(stripped)
    return stripped.rstrip("0"), point


def ecmascript_layout(digits: str, point: int) -> str:
    """Number::toString steps for a positive value 0.digits × 10^point."""
    count = len(digits)
    if count <= point <= 21:
        return digits + "0" * (point - count)
    if 0 < point <= 21:
        return digits[:point] + "." + digits[point:]
    if -6 < point <= 0:
        return "0." + "0" * -point + digits
    exponent = point - 1
    sign = "+" if exponent >= 0 else "-"
    mantissa = digits if count == 1 else digits[0] + "." + digits[1:]
    return f"{mantissa}e{sign}{abs(exponent)}"


def read_json(text: str) -> JsonValue:
    """Reads JSON text by the reading rules: NaN, Infinity and numbers too large for a double make
    it not JSON (ValueError); duplicate names keep the last value."""
    value: JsonValue = json.loads(
        text, parse_constant=refuse_constant, parse_float=read_float, parse_int=read_int
    )
    return value


def refuse_constant(name: str) -> float:
    raise ValueError(f"{name} is not JSON")


def read_float(text: str) -> float:
    value = float(text)
    if not math.isfinite(value):
        raise ValueError(f"{text} does not fit in a double")
    return value


def read_int(text: str) -> int:
    value = int(text)
    try:
        float(value)
    except OverflowError:
        raise ValueError(f"{text} does not fit in a double") from None
    return value


def sha256_of_text(text: str) -> str:
    """`sha256:` and the hex digest of the text's UTF-8 bytes. The texts hashed are canonical JSON,
    where lone surrogates are already escaped; any other lone surrogate is hashed as U+FFFD, as
    the UTF-8 encoding of a UTF-16 string writes it."""
    well_formed = utf16_units(text).decode("utf-16-be", "replace")
    return "sha256:" + hashlib.sha256(well_formed.encode("utf-8")).hexdigest()


# --- Messages (helper-api §Messages) -----------------------------------------------------

# Every sentence of helper-api §Messages, one entry per variant, under the IDs of
# test/fixtures/helper/messages.json. Placeholders are written <name>.
MESSAGES: dict[str, str] = {
    "A1": (
        "No model request was captured. Import the helper before the service (in Node, "
        "before any SDK client is created), and let the SDK send through httpx or httpx2 "
        "(Python) or the global `fetch` (Node). If the service calls the model through "
        "another transport (Bedrock, Vertex AI, a child process such as the Claude Agent "
        "SDK), give the answer as `Result(raw=, final=, finish_reason=, usage=, model=)` "
        "and throw failures as `ModelCallError`. If the case takes a path that calls no "
        "model (an input block, a fixed message), remove the case or change its input."
    ),
    "A1-raised": (
        "The target function raised <exception>. No model request was captured. Import the "
        "helper before the service (in Node, before any SDK client is created), and let the "
        "SDK send through httpx or httpx2 (Python) or the global `fetch` (Node). If the "
        "service calls the model through another transport (Bedrock, Vertex AI, a child "
        "process such as the Claude Agent SDK), give the answer as `Result(raw=, final=, "
        "finish_reason=, usage=, model=)` and throw failures as `ModelCallError`. If the "
        "case takes a path that calls no model (an input block, a fixed message), remove "
        "the case or change its input."
    ),
    "A2": (
        "No request went to the variant model `<model>` (captured: <models>). Check that "
        "the adapter passes the variant model to the service. If the answer came through an "
        "uncaptured transport (Bedrock and similar), give `Result(raw=, final=, "
        "finish_reason=, usage=, model=)`. If a call before the answer failed or timed out "
        "and the service never requested the answer, throw that failure as `ModelCallError` "
        "with that call's `model`; if it refused, remove the case or change its input."
    ),
    "A2-raised": (
        "No request went to the variant model `<model>` (captured: <models>). Check that "
        "the adapter passes the variant model to the service. If the answer came through an "
        "uncaptured transport (Bedrock and similar), give `Result(raw=, final=, "
        "finish_reason=, usage=, model=)`. If a call before the answer failed or timed out "
        "and the service never requested the answer, throw that failure as `ModelCallError` "
        "with that call's `model`; if it refused, remove the case or change its input. The "
        "target function raised <exception>."
    ),
    "A2-result-model": (
        "`Result(model=)` gives <models>, not the variant model `<model>`. Give the model "
        "the service called; if the service did not call the variant model, check that the "
        "adapter passes it to the service."
    ),
    "A3-a": (
        "Cannot choose the answer call (`reply_call` is true only for calls to <models>). "
        "Make `reply_call` true for the variant model's answer calls."
    ),
    "A3-a-raised": (
        "Cannot choose the answer call (`reply_call` is true only for calls to <models>). "
        "Make `reply_call` true for the variant model's answer calls. The target function "
        "raised <exception>."
    ),
    "A3-b": (
        "Cannot choose the answer call (no call is true for `reply_call`). Make "
        "`reply_call` true for the answer calls; if the service shipped a fixed message "
        "without requesting the answer, wrap it with `fallback`."
    ),
    "A3-b-raised": (
        "Cannot choose the answer call (no call is true for `reply_call`). Make "
        "`reply_call` true for the answer calls; if the service shipped a fixed message "
        "without requesting the answer, wrap it with `fallback`. The target function raised "
        "<exception>."
    ),
    "A3-c": (
        "Cannot choose the answer call (the variant model got requests that are neither "
        "resends nor tool-loop steps of one another, such as a classification or a memory "
        "write besides the answer). Set `reply_call` to select the answer calls."
    ),
    "A3-c-raised": (
        "Cannot choose the answer call (the variant model got requests that are neither "
        "resends nor tool-loop steps of one another, such as a classification or a memory "
        "write besides the answer). Set `reply_call` to select the answer calls. The target "
        "function raised <exception>."
    ),
    "A3-d": (
        "Cannot choose the answer call (the answers came from requests with different "
        "system prompts). If the service regenerates with a changed system prompt, give the "
        "first answer as `Result(raw=)`; otherwise make `reply_call` false for side calls."
    ),
    "A3-d-raised": (
        "Cannot choose the answer call (the answers came from requests with different "
        "system prompts). If the service regenerates with a changed system prompt, give the "
        "first answer as `Result(raw=)`; otherwise make `reply_call` false for side calls. "
        "The target function raised <exception>."
    ),
    "A3-raw-unread-systems": (
        "Cannot choose the answer call (unread responses have different system prompts). "
        "Set `reply_call`."
    ),
    "A3-raw-other-answer": (
        "Cannot choose the answer call (another variant model request, not a resend or "
        "tool-loop step of the raw answer's request, also got an answer). If it is a side "
        "call, exclude it with `reply_call`; if it is a regenerated answer, give "
        "`Result(finish_reason=, answers=)`."
    ),
    "A3-raw-unread-follows": (
        "Cannot choose the answer call (an unread response follows the raw answer). If it "
        "is a side call, exclude it with `reply_call`; if it is a regenerated answer, give "
        "`Result(finish_reason=, answers=)`."
    ),
    "A4": (
        "Every answer call ended in a tool call. If the service takes its final answer as a "
        "tool call, set `answer_tool`."
    ),
    "A5": (
        "Streaming responses are not parsed yet. Give the raw answer and finish reason the "
        "service received as `Result(raw=, finish_reason=)`."
    ),
    "A6": (
        "Responses background mode is not parsed. Give the final output and finish reason "
        "the service received later as `Result(raw=, finish_reason=)`."
    ),
    "A7": (
        "Cannot find the call that produced the raw answer: no answer of the variant model "
        "`<model>` has its text (captured: <models>). If you changed a captured answer, "
        "give it unchanged. If the answer came through an uncaptured transport, give "
        "`Result(model=)` with `finish_reason=` and `usage=`. If a same-model call before "
        'the answer refused and the answer was never requested, give `Result(raw="", '
        'kind="fallback", finish_reason="other")`; exclude that call with `reply_call` when '
        "it was captured, and add `model=` and `answers=0` when it was not. If the captured "
        "calls went only to other models, check that the adapter passes the variant model "
        "to the service, or remove cases where another model's call before the answer keeps "
        "the service from calling it."
    ),
    "A8": (
        "`answers=0` was given but a fully received answer exists. If the answer was fully "
        "received before the check blocked, give the first answer as `Result(raw=, "
        'kind="fallback")`, adding `finish_reason="other"` when an answer came as a stream, '
        "two or more answers were received or a stream was cut after it, and in the last "
        "two cases the received count as `answers=`, not counting the stream the check cut "
        '(`kind="discarded"` for a discard). If it is the answer of a same-model check, '
        "exclude that call with `reply_call`. For a streaming tool loop with `answer_tool`, "
        "do not give `answers=0`."
    ),
    "A9": (
        "`Result(finish_reason=)` is required: the answer that decides the finish reason is "
        "an unread response or an uncaptured call."
    ),
    "A10": (
        "A model request was made outside any trial context (run with `--concurrency 1`, or "
        "have the service pass the context)."
    ),
    "A11": ("Could not reach the render target request."),
    "A12": (
        "`ModelCallError` takes exactly one of `status` (an HTTP status code), `kind` "
        "(`connect`, `tls`, `disconnect` or `timeout`) and `call` (a call of this trial)."
    ),
    "A13": (
        "`call` takes only a failure the service received, and with `reply_call` only a "
        "failure of an answer call."
    ),
    "A14": (
        "The target function returned a value that is not text, `fallback(text)` or a valid "
        "`Result`. Return the shipped text; a missing `return` gives None, and only a "
        "discarded `Result` may have `final=None`."
    ),
    "A15": (
        "This target has no render mode. Set `render` on it, or move targets without render "
        "mode to a separate adapter, which then does not declare `render`."
    ),
    "A16": (
        "Deciding the trial's outcome failed: <exception>. If `reply_call` or `discard_on` "
        "raised it, fix that function; otherwise report it as a helper defect."
    ),
    "A17": ("The render function raised <exception>."),
    "A18": (
        "The render function returned a value that is not a render result. Return "
        "`{messages, tools?, maxOutputTokens?}` with `messages` a non-empty list of message "
        "objects, `tools` a list and `maxOutputTokens` a positive integer."
    ),
    "A19": (
        "The render target request cannot be rendered: it has no message (a Responses request "
        "continuing a conversation stored on the server), a message without a role, or `tools` "
        "that is not a list. Return the assembled messages with `@adapter.render`."
    ),
    "F1": ("The response body is not a JSON object."),
    "F2": ("The tool cancelled the trial."),
    "F3": ("The request URL does not start with http:// or https://; check base_url."),
    "row9": (
        "The target function raised <exception>. If the service raises it when it discards "
        "an answer, add it to `discard_on` (a target function that gives raw catches it and "
        'returns `Result(raw=, kind="discarded", discard_reason=)`); if the service\'s time '
        'limit raised it, catch it and throw `ModelCallError(kind="timeout")`.'
    ),
    "W1": (
        "In a trial that received an answer, a call to `<model>` failed transiently and the "
        "trial ended in a fallback or discard. If it was the regeneration request, this is "
        "correct. If the service shipped a message or discarded the answer because of that "
        "failure, throw the failure. If it was an unrelated call the service swallows and "
        "moves past (memory writes and similar), leave it."
    ),
    "W1-variant": (
        "In a trial that received an answer, a call to the variant model failed transiently "
        "and the trial ended in a fallback or discard. If it was the regeneration request, "
        "this is correct. If the service shipped a message or discarded the answer because "
        "of that failure, throw the failure. If it was an unrelated call the service "
        "swallows and moves past (memory writes and similar), leave it."
    ),
    "W2": (
        "The shipped text may be another model's answer (`<model>`). If the service shipped "
        "it, wrap it with `fallback`."
    ),
    "W3": (
        "The last answer did not end with `stop`, but an earlier answer of the same request "
        "did. If the service picked an answer, give its finish reason as "
        "`Result(finish_reason=)`."
    ),
    "W4": (
        "No captured answer has the raw answer's text, so it was added as an uncaptured "
        "call and its cost may be counted twice. Give a captured answer unchanged; if the "
        "captured answer belongs to a side call, exclude it with `reply_call`."
    ),
    "W5": (
        "Decided by a captured call's failure instead of the given raw answer. If the "
        "answer request failed (a provider error, a rate limit, a dropped connection, also "
        "mid-stream after some text arrived), this is correct. If the failed call is a "
        "same-model side call, exclude it with `reply_call`."
    ),
    "W5-cut-last-answer": (
        "Decided by a captured call's failure instead of the given raw answer. If the "
        "service cut a regeneration after it fully received an earlier answer, give "
        '`answers=` (counting the cut answer) and `finish_reason=`, with `kind="fallback"` '
        "if it shipped the cut text, a fixed message or another model's answer "
        '(`kind="discarded"` for a discard). If the answer request failed (a provider '
        "error, a rate limit, a dropped connection, also mid-stream after some text "
        "arrived), this is correct. If the failed call is a same-model side call, exclude "
        "it with `reply_call`."
    ),
    "W6": (
        "Decided as a time-out instead of the given raw answer (the service stopped "
        "receiving before the model's answer was complete). If the service's time limit cut "
        'it, this is correct. Otherwise, by cause: a content cut, give `kind="fallback"` '
        'and `finish_reason="other"` (`kind="discarded"` for a discard); an input check '
        'sent with the answer that blocked it, `Result(raw="", kind="fallback", '
        "answers=0)`; a configured stop string, `stopped_early=True`; a cut same-model side "
        "call, exclude it with `reply_call`; another call's failure that left the service "
        "no answer to ship, throw that failure; returning on an event saying the text "
        "ended, read the stream to its end event."
    ),
    "W6-cut-last-answer": (
        "Decided as a time-out instead of the given raw answer (the service stopped "
        "receiving before the model's answer was complete). If the service cut a "
        "regeneration after it fully received an earlier answer, give `answers=` (counting "
        'the cut answer) and `finish_reason=`, with `kind="fallback"` if it shipped the cut '
        'text, a fixed message or another model\'s answer (`kind="discarded"` for a '
        "discard). If it sent a modified request alongside and shipped the answer that came "
        "first, select both requests with `reply_call` and give `Result(finish_reason=, "
        "answers=1)`. If the service's time limit cut it, this is correct. Otherwise, by "
        'cause: a content cut, give `kind="fallback"` and `finish_reason="other"` '
        '(`kind="discarded"` for a discard); an input check sent with the answer that '
        'blocked it, `Result(raw="", kind="fallback", answers=0)`; a configured stop '
        "string, `stopped_early=True`; a cut same-model side call, exclude it with "
        "`reply_call`; another call's failure that left the service no answer to ship, "
        "throw that failure; returning on an event saying the text ended, read the stream "
        "to its end event."
    ),
    "W6-stopped-early-ignored": (
        "Decided as a time-out instead of the given raw answer (the service stopped "
        "receiving before the model's answer was complete). If the service's time limit cut "
        'it, this is correct. Otherwise, by cause: a content cut, give `kind="fallback"` '
        'and `finish_reason="other"` (`kind="discarded"` for a discard); an input check '
        'sent with the answer that blocked it, `Result(raw="", kind="fallback", '
        "answers=0)`; a cut same-model side call, exclude it with `reply_call`; another "
        "call's failure that left the service no answer to ship, throw that failure; "
        "returning on an event saying the text ended, read the stream to its end event."
    ),
    "W6-stopped-early-honoured": (
        "Decided as a time-out instead of the given raw answer (the service stopped "
        "receiving before the model's answer was complete). If the service's time limit cut "
        'it, this is correct. Otherwise, by cause: a content cut, give `kind="fallback"` '
        'and `finish_reason="other"` (`kind="discarded"` for a discard); an input check '
        'sent with the answer that blocked it, `Result(raw="", kind="fallback", '
        "answers=0)`; a cut same-model side call, exclude it with `reply_call`; another "
        "call's failure that left the service no answer to ship, throw that failure; "
        "returning on an event saying the text ended, read the stream to its end event. "
        "`stopped_early` was given, but the stream was cut during an awaited read or was "
        "still being read when the function returned, which looks like a time limit; stop "
        "with `break` from the SDK's plain stream iterator, or call `abort()` in a Node "
        "stream helper's event handler before any `await`."
    ),
    "W6-cut-last-answer-stopped-early-ignored": (
        "Decided as a time-out instead of the given raw answer (the service stopped "
        "receiving before the model's answer was complete). If the service cut a "
        "regeneration after it fully received an earlier answer, give `answers=` (counting "
        'the cut answer) and `finish_reason=`, with `kind="fallback"` if it shipped the cut '
        'text, a fixed message or another model\'s answer (`kind="discarded"` for a '
        "discard). If it sent a modified request alongside and shipped the answer that came "
        "first, select both requests with `reply_call` and give `Result(finish_reason=, "
        "answers=1)`. If the service's time limit cut it, this is correct. Otherwise, by "
        'cause: a content cut, give `kind="fallback"` and `finish_reason="other"` '
        '(`kind="discarded"` for a discard); an input check sent with the answer that '
        'blocked it, `Result(raw="", kind="fallback", answers=0)`; a cut same-model side '
        "call, exclude it with `reply_call`; another call's failure that left the service "
        "no answer to ship, throw that failure; returning on an event saying the text "
        "ended, read the stream to its end event."
    ),
    "W6-cut-last-answer-stopped-early-honoured": (
        "Decided as a time-out instead of the given raw answer (the service stopped "
        "receiving before the model's answer was complete). If the service cut a "
        "regeneration after it fully received an earlier answer, give `answers=` (counting "
        'the cut answer) and `finish_reason=`, with `kind="fallback"` if it shipped the cut '
        'text, a fixed message or another model\'s answer (`kind="discarded"` for a '
        "discard). If it sent a modified request alongside and shipped the answer that came "
        "first, select both requests with `reply_call` and give `Result(finish_reason=, "
        "answers=1)`. If the service's time limit cut it, this is correct. Otherwise, by "
        'cause: a content cut, give `kind="fallback"` and `finish_reason="other"` '
        '(`kind="discarded"` for a discard); an input check sent with the answer that '
        'blocked it, `Result(raw="", kind="fallback", answers=0)`; a cut same-model side '
        "call, exclude it with `reply_call`; another call's failure that left the service "
        "no answer to ship, throw that failure; returning on an event saying the text "
        "ended, read the stream to its end event. `stopped_early` was given, but the stream "
        "was cut during an awaited read or was still being read when the function returned, "
        "which looks like a time limit; stop with `break` from the SDK's plain stream "
        "iterator, or call `abort()` in a Node stream helper's event handler before any "
        "`await`."
    ),
    "W7": ("`stopped_early` is honoured only with a non-empty raw answer and kind `model`."),
    "W8": (
        "The raw answer may come from a response of `<model>`, not the variant model. Check "
        "that the adapter passes the variant model to the service."
    ),
    "W9": (
        "Input tokens minus cache hits and cache writes was negative and was set to 0. The "
        "provider may have changed what the usage fields mean."
    ),
    "W10": (
        "The thrown failure may belong to an earlier attempt that was resent. Throw the "
        "failure the service received."
    ),
    "L1": ("Service version not reported: <reason>."),
    "L2": ("Unhandled exception in background work: <exception>."),
    "L3": ("A request of an abandoned trial was cut or blocked: <exception>."),
}


def message(message_id: str, **placeholders: str) -> str:
    """The sentence of `message_id` with its placeholders filled. A '.' right after a
    placeholder is left out when the value already ends with '.', '!' or '?'."""
    text = MESSAGES[message_id]
    for name, value in placeholders.items():
        marker = f"<{name}>"
        if value.endswith((".", "!", "?")):
            text = text.replace(f"{marker}.", value)
        text = text.replace(marker, value)
    return text


def exception_text(error: BaseException) -> str:
    """`<exception>`: `Class: message` with the message trimmed of White_Space, or the class
    name alone when nothing remains."""
    name, text = type(error).__name__, trim_text(str(error))
    return name if text == "" else f"{name}: {text}"


def model_list(models: Sequence[str]) -> str:
    """`<models>`: distinct names in the order given, each in backticks, joined with ', '."""
    distinct = list(dict.fromkeys(models))
    return ", ".join(f"`{model}`" for model in distinct) if distinct else "none"


# --- Discard reason (data-model §Outcome Decision, row 8) ----------------------------------

DISCARD_REASON_LIMIT = 200


def discard_reason(error: BaseException) -> str:
    """The exception's `<exception>` text cut to its first 200 code points."""
    return exception_text(error)[:DISCARD_REASON_LIMIT]


# --- JSON values read from bodies ----------------------------------------------------------


def as_dict(value: Any) -> JsonObject:
    return value if isinstance(value, dict) else {}


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def as_str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def as_count(value: Any) -> int | None:
    """An integer of a body or a parameter (helper-api §Shared Conventions), JSON 2.0 included."""
    return int(value) if whole_number(value) else None


def text_of(value: Any, default: str = "") -> str:
    """Text read from a field that should hold a string (helper-api §Shared Conventions): a
    value that is not a string gives its canonical JSON; a missing field gives `default`."""
    if value is MISSING:
        return default
    return value if isinstance(value, str) else canonical_json(value)


# A field a body leaves out, apart from an explicit null.
MISSING: Any = object()


def read_json_or_none(text: str) -> JsonValue:
    """The JSON value of the text by the reading rules, or None when it is not JSON."""
    try:
        return read_json(text)
    except ValueError:
        return None


# --- Public API (helper-api §Python, §Adapter Options, §Target Options, §Target Function) ---


@dataclass(frozen=True)
class Case:
    """The case of one trial: `rendering` is true in render mode, where `repeat` is 0."""

    id: str
    lang: str | None
    input: JsonObject
    repeat: int
    seed: int
    rendering: bool = False


@dataclass(frozen=True)
class Variant:
    id: str
    model: str
    params: JsonObject = field(default_factory=dict)


@dataclass(frozen=True)
class Fallback:
    """Shipped text that is not the model's answer (a fixed message, another model's answer)."""

    text: str


def fallback(text: str) -> Fallback:
    """Marks the shipped text as a fallback (data-model §Another Model's Answer). A value that
    is not text is kept as given and makes the trial adapter error A14."""
    return Fallback(text)


# Marks a `Result` field the target function left out, apart from an explicit None.
OMITTED: Any = object()


class Result:
    """What the target function reports beyond the shipped text (helper-api §`Result`). Any
    value is accepted here; the helper checks them when it decides the trial (A14). Fields other
    than `final` that are None count as not given."""

    def __init__(
        self,
        *,
        final: Any = OMITTED,
        kind: Any = None,
        discard_reason: Any = None,
        stages: Any = None,
        raw: Any = None,
        answers: Any = None,
        finish_reason: Any = None,
        stopped_early: Any = None,
        usage: Any = None,
        model: Any = None,
        model_snapshot: Any = None,
    ) -> None:
        self.final = final
        self.kind = kind
        self.discard_reason = discard_reason
        self.stages = stages
        self.raw = raw
        self.answers = answers
        self.finish_reason = finish_reason
        self.stopped_early = stopped_early
        self.usage = usage
        self.model = model
        self.model_snapshot = model_snapshot

    def __repr__(self) -> str:
        return f"Result(kind={self.kind!r}, raw={self.raw!r})"


class ModelCallError(Exception):
    """A model call failure the target function reports (helper-api §`ModelCallError`). Any
    value is accepted here; the helper checks them when it decides the trial (A12)."""

    def __init__(
        self,
        message: Any = None,
        *,
        status: Any = None,
        type: Any = None,
        code: Any = None,
        kind: Any = None,
        retry_after_ms: Any = None,
        model: Any = None,
        usage: Any = None,
        call: Any = None,
    ) -> None:
        super().__init__(message if isinstance(message, str) else "")
        self.message = message
        self.status = status
        self.type = type
        self.code = code
        self.kind = kind
        self.retry_after_ms = retry_after_ms
        self.model = model
        self.usage = usage
        self.call = call


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: str


class Call:
    """One captured call as the target function's third argument and `reply_call` see it.
    Response fields are None for calls that have not ended (data-model §When a Call Ended)."""

    def __init__(
        self,
        model: str,
        messages: list[JsonObject],
        tool_names: list[str],
        response: CallResponse | None = None,
    ) -> None:
        self.model = model
        self.messages = messages
        self.tool_names = tool_names
        known = response if response is not None else CallResponse()
        self.text = known.text
        self.tool_calls = [
            {"id": call.id, "name": call.name, "arguments": call.arguments}
            for call in known.tool_calls
        ]
        self.finish_reason = known.finish_reason
        self.usage = None if known.usage is None else dict(known.usage)
        self.outcome = known.outcome
        self.error = None if known.error is None else dict(known.error)
        self.retried = known.retried
        # The captured call this view shows, so that `ModelCallError(call=)` finds it.
        self._source: CapturedCall | None = None

    def tool_args(self, name: str) -> JsonValue:
        """The parsed arguments of the first tool call with that name, or None when there is
        none or its arguments are not JSON."""
        for call in self.tool_calls:
            if call["name"] == name:
                return read_json_or_none(call["arguments"])
        return None

    def __repr__(self) -> str:
        return f"Call(model={self.model!r}, outcome={self.outcome!r})"


@dataclass
class CallResponse:
    """The response fields of a `Call`."""

    text: str | None = None
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str | None = None
    usage: dict[str, int] | None = None
    outcome: str | None = None
    error: JsonObject | None = None
    retried: bool | None = None


DiscardOn: TypeAlias = (
    "type[BaseException] | Sequence[type[BaseException]] | Callable[[BaseException], bool]"
)
ReplyCall: TypeAlias = "Callable[[Call], bool]"
TargetFunction: TypeAlias = "Callable[..., Any]"


@dataclass
class Target:
    """One `@adapter.target(...)` with the options of helper-api §Target Options."""

    name: str
    function: TargetFunction
    languages: list[str] | None
    input_schema: JsonValue
    render: Any
    discard_on: DiscardOn
    reply_call: ReplyCall | None
    answer_tool: tuple[str, str] | None
    postprocess: bool
    is_async: bool
    takes_calls: bool

    def discards(self, error: BaseException) -> bool:
        """Whether the exception is one the service raises when it discards an answer."""
        rule = self.discard_on
        if isinstance(rule, type):
            return isinstance(error, rule)
        if callable(rule):
            return bool(rule(error))
        return isinstance(error, tuple(rule))


def accepts_third_argument(function: TargetFunction) -> bool:
    """Whether the function takes the list of calls as a third positional argument."""
    try:
        parameters = list(inspect.signature(function).parameters.values())
    except (TypeError, ValueError):
        return False
    positional = (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    if any(parameter.kind is inspect.Parameter.VAR_POSITIONAL for parameter in parameters):
        return True
    return sum(parameter.kind in positional for parameter in parameters) >= 3


class Adapter:
    """An adapter process: `@adapter.target(...)` registers target functions and `run()` serves
    adapter protocol v1 on the process's stdio."""

    def __init__(
        self,
        name: str,
        version: str,
        service_dir: str | os.PathLike[str] | None = None,
        max_concurrency: int | None = None,
    ) -> None:
        self.name = name
        self.version = version
        self.service_dir = None if service_dir is None else os.fspath(service_dir)
        self.max_concurrency = max_concurrency
        self.targets: dict[str, Target] = {}
        self.render_functions: dict[str, Callable[[Case, Variant], Any]] = {}

    def target(
        self,
        name: str,
        *,
        languages: Sequence[str] | None = None,
        input_schema: JsonValue = None,
        render: Any = False,
        discard_on: DiscardOn = (),
        reply_call: ReplyCall | None = None,
        answer_tool: tuple[str, str] | None = None,
        postprocess: bool = True,
    ) -> Callable[[TargetFunction], TargetFunction]:
        """Registers the decorated function as target `name`."""

        def register(function: TargetFunction) -> TargetFunction:
            self.targets[name] = Target(
                name=name,
                function=function,
                languages=None if languages is None else list(languages),
                input_schema=True if input_schema is None else input_schema,
                render=render,
                discard_on=discard_on,
                reply_call=reply_call,
                answer_tool=None if answer_tool is None else (answer_tool[0], answer_tool[1]),
                postprocess=postprocess,
                is_async=inspect.iscoroutinefunction(function),
                takes_calls=accepts_third_argument(function),
            )
            return function

        return register

    def render(
        self, name: str
    ) -> Callable[[Callable[[Case, Variant], Any]], Callable[[Case, Variant], Any]]:
        """Registers the decorated function as the render function of target `name`."""

        def register(function: Callable[[Case, Variant], Any]) -> Callable[[Case, Variant], Any]:
            self.render_functions[name] = function
            return function

        return register

    def renders(self, target: Target) -> bool:
        return target.render is not False or target.name in self.render_functions

    def run(self) -> None:
        """Serves the protocol until `shutdown` or the end of stdin."""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        server = Server(self, loop)
        try:
            loop.run_until_complete(server.serve())
        finally:
            HUB.detach()
            cancel_remaining_tasks(loop)
            loop.close()


def cancel_remaining_tasks(loop: asyncio.AbstractEventLoop) -> None:
    """Cancels background work the service left running, as `asyncio.run` does, without
    waiting for worker threads."""
    pending = [task for task in asyncio.all_tasks(loop) if not task.done()]
    for task in pending:
        task.cancel()
    if pending:
        loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
    loop.run_until_complete(loop.shutdown_asyncgens())


# --- retry-after (helper-api §retryAfterMs) ------------------------------------------------

DECIMAL = re.compile(r"[0-9]+(?:\.[0-9]+)?")
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
MONTH = "(" + "|".join(MONTHS) + ")"
TIME = r"([0-9]{2}):([0-9]{2}):([0-9]{2})"
# RFC 9110 §5.6.7: IMF-fixdate, the obsolete RFC 850 form and the asctime form, all in GMT.
IMF_FIXDATE = re.compile(
    rf"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([0-9]{{2}}) {MONTH} ([0-9]{{4}}) {TIME} GMT"
)
DAY_NAME = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)"
RFC_850_DATE = re.compile(rf"{DAY_NAME}, ([0-9]{{2}})-{MONTH}-([0-9]{{2}}) {TIME} GMT")
ASCTIME_DATE = re.compile(
    rf"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) {MONTH} ([0-9 ][0-9]) {TIME} ([0-9]{{4}})"
)


def retry_after_ms(headers: Mapping[str, str], now_ms: float | None = None) -> int | None:
    """The wait a response asks for, in ms: `retry-after-ms` when readable, else `retry-after`
    as seconds or as an HTTP date; None when neither is readable."""
    now = time.time() * 1000 if now_ms is None else now_ms
    lowered = {name.lower(): value for name, value in headers.items()}
    if "retry-after-ms" in lowered:
        waited = read_number(lowered["retry-after-ms"], 1)
        if waited is not None:
            return waited
    if "retry-after" not in lowered:
        return None
    value = lowered["retry-after"]
    seconds = read_number(value, 1000)
    if seconds is not None:
        return seconds
    date_ms = http_date_ms(trim_header(value), now)
    return None if date_ms is None else max(0, rounded(date_ms - now))


def read_number(value: str, scale: int) -> int | None:
    """A non-negative decimal times `scale`, rounded half up; None for any other text."""
    text = trim_header(value)
    if DECIMAL.fullmatch(text) is None:
        return None
    return wait_ms(float(text) * scale)


def wait_ms(value: float) -> int | None:
    """helper-api §`retryAfterMs`: floor(x + 0.5) as the exact value (x itself from 2^52 on,
    where a double is already an integer); None when x is negative or not finite, or the
    value is above 2^53 - 1."""
    if not math.isfinite(value) or value < 0:
        return None
    waited = int(value) if value >= 2.0**52 else rounded(value)
    return waited if waited <= SAFE_INTEGER else None


def trim_header(value: str) -> str:
    """The value without SP and HTAB at either end, the optional whitespace of RFC 9110."""
    return value.strip(" \t")


def rounded(value: float) -> int:
    """floor(x + 0.5): halves round up in both helpers, where round() would round half to even."""
    return math.floor(value + 0.5)


def http_date_ms(text: str, now_ms: float) -> int | None:
    """The time an HTTP date names, in ms since the epoch, read as GMT in all three forms."""
    match = IMF_FIXDATE.fullmatch(text)
    if match is not None:
        day, month, year, hour, minute, second = match.groups()
        return utc_ms(int(year), month, day, hour, minute, second)
    match = RFC_850_DATE.fullmatch(text)
    if match is not None:
        day, month, short_year, hour, minute, second = match.groups()
        return rfc_850_ms(int(short_year), (month, day, hour, minute, second), now_ms)
    match = ASCTIME_DATE.fullmatch(text)
    if match is not None:
        month, day, hour, minute, second, year = match.groups()
        return utc_ms(int(year), month, day.strip(), hour, minute, second)
    return None


def rfc_850_ms(short_year: int, rest: tuple[str, str, str, str, str], now_ms: float) -> int | None:
    """RFC 9110 §5.6.7: the date in the year with these last two digits that lies more than 50
    years before now and at most 50 years after it, compared by instant."""
    earliest, latest = years_from(now_ms, -50), years_from(now_ms, 50)
    century = time.gmtime(now_ms / 1000).tm_year // 100 * 100
    for year in (century - 100 + short_year, century + short_year, century + 100 + short_year):
        moment = utc_ms(year, *rest)
        if moment is not None and earliest < moment <= latest:
            return moment
    return None


def years_from(now_ms: float, years: int) -> float:
    """The instant `years` calendar years from now; 29 February moves to 28 February."""
    now = datetime.fromtimestamp(now_ms / 1000, timezone.utc)
    try:
        shifted = now.replace(year=now.year + years)
    except ValueError:
        shifted = now.replace(year=now.year + years, day=28)
    return shifted.timestamp() * 1000


def utc_ms(year: int, month: str, day: str, hour: str, minute: str, second: str) -> int | None:
    """Milliseconds since the epoch, or None for a date that does not exist."""
    try:
        moment = datetime(
            year,
            MONTHS.index(month) + 1,
            int(day),
            int(hour),
            int(minute),
            int(second),
            tzinfo=timezone.utc,
        )
    except ValueError:
        return None
    return calendar.timegm(moment.timetuple()) * 1000


# --- Requests (helper-api §Which Requests, §Render Mode; data-model §System Prompt) --------

API_SUFFIXES = (
    ("/chat/completions", "chat-completions"),
    ("/responses", "responses"),
    ("/messages", "messages"),
)
PART_KINDS = {
    "image_url": "image",
    "input_image": "image",
    "image": "image",
    "file": "file",
    "input_file": "file",
    "document": "file",
    "input_audio": "audio",
    "audio": "audio",
}
# Reasoning blocks written as one canonical JSON line each, like every block whose type ends in
# `tool_use` or `tool_result`.
REASONING_BLOCKS = frozenset({"thinking", "redacted_thinking"})
SYSTEM_ROLES = ("system", "developer")


def api_of_path(path: str) -> str | None:
    for suffix, api in API_SUFFIXES:
        if path.endswith(suffix):
            return api
    return None


def parts_text(parts: Any) -> str:
    """A message's `content` as one string: text parts joined with newlines, other parts as
    their kind or, for tool and reasoning parts, a line of canonical JSON."""
    if isinstance(parts, str):
        return parts
    if parts is None:
        return ""
    return "\n".join(part_line(as_dict(part)) for part in as_list(parts))


def part_line(part: JsonObject) -> str:
    """One part's line, by the first matching row of helper-api §Render Mode's part table."""
    kind = as_str(part.get("type")) or ""
    if kind.endswith(("tool_use", "tool_result")) or kind in REASONING_BLOCKS:
        return canonical_json(part)
    if isinstance(part.get("text"), str):
        return str(part["text"])
    if kind == "refusal" and isinstance(part.get("refusal"), str):
        return str(part["refusal"])
    return f"[{PART_KINDS.get(kind, kind)}]"


def chat_message(item: JsonObject) -> JsonObject:
    lines = [] if item.get("content") in (None, "", []) else [parts_text(item.get("content"))]
    lines.extend(canonical_json(call) for call in as_list(item.get("tool_calls")))
    if isinstance(item.get("function_call"), dict):
        lines.append(canonical_json(item["function_call"]))
    return {"role": role_text(item.get("role")), "content": "\n".join(lines)}


def responses_input(body: JsonObject) -> list[Any]:
    """The Responses `input` as items; a string is one user message."""
    value = body.get("input")
    if isinstance(value, str):
        return [{"role": "user", "content": value}]
    return as_list(value)


def role_text(role: Any) -> str:
    """A message's role; a missing or null role is the empty one (adapter error A19)."""
    return "" if role is None else text_of(role)


def responses_item(item: JsonObject) -> JsonObject:
    """A Responses input item: a message by its role, any other item (or one without a role)
    by its type; null counts as missing for both."""
    kind = item.get("type")
    if item.get("role") is not None and kind in (None, "message"):
        return {"role": text_of(item["role"]), "content": parts_text(item.get("content"))}
    return {"role": role_text(kind), "content": canonical_json(item)}


def render_messages(api: str, body: JsonObject) -> list[JsonObject]:
    """The request's messages in the render shape of helper-api §Render Mode."""
    if api == "chat-completions":
        return [chat_message(as_dict(item)) for item in as_list(body.get("messages"))]
    if api == "responses":
        messages = [responses_item(as_dict(item)) for item in responses_input(body)]
        if isinstance(body.get("instructions"), str):
            messages.insert(0, {"role": "system", "content": body["instructions"]})
        if "prompt" in body:
            leading = leading_system_count(messages)
            prompt = {"role": "prompt", "content": canonical_json(body["prompt"])}
            messages.insert(leading, prompt)
        return messages
    messages = []
    system = body.get("system")
    if system is not None:
        blocks = [as_dict(block) for block in as_list(system)]
        texts = [str(block["text"]) for block in blocks if isinstance(block.get("text"), str)]
        content = system if isinstance(system, str) else "\n".join(texts)
        messages.append({"role": "system", "content": content})
    for item in as_list(body.get("messages")):
        item = as_dict(item)
        messages.append(
            {"role": role_text(item.get("role")), "content": parts_text(item.get("content"))}
        )
    return messages


def leading_system_count(messages: list[JsonObject]) -> int:
    count = 0
    while count < len(messages) and messages[count]["role"] in SYSTEM_ROLES:
        count += 1
    return count


def system_of(messages: list[JsonObject]) -> list[str]:
    """data-model §System Prompt: the leading `system` and `developer` messages, in order."""
    return [str(item["content"]) for item in messages[: leading_system_count(messages)]]


def tool_names_of(body: JsonObject) -> list[str]:
    names = []
    for tool in as_list(body.get("tools")):
        tool = as_dict(tool)
        name = as_str(tool.get("name")) or as_str(as_dict(tool.get("function")).get("name"))
        if name is not None:
            names.append(name)
    return names


def render_fingerprint(messages: list[JsonObject], tools: Any) -> str:
    """The render fingerprint of `{messages, tools}`, `tools` null when absent (001 data-model
    §Identifiers and Hashing)."""
    return sha256_of_text(canonical_json({"messages": messages, "tools": tools}))


def request_key(body: JsonObject) -> str:
    """data-model §Call Branches, resend: the body without `stream` and `stream_options`."""
    return canonical_json({k: v for k, v in body.items() if k not in ("stream", "stream_options")})


def conversation_items(api: str, body: JsonObject) -> list[Any]:
    """The message list a tool-loop step extends (data-model §Call Branches)."""
    if api == "responses":
        return responses_input(body)
    return as_list(body.get("messages"))


# --- Responses (data-model §Usage Buckets, §Finish Reasons, §Derived Result Fields) --------

# Responses tool-call items and the result items that point back to them.
RESULT_ITEMS = {
    "function_call": ("function_call_output", "call_id"),
    "custom_tool_call": ("custom_tool_call_output", "call_id"),
    "computer_call": ("computer_call_output", "call_id"),
    "local_shell_call": ("local_shell_call_output", "id"),
    "shell_call": ("shell_call_output", "call_id"),
    "apply_patch_call": ("apply_patch_call_output", "call_id"),
    "mcp_approval_request": ("mcp_approval_response", "approval_request_id"),
}
RESULT_ITEM_TYPES = frozenset(
    {*(result for result, _ in RESULT_ITEMS.values()), "tool_search_output"}
)
LENGTH_REASONS = {"length", "max_tokens", "model_context_window_exceeded", "max_output_tokens"}
FILTER_REASONS = {"content_filter", "refusal"}
STOP_REASONS = {"stop", "completed", "end_turn", "stop_sequence"}


def protocol_finish(raw: str | None) -> str:
    """A provider finish reason on the protocol scale."""
    if raw in STOP_REASONS:
        return "stop"
    if raw in LENGTH_REASONS:
        return "length"
    if raw in FILTER_REASONS:
        return "content_filter"
    return "other"


@dataclass
class Choice:
    """One answer slot of a response: a `choices` item, or the whole response."""

    text: str
    finish_raw: str | None
    tool_calls: list[ToolCall]
    # Ended in a tool call, or Anthropic `pause_turn` (data-model §Finish Reasons).
    tool_end: bool

    @property
    def finish(self) -> str:
        return protocol_finish(self.finish_raw)


@dataclass
class Parsed:
    """What a fully received JSON response body says."""

    choices: list[Choice]
    usage: dict[str, int] | None
    negative_input: bool
    response_model: str | None
    response_id: str | None
    status: str | None
    output_items: list[Any]
    error: JsonObject | None


def call_id_of(item: JsonObject) -> str:
    key = "id" if item.get("type") == "mcp_approval_request" else "call_id"
    value = item.get(key)
    return id_text(item.get("id") if value is None or value == "" else value)


def id_text(value: Any) -> str:
    """An ID: empty when missing, null or the empty string, else `text_of` (0 gives "0")."""
    return "" if value is None or value == "" else text_of(value)


def responses_tool_items(output: list[Any]) -> list[JsonObject]:
    """The output items that are tool calls the service must answer (data-model §Finish
    Reasons, Responses tool-call items)."""
    items = [as_dict(item) for item in output]
    calls = []
    for item in items:
        kind = item.get("type")
        if kind == "tool_search_call":
            if item.get("execution") == "client":
                calls.append(item)
            continue
        if kind not in RESULT_ITEMS:
            continue
        result_type, pointer = RESULT_ITEMS[str(kind)]
        target = call_id_of(item)
        answered = bool(target) and any(
            other.get("type") == result_type and id_text(other.get(pointer)) == target
            for other in items
        )
        if not answered:
            calls.append(item)
    return calls


def tool_arguments(value: Any) -> str:
    return value if isinstance(value, str) else canonical_json(value if value is not None else {})


def responses_tool_call(item: JsonObject) -> ToolCall:
    arguments = item.get("arguments", item.get("input", item.get("action")))
    return ToolCall(
        call_id_of(item),
        text_of(item.get("name") or item.get("type")),
        tool_arguments(arguments),
    )


def parse_chat(body: JsonObject) -> list[Choice]:
    """One `Choice` per `choices` item; an empty or missing list is one empty answer
    (data-model §Answer)."""
    choices = []
    for item in as_list(body.get("choices")):
        item = as_dict(item)
        message_body = as_dict(item.get("message"))
        calls = []
        for call in as_list(message_body.get("tool_calls")):
            call = as_dict(call)
            function = as_dict(call.get("function") or call.get("custom"))
            arguments = function.get("arguments", function.get("input"))
            calls.append(
                ToolCall(
                    text_of(call.get("id", MISSING)),
                    text_of(function.get("name", MISSING)),
                    tool_arguments(arguments),
                )
            )
        legacy = as_dict(message_body.get("function_call"))
        if legacy:
            calls.append(
                ToolCall(
                    "",
                    text_of(legacy.get("name", MISSING)),
                    tool_arguments(legacy.get("arguments")),
                )
            )
        finish = as_str(item.get("finish_reason"))
        limited = protocol_finish(finish) in ("length", "content_filter")
        text = message_body.get("content")
        choices.append(
            Choice(
                text if isinstance(text, str) else "", finish, calls, bool(calls) and not limited
            )
        )
    return choices or [Choice("", None, [], False)]


def parse_responses(body: JsonObject) -> list[Choice]:
    output = as_list(body.get("output"))
    texts = [
        text_of(part.get("text", MISSING))
        for item in map(as_dict, output)
        if item.get("type") == "message"
        for part in map(as_dict, as_list(item.get("content")))
        if part.get("type") == "output_text"
    ]
    status = as_str(body.get("status"))
    finish = status
    if status == "incomplete":
        finish = as_str(as_dict(body.get("incomplete_details")).get("reason")) or status
    calls = [responses_tool_call(item) for item in responses_tool_items(output)]
    limited = protocol_finish(finish) in ("length", "content_filter")
    return [Choice("".join(texts), finish, calls, bool(calls) and not limited)]


def parse_messages(body: JsonObject) -> list[Choice]:
    blocks = [as_dict(block) for block in as_list(body.get("content"))]
    text = "".join(
        text_of(block.get("text", MISSING)) for block in blocks if block.get("type") == "text"
    )
    calls = [
        ToolCall(
            text_of(block.get("id", MISSING)),
            text_of(block.get("name", MISSING)),
            canonical_json(block.get("input", {})),
        )
        for block in blocks
        if block.get("type") == "tool_use"
    ]
    finish = as_str(body.get("stop_reason"))
    limited = protocol_finish(finish) in ("length", "content_filter")
    tool_end = (bool(calls) or finish == "pause_turn") and not limited
    return [Choice(text, finish, calls, tool_end)]


USAGE_FIELDS = {
    "chat-completions": (
        "prompt_tokens",
        "prompt_tokens_details",
        "completion_tokens",
        "completion_tokens_details",
    ),
    "responses": ("input_tokens", "input_tokens_details", "output_tokens", "output_tokens_details"),
}


def usage_of(api: str, body: JsonObject) -> tuple[dict[str, int] | None, bool]:
    """The protocol buckets of the response's usage, and whether input came out negative
    (data-model §Usage Buckets)."""
    usage = body.get("usage")
    if not isinstance(usage, dict):
        return None, False
    buckets: dict[str, int] = {}
    if api == "messages":
        names = {
            "input": usage.get("input_tokens"),
            "cachedInput": usage.get("cache_read_input_tokens"),
            "cacheWrite": usage.get("cache_creation_input_tokens"),
            "output": usage.get("output_tokens"),
            "reasoning": as_dict(usage.get("output_tokens_details")).get("thinking_tokens"),
        }
        buckets = {
            name: count for name, value in names.items() if (count := as_count(value)) is not None
        }
        return buckets, False
    total_name, input_details, output_name, output_details = USAGE_FIELDS[api]
    details = as_dict(usage.get(input_details))
    cached, written = (
        as_count(details.get("cached_tokens")),
        as_count(details.get("cache_write_tokens")),
    )
    total = as_count(usage.get(total_name))
    negative = False
    if total is not None:
        uncached = total - (cached or 0) - (written or 0)
        negative = uncached < 0
        buckets["input"] = max(uncached, 0)
    for name, value in (
        ("cachedInput", cached),
        ("cacheWrite", written),
        ("output", as_count(usage.get(output_name))),
        ("reasoning", as_count(as_dict(usage.get(output_details)).get("reasoning_tokens"))),
    ):
        if value is not None:
            buckets[name] = value
    return buckets, negative


PARSERS: dict[str, Callable[[JsonObject], list[Choice]]] = {
    "chat-completions": parse_chat,
    "responses": parse_responses,
    "messages": parse_messages,
}


def parse_body(api: str, body: JsonObject) -> Parsed:
    usage, negative = usage_of(api, body)
    if api == "chat-completions":
        first = as_dict(next(iter(as_list(body.get("choices"))), None))
        output: list[Any] = [first.get("message")] if first else []
    elif api == "responses":
        output = as_list(body.get("output"))
    else:
        output = as_list(body.get("content"))
    status = as_str(body.get("status")) if api == "responses" else None
    error = (as_dict(body.get("error")) or None) if status == "failed" else None
    return Parsed(
        PARSERS[api](body),
        usage,
        negative,
        as_str(body.get("model")),
        as_str(body.get("id")),
        status,
        output,
        error,
    )


# --- SSE copies (helper-api §Reading Response Bodies, §End Events) -------------------------


@dataclass
class StreamMarks:
    """What the end markers of an SSE copy said. Only end markers are read, never content."""

    end_event: str | None = None  # "normal" or "failure"
    generation_end: bool = False
    tool_end: bool = False
    failure_error: JsonObject | None = None
    response_id: str | None = None
    output_items: list[Any] | None = None


class SseReader:
    """Splits an SSE copy into events by the HTML standard's event-stream rules and reads the
    markers of helper-api §End Events."""

    def __init__(self, api: str, choices: int) -> None:
        self.api = api
        self.choices = max(choices, 1)
        self.marks = StreamMarks()
        self.buffer = ""
        self.pending_cr = False
        self.event = ""
        self.data: list[str] = []
        self.finished: dict[int, str] = {}
        self.decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self.started = False

    def feed(self, data: bytes) -> None:
        text = self.decoder.decode(data)
        if not self.started and text:
            # helper-api §Reading Response Bodies: one leading U+FEFF is removed.
            self.started = True
            text = text[1:] if text.startswith("\ufeff") else text
        self.buffer += text
        for line in self.complete_lines():
            self.line(line)

    def complete_lines(self) -> Iterator[str]:
        text = self.buffer
        if self.pending_cr and text.startswith("\n"):
            text = text[1:]
        self.pending_cr = False
        start = 0
        index = 0
        while index < len(text):
            char = text[index]
            if char in "\r\n":
                yield text[start:index]
                if char == "\r":
                    if index + 1 == len(text):
                        self.pending_cr = True
                    elif text[index + 1] == "\n":
                        index += 1
                start = index + 1
            index += 1
        self.buffer = text[start:]

    def finish(self) -> None:
        """The body ended without a read error: the last line without a line end counts, and a
        last event without a trailing empty line counts when its `data` is complete."""
        self.buffer += self.decoder.decode(b"", final=True)
        for line in self.complete_lines():
            self.line(line)
        if self.buffer:
            self.line(self.buffer)
            self.buffer = ""
        if self.data:
            data = "\n".join(self.data)
            if data == "[DONE]" or read_json_or_none(data) is not None:
                self.dispatch()
            self.event, self.data = "", []

    def line(self, line: str) -> None:
        if line == "":
            if self.data:
                self.dispatch()
            self.event, self.data = "", []
            return
        if line.startswith(":"):
            return
        name, _, value = line.partition(":")
        value = value[1:] if value.startswith(" ") else value
        if name == "event":
            self.event = value
        elif name == "data":
            self.data.append(value)

    def dispatch(self) -> None:
        if self.marks.end_event is not None:
            return
        data = "\n".join(self.data)
        if self.api == "chat-completions" and data == "[DONE]":
            self.end("normal")
            return
        payload = read_json_or_none(data)
        if not isinstance(payload, dict):
            return
        if self.api == "chat-completions":
            self.chat_event(payload)
        elif self.api == "responses":
            self.responses_event(payload)
        else:
            self.messages_event(payload)

    def end(self, kind: str, error: JsonObject | None = None) -> None:
        self.marks.end_event = kind
        if kind == "normal":
            self.marks.generation_end = True
        else:
            self.marks.failure_error = error

    def chat_event(self, payload: JsonObject) -> None:
        if self.event == "error":
            self.end("failure", as_dict(payload.get("error")) or event_error(payload))
            return
        if payload.get("error") is not None:
            self.end("failure", as_dict(payload.get("error")))
            return
        for choice in map(as_dict, as_list(payload.get("choices"))):
            reason = as_str(choice.get("finish_reason"))
            index = as_count(choice.get("index"))
            if reason is not None:
                self.finished[index if index is not None else 0] = reason
        if len(self.finished) >= self.choices and not self.marks.generation_end:
            self.marks.generation_end = True
            tool_reasons = ("tool_calls", "function_call")
            self.marks.tool_end = all(reason in tool_reasons for reason in self.finished.values())

    def responses_event(self, payload: JsonObject) -> None:
        kind = payload.get("type")
        if kind in ("response.completed", "response.incomplete"):
            response = as_dict(payload.get("response"))
            output = as_list(response.get("output"))
            self.marks.response_id = as_str(response.get("id"))
            self.marks.output_items = output
            self.marks.tool_end = kind == "response.completed" and bool(
                responses_tool_items(output)
            )
            self.end("normal")
        elif kind == "response.failed":
            self.end("failure", as_dict(as_dict(payload.get("response")).get("error")))
        elif kind == "error" or self.event == "error":
            nested = as_dict(payload.get("error"))
            self.end("failure", nested or event_error(payload))

    def messages_event(self, payload: JsonObject) -> None:
        kind = payload.get("type")
        if kind == "message_stop":
            self.end("normal")
        elif kind == "message_delta":
            reason = as_str(as_dict(payload.get("delta")).get("stop_reason"))
            if reason is not None and not self.marks.generation_end:
                self.marks.generation_end = True
                self.marks.tool_end = reason in ("tool_use", "pause_turn")
        elif kind == "error" or self.event == "error":
            self.end("failure", as_dict(payload.get("error")) or event_error(payload))


def event_error(payload: JsonObject) -> JsonObject:
    """An `error` event without a nested `error`: the event itself, whose own `type` names the
    event and is not an error type (helper-api §Error Classification)."""
    error: JsonObject = {name: payload[name] for name in ("code", "message") if name in payload}
    if payload.get("type") not in (None, "error"):
        error["type"] = payload["type"]
    return error


# --- Error classification (helper-api §Error Classification, §Transport Exceptions) -------

QUOTA_CODES = frozenset(
    {
        "credit_balance_exhausted",
        "organization_spend_limit_exceeded",
        "project_spend_limit_exceeded",
        "organization_usage_limit_exceeded",
        "usage_limit_exceeded",
        "billing_not_active",
    }
)
ACCOUNT_CODES = frozenset(
    {
        "enforced_spend_limit_reached",
        "organization_on_hold",
        "claude_code_key_creator_not_member",
        "claude_code_version_too_old",
        "cmek_key_disabled",
        "cmek_key_network_blocked",
        "skill_read_blocked_undecryptable",
    }
)
TRANSIENT_FAILURE_CODES = frozenset(
    {
        "server_error",
        "rate_limit_exceeded",
        "api_error",
        "overloaded_error",
        "rate_limit_error",
        "timeout_error",
    }
)
BILLING_PHRASES = ("credit balance", "usage limit")
# The transport kinds of a failure without a status code, as `ModelCallError(kind=)` names them.
CONNECT, TLS, DISCONNECT, TIMEOUT = "connect", "tls", "disconnect", "timeout"
TRANSPORT_KINDS = {CONNECT: "transient", TLS: "config", DISCONNECT: "transient", TIMEOUT: "timeout"}
# helper-api §Transport Exceptions: the classes, by the module that defines them, whose
# exceptions (or subclasses) mean the request never reached the server. The SDK-facing httpx and
# httpx2 classes are never used, because backends map other failures onto them (aiohttp's dropped
# connection becomes httpx.ConnectTimeout).
NOT_REACHED_CLASSES = {
    "httpcore": frozenset({"ConnectError", "ConnectTimeout", "PoolTimeout", "WriteTimeout"}),
    "httpcore2": frozenset({"ConnectError", "ConnectTimeout", "PoolTimeout", "WriteTimeout"}),
    "aiohttp": frozenset({"ClientConnectorError", "ConnectionTimeoutError"}),
    "builtins": frozenset({"ConnectionRefusedError"}),
    "socket": frozenset({"gaierror"}),
}


@dataclass(frozen=True)
class ErrorObject:
    """The `type`, code and `message` of a provider error object."""

    type: str | None = None
    code: str | None = None
    message: str | None = None

    @staticmethod
    def of(value: JsonObject | None) -> ErrorObject:
        if not value:
            return ErrorObject()
        code = as_str(value.get("code")) or as_str(as_dict(value.get("details")).get("error_code"))
        return ErrorObject(as_str(value.get("type")), code, as_str(value.get("message")))


def classify(status: int | None, error: ErrorObject, transport: str | None) -> str:
    """The error kind of a failure: an error response's status (200 for a response that ended
    in failure) with its error object, or a transport kind. The first matching row decides."""
    if status is None:
        return TRANSPORT_KINDS.get(transport or DISCONNECT, "transient")
    failed_ok = status == 200
    names = {error.type, error.code}
    if (status == 429 or failed_ok) and (
        "insufficient_quota" in names or error.code in QUOTA_CODES
    ):
        return "config"
    if (status in (429, 400, 409) or failed_ok) and error.code in ACCOUNT_CODES:
        return "config"
    if status == 404 and error.code == "thread_not_found":
        return "permanent"
    if status in (401, 402, 403, 404):
        return "config"
    text = (error.message or "").lower()
    if (status == 400 or failed_ok) and (
        error.type == "billing_error" or any(phrase in text for phrase in BILLING_PHRASES)
    ):
        return "config"
    if status == 429 or 500 <= status <= 599 or status == 408:
        return "transient"
    if failed_ok and names & TRANSIENT_FAILURE_CODES:
        return "transient"
    return "permanent"


def exception_chain(error: BaseException) -> list[BaseException]:
    """The exception, its `__cause__` chain and the exceptions inside each one's `args`;
    `__context__` is not followed (research R9)."""
    found: list[BaseException] = []
    pending = [error]
    while pending:
        current = pending.pop(0)
        if any(current is seen for seen in found):
            continue
        found.append(current)
        if current.__cause__ is not None:
            pending.append(current.__cause__)
        pending.extend(arg for arg in current.args if isinstance(arg, BaseException))
    return found


def is_timeout(error: BaseException) -> bool:
    return isinstance(error, (TimeoutError, asyncio.TimeoutError, socket.timeout))


def never_reached(error: BaseException) -> bool:
    """The exception's class or a base class is one of `NOT_REACHED_CLASSES`."""
    for cls in type(error).__mro__:
        names = NOT_REACHED_CLASSES.get(cls.__module__.split(".")[0], frozenset())
        if cls.__name__ in names:
            return True
    return False


def transport_kind(error: BaseException) -> str:
    """The kind of a request that failed before its response headers."""
    chain = exception_chain(error)
    if any(isinstance(item, ssl.SSLCertVerificationError) for item in chain):
        return TLS
    if any(never_reached(item) for item in chain):
        return CONNECT
    if any(is_timeout(item) for item in chain):
        return TIMEOUT
    return DISCONNECT


# --- Captured calls (data-model §Captured Call, §When a Call Ended, §Call Outcome) ----------


@dataclass
class Failure:
    """How a call failed: an error response (`status`, 200 for a response that ended in
    failure) or a failure without a status code (`transport`)."""

    ended_at: float
    status: int | None = None
    transport: str | None = None
    error: JsonObject | None = None
    retry_after_ms: int | None = None
    usage: dict[str, int] | None = None
    text: str = ""
    # A non-stream 2xx body read to the end that is not a JSON object.
    not_json: bool = False
    # A request URL without an http or https scheme, never sent.
    bad_scheme: bool = False


class CapturedCall:
    """One captured request and what the service read of its response. Every field changes
    under `HUB.lock`, because synchronous clients run in worker threads."""

    def __init__(self, api: str, body: JsonObject, sent_at: float) -> None:
        self.api = api
        self.body = body
        self.model = str(body["model"])
        self.sent_at = sent_at
        self.tools: Any = body.get("tools")
        self.trial: Trial | None = None
        self.notify = False
        self.headers_at: float | None = None
        self.status: int | None = None
        self.headers: dict[str, str] = {}
        self.sse = False
        self.copy = bytearray()
        self.decoder: Any = None
        self.decoding = True
        self.reader: SseReader | None = None
        self.body_done = False
        self.body_closed = False
        self.closed_during_read = False
        self.reading = 0
        self.reads_after_close = 0
        self.last_read_at: float | None = None
        self.generation_end_at: float | None = None
        self.parsed: Parsed | None = None
        self.failure: Failure | None = None
        self.cut = False
        # The asyncio task awaiting the request or a read of its body, held weakly so that a
        # finished task is still collected and its unhandled exception reported (L2, L3), and
        # whether the helper cancelled that task to cut the call on the tool's `cancel`.
        self.task: weakref.ref[asyncio.Task[Any]] | None = None
        self.cutting = False
        self.ended_at: float | None = None
        self.record_sent = False
        # Answered with the render-mode 400 instead of being sent.
        self.render_only = False

    # Request side

    @functools.cached_property
    def messages(self) -> list[JsonObject]:
        return render_messages(self.api, self.body)

    @functools.cached_property
    def system(self) -> list[str]:
        return system_of(self.messages)

    @functools.cached_property
    def key(self) -> str:
        return request_key(self.body)

    def failed_before_headers(self, error: BaseException) -> None:
        with HUB.lock:
            self.mark_abandoned(error)
            if self.ended():
                return
            now = time.monotonic()
            if isinstance(error, asyncio.CancelledError):
                self.fail(Failure(now, transport=TIMEOUT, text="The request was cancelled."))
                return
            kind = transport_kind(error)
            self.fail(Failure(now, transport=kind, text=exception_text(error)))

    def got_headers(self, response: Any) -> None:
        with HUB.lock:
            now = time.monotonic()
            self.headers_at = now
            self.status = int(response.status_code)
            self.headers = {str(k).lower(): str(v) for k, v in response.headers.items()}
            content_type = self.headers.get("content-type", "")
            self.sse = content_type.split(";")[0].strip().lower() == "text/event-stream"
            self.decoder = fresh_decoder(response)
            self.decoding = self.decoder is not None
            if self.sse:
                self.reader = SseReader(self.api, as_count(self.body.get("n")) or 1)
            if self.status >= 400 and not self.ended():
                retry = retry_after_ms(self.headers)
                self.fail(Failure(now, status=self.status, retry_after_ms=retry))

    # Body side

    def read_started(self) -> None:
        with HUB.lock:
            if self.body_closed:
                self.reads_after_close += 1
            self.reading += 1

    def read_returned(self) -> bool:
        """Ends one read; whether it started after the body was closed."""
        self.reading -= 1
        if self.reads_after_close and self.body_closed:
            self.reads_after_close -= 1
            return True
        return False

    def received(self, chunk: bytes) -> None:
        with HUB.lock:
            self.read_returned()
            now = time.monotonic()
            self.last_read_at = now
            if not self.copying():
                return
            try:
                data = joined(self.decoder.decode(chunk))
            except Exception:
                self.decoding = False
                return
            self.copy.extend(data)
            if self.reader is not None and not self.error_status():
                self.reader.feed(data)
                self.marks_read(now)

    def copying(self) -> bool:
        """Whether a chunk still belongs in the copy: error bodies are kept for classification;
        otherwise nothing after the call ended counts."""
        if self.cut or self.body_done or not self.decoding:
            return False
        if self.error_status():
            return True
        if self.failure is not None:
            return False
        return self.reader is None or self.reader.marks.end_event is None

    def error_status(self) -> bool:
        return self.status is not None and self.status >= 400

    def marks_read(self, now: float) -> None:
        """Applies the end markers the SSE copy holds so far (helper-api §End Events)."""
        assert self.reader is not None
        marks = self.reader.marks
        if marks.generation_end and self.generation_end_at is None:
            self.generation_end_at = now
            HUB.call_changed(self)
        if marks.end_event == "failure" and self.failure is None:
            error = marks.failure_error or {}
            self.fail(Failure(now, status=200, error=error, text=failure_text(error)))

    def read_finished(self) -> None:
        """The body was read to its end without a read error."""
        with HUB.lock:
            self.read_returned()
            if self.cut or self.body_done:
                return
            self.body_done = True
            now = time.monotonic()
            if self.decoding:
                try:
                    self.copy.extend(joined(self.decoder.flush()))
                except Exception:
                    self.decoding = False
            if self.error_status() or self.failure is not None:
                return
            if self.reader is None:
                self.body_complete(now)
                return
            if self.decoding and self.reader.marks.end_event is None:
                self.reader.finish()
                self.marks_read(now)
                if self.reader.marks.end_event is None and self.failure is None:
                    text = "The stream ended without an end event."
                    self.fail(Failure(now, transport=DISCONNECT, text=text))
            HUB.call_changed(self)

    def body_complete(self, now: float) -> None:
        self.ended_at = now
        body = read_json_or_none(body_text(self.copy)) if self.decoding else None
        if self.decoding and not isinstance(body, dict):
            # helper-api §Reading Response Bodies, item 4: not an API response at all.
            self.fail(Failure(now, status=200, not_json=True, text=message("F1")))
            return
        if isinstance(body, dict) and body.get("error") is not None:
            # helper-api §Reading Response Bodies item 4: a top-level `error` ends the response
            # in failure, classified by that error object.
            error = as_dict(body["error"])
            usage, _ = usage_of(self.api, body)
            self.fail(Failure(now, status=200, error=error, usage=usage, text=failure_text(error)))
            return
        if isinstance(body, dict):
            self.parsed = parse_body(self.api, body)
            if self.parsed.status == "failed":
                error = self.parsed.error or {}
                usage = self.parsed.usage
                self.fail(
                    Failure(now, status=200, error=error, usage=usage, text=failure_text(error))
                )
                return
        HUB.call_changed(self)

    def error_object(self) -> JsonObject | None:
        """The error object of an error response whose body was read to its end."""
        if self.failure is not None and self.failure.error is not None:
            return self.failure.error
        if not self.error_status() or not self.body_done or not self.decoding:
            return None
        body = as_dict(read_json_or_none(body_text(self.copy)))
        return as_dict(body.get("error")) or body or None

    def read_failed(self, error: BaseException) -> None:
        with HUB.lock:
            self.mark_abandoned(error)
            after_close = self.read_returned()
            if after_close or self.ended_by_body() or isinstance(error, GeneratorExit):
                return
            now = time.monotonic()
            cancelled = isinstance(error, asyncio.CancelledError) or self.closed_during_read
            if cancelled:
                if self.generation_end_at is None:
                    self.fail(Failure(now, transport=TIMEOUT, text="The request was cancelled."))
                return
            timed_out = any(is_timeout(item) for item in exception_chain(error))
            kind = TIMEOUT if timed_out and self.sse else DISCONNECT
            self.fail(Failure(now, transport=kind, text=exception_text(error)))

    def closing(self) -> None:
        with HUB.lock:
            self.body_closed = True
            if self.awaited_reads() > 0:
                self.closed_during_read = True

    def awaited_reads(self) -> int:
        """Reads in progress that started before the body was closed or cancelled. A read
        started after that and ended by it is not an awaited read (helper-api §Reading Response
        Bodies)."""
        return self.reading - self.reads_after_close

    # State

    def fail(self, failure: Failure) -> None:
        self.failure = failure
        self.ended_at = failure.ended_at
        HUB.call_changed(self)

    def ended(self) -> bool:
        return self.cut or self.failure is not None

    def ended_by_body(self) -> bool:
        """No later chunk or error changes the call: it failed, was cut, its body was read to the
        end, or its SSE copy received an end event."""
        if self.cut or self.failure is not None or self.body_done:
            return True
        return self.reader is not None and self.reader.marks.end_event is not None

    def in_flight(self) -> bool:
        """A request without a response, or a body with a waiting reader."""
        if self.ended():
            return False
        if self.headers_at is None:
            return True
        if self.sse and self.generation_end_at is not None:
            return False
        return self.awaited_reads() > 0 and not self.ended_by_body()

    def finished(self) -> bool:
        """Ended for a `calls` notification: failed, cut, read to its end, or an SSE copy with
        its generation-end marker."""
        return self.ended() or self.body_done or self.generation_end_at is not None

    def cut_now(self) -> None:
        self.cut = True
        self.ended_at = time.monotonic()

    def awaited(self) -> None:
        """Records the task about to await the request or a read of its body."""
        task = asyncio.current_task()
        with HUB.lock:
            self.task = None if task is None else weakref.ref(task)

    def mark_abandoned(self, error: BaseException) -> None:
        """An exception of a request the helper cut on `cancel` is logged as L3 when it ends
        background work (helper-api §Cancel)."""
        if self.cut:
            setattr(error, ABANDONED, True)


def body_text(data: bytes | bytearray) -> str:
    """A response body as text: UTF-8, then one leading U+FEFF removed (helper-api §Reading
    Response Bodies)."""
    text = bytes(data).decode("utf-8", "replace")
    return text[1:] if text.startswith("\ufeff") else text


def fresh_decoder(response: Any) -> Any:
    """A new decoder of the kind the response uses for its `Content-Encoding`; the response's
    own decoder belongs to the SDK. None when the response type offers none."""
    try:
        blank = type(response)(response.status_code, headers=response.headers)
        return blank._get_content_decoder()
    except Exception:
        return None


def joined(decoded: Any) -> bytes:
    """A decoder's output: bytes from httpx, an iterable of bytes from httpx2."""
    return decoded if isinstance(decoded, bytes) else b"".join(decoded)


def failure_text(error: JsonObject) -> str:
    return as_str(error.get("message")) or "The response ended in failure."


# --- Capture (helper-api §Captured Requests, §Reading Response Bodies) --------------------

TRANSPORT_MODULES = ("httpx", "httpx2")
WRAPPED = "_model_eval_original"
# Marks an exception of a request the helper cut on `cancel` or blocked after it (L3).
ABANDONED = "_model_eval_abandoned"


def captured_body(request: Any) -> tuple[str, JsonObject] | None:
    """The API and JSON body of a request the helper captures, or None to pass it through."""
    if str(request.method).upper() != "POST":
        return None
    api = api_of_path(str(request.url.path))
    if api is None:
        return None
    try:
        content = request.content
    except Exception:
        return None
    body = read_json_or_none(bytes(content).decode("utf-8", "replace"))
    if not isinstance(body, dict) or not isinstance(body.get("model"), str) or not body["model"]:
        return None
    return api, body


RENDER_ONLY_TEXT = "Render mode sends no model request."


def render_only_response(module: ModuleType, request: Any, api: str) -> Any:
    """helper-api §Render Mode: the provider-shaped HTTP 400 `render_only` a captured request
    gets instead of being sent. It has no `x-should-retry` header, and the SDKs do not resend
    400."""
    error = {"type": "render_only", "message": RENDER_ONLY_TEXT}
    body: JsonObject = (
        {"type": "error", "error": error}
        if api == "messages"
        else {"error": {**error, "param": None, "code": None}}
    )
    headers = {"content-type": "application/json"}
    content = canonical_json(body).encode("utf-8")
    return module.Response(400, headers=headers, content=content, request=request)


def has_http_scheme(request: Any) -> bool:
    return str(request.url.scheme).lower() in ("http", "https")


def scheme_error(module: ModuleType, request: Any, call: CapturedCall) -> BaseException:
    """helper-api §Transport Exceptions, URL scheme: the request is not sent, the call fails
    as never arrived (`config`, not billed), and the SDK gets the transport's connect error."""
    text = message("F3")
    with HUB.lock:
        call.fail(Failure(time.monotonic(), transport=CONNECT, bad_scheme=True, text=text))
    error: BaseException = module.ConnectError(text, request=request)
    return error


def blocked_error(module: ModuleType, request: Any) -> BaseException:
    """The error of a request blocked after `cancel`: the transport's own "never arrived"."""
    error: BaseException = module.ConnectError(
        "The tool cancelled this trial, so the request was not sent.", request=request
    )
    setattr(error, ABANDONED, True)
    return error


def cut_error(module: ModuleType, request: Any) -> BaseException:
    """helper-api §Cancel: the error the service's SDK gets for a request the helper cut in a
    task other than the trial's own, which the helper cancelled for that. The cancellation is
    the helper's, so it is taken back and the request fails like a dropped connection."""
    task = asyncio.current_task()
    uncancel = getattr(task, "uncancel", None)
    if uncancel is not None:
        uncancel()
    error: BaseException = module.ReadError(
        "The tool cancelled this trial, so the request was cut.", request=request
    )
    setattr(error, ABANDONED, True)
    return error


def quietly(action: Callable[..., None], *arguments: Any) -> None:
    """Runs the helper's own bookkeeping of a request; a failure in it is printed to stderr
    and never reaches the service, whose SDK must see what it sees without the helper."""
    try:
        action(*arguments)
    except Exception:
        traceback.print_exc()


def stream_classes(module: ModuleType) -> tuple[type, type]:
    """Byte streams that copy what the SDK reads, as subclasses of the module's own stream
    types so its `Response` accepts them."""

    class CopyingStream(module.SyncByteStream):  # type: ignore[misc, name-defined]
        def __init__(self, original: Any, call: CapturedCall) -> None:
            self.original = original
            self.call = call

        def __iter__(self) -> Iterator[bytes]:
            chunks = iter(self.original)
            while True:
                quietly(self.call.read_started)
                try:
                    chunk = next(chunks)
                except StopIteration:
                    quietly(self.call.read_finished)
                    return
                except BaseException as error:
                    quietly(self.call.read_failed, error)
                    raise
                quietly(self.call.received, chunk)
                yield chunk

        def close(self) -> None:
            quietly(self.call.closing)
            self.original.close()

    class AsyncCopyingStream(module.AsyncByteStream):  # type: ignore[misc, name-defined]
        def __init__(self, original: Any, call: CapturedCall) -> None:
            self.original = original
            self.call = call

        async def __aiter__(self) -> Any:
            chunks = self.original.__aiter__()
            while True:
                quietly(self.call.read_started)
                quietly(self.call.awaited)
                try:
                    chunk = await chunks.__anext__()
                except StopAsyncIteration:
                    quietly(self.call.read_finished)
                    return
                except BaseException as error:
                    quietly(self.call.read_failed, error)
                    if self.call.cutting and isinstance(error, asyncio.CancelledError):
                        raise cut_error(module, None) from None
                    raise
                quietly(self.call.received, chunk)
                yield chunk

        async def aclose(self) -> None:
            quietly(self.call.closing)
            await self.original.aclose()

    return CopyingStream, AsyncCopyingStream


def sync_send(module: ModuleType, original: Callable[..., Any]) -> Callable[..., Any]:
    copying, _ = stream_classes(module)

    def send(client: Any, request: Any, *, stream: bool = False, **options: Any) -> Any:
        found = captured_body(request)
        if found is None:
            return original(client, request, stream=stream, **options)
        call = HUB.start(found[0], found[1])
        if call is None:
            raise blocked_error(module, request)
        if call.render_only:
            return render_only_response(module, request, call.api)
        if not has_http_scheme(request):
            raise scheme_error(module, request, call)
        try:
            response = original(client, request, stream=True, **options)
        except BaseException as error:
            quietly(call.failed_before_headers, error)
            raise
        quietly(call.got_headers, response)
        response.stream = copying(response.stream, call)
        if not stream:
            try:
                response.read()
            except BaseException:
                response.close()
                raise
        return response

    setattr(send, WRAPPED, original)
    return send


def async_send(module: ModuleType, original: Callable[..., Any]) -> Callable[..., Any]:
    _, copying = stream_classes(module)

    async def send(client: Any, request: Any, *, stream: bool = False, **options: Any) -> Any:
        found = captured_body(request)
        if found is None:
            return await original(client, request, stream=stream, **options)
        call = HUB.start(found[0], found[1])
        if call is None:
            raise blocked_error(module, request)
        if call.render_only:
            return render_only_response(module, request, call.api)
        if not has_http_scheme(request):
            raise scheme_error(module, request, call)
        quietly(call.awaited)
        try:
            response = await original(client, request, stream=True, **options)
        except BaseException as error:
            quietly(call.failed_before_headers, error)
            if call.cutting and isinstance(error, asyncio.CancelledError):
                raise cut_error(module, request) from None
            raise
        quietly(call.got_headers, response)
        response.stream = copying(response.stream, call)
        if not stream:
            try:
                await response.aread()
            except BaseException:
                await response.aclose()
                raise
        return response

    setattr(send, WRAPPED, original)
    return send


def wrap_transport(module: ModuleType) -> None:
    """Wraps `Client.send` and `AsyncClient.send` of an httpx-like module at class level, once
    per class even when two module names point to the same classes."""
    for name, wrapper in (("Client", sync_send), ("AsyncClient", async_send)):
        cls = getattr(module, name, None)
        original = getattr(cls, "send", None) if cls is not None else None
        if original is None or hasattr(original, WRAPPED):
            continue
        cls.send = wrapper(module, original)  # type: ignore[union-attr]


class WrapAfterLoad(importlib.abc.Loader):
    """Runs the real loader, then wraps the module's clients."""

    def __init__(self, loader: importlib.abc.Loader) -> None:
        self.loader = loader

    def create_module(self, spec: importlib.machinery.ModuleSpec) -> ModuleType | None:
        return self.loader.create_module(spec)

    def exec_module(self, module: ModuleType) -> None:
        self.loader.exec_module(module)
        wrap_transport(module)


class TransportFinder(importlib.abc.MetaPathFinder):
    """Import hook for `httpx` and `httpx2` loaded after the helper (helper-api §When)."""

    def find_spec(
        self, fullname: str, path: Sequence[str] | None, target: ModuleType | None = None
    ) -> importlib.machinery.ModuleSpec | None:
        if fullname not in TRANSPORT_MODULES:
            return None
        for finder in sys.meta_path:
            if finder is self or not hasattr(finder, "find_spec"):
                continue
            spec = finder.find_spec(fullname, path, target)
            if spec is not None:
                if spec.loader is not None and hasattr(spec.loader, "exec_module"):
                    spec.loader = WrapAfterLoad(spec.loader)
                return spec
        return None


def install_capture() -> None:
    for name in TRANSPORT_MODULES:
        if name in sys.modules:
            wrap_transport(sys.modules[name])
    sys.meta_path.insert(0, TransportFinder())


# --- Trial contexts (helper-api §Trial Context; data-model §Outside the Trial Context,
# §After the Function Returned) -------------------------------------------------------------

CURRENT_TRIAL: contextvars.ContextVar[Trial | None] = contextvars.ContextVar(
    "model_eval_trial", default=None
)
# data-model §Unfinished Calls: the wait keeps this much of the tool's time limit.
KEPT_MS = 5000
POLL_S = 0.01


class Trial:
    """One `generate` request and the calls of its context."""

    def __init__(
        self, request_id: int, target: Target, case: Case, variant: Variant, timeout_ms: int
    ) -> None:
        self.request_id = request_id
        self.target = target
        self.case = case
        self.variant = variant
        self.timeout_ms = timeout_ms
        self.started = time.monotonic()
        self.function_ended_at: float | None = None
        # running: the function runs; waiting: it returned and unfinished calls are awaited;
        # sent: the result was sent.
        self.state = "running"
        self.calls: list[CapturedCall] = []
        self.cancelled = False
        # Cancelled as an asynchronous function: an async target, or a sync one whose returned
        # awaitable is being awaited (helper-api §Cancel).
        self.asynchronous = target.is_async
        self.outside_context = False
        self.task: asyncio.Future[Any] | None = None
        # A `render` request (helper-api §Render Mode): no captured request is sent.
        self.rendering = case.rendering

    def deadline(self) -> float:
        """When the wait for unfinished calls ends: the tool's time limit minus the time spent,
        keeping 5 s for the result to reach the tool."""
        return self.started + (self.timeout_ms - KEPT_MS) / 1000


class Hub:
    """Where captured requests find their trial. The wrappers sit at class level, so they reach
    the running adapter through this one object."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.server: Server | None = None
        self.trials: dict[int, Trial] = {}
        # Calls reported as `calls` notifications: late requests and requests of no trial.
        self.notified: list[CapturedCall] = []

    def attach(self, server: Server, loop: asyncio.AbstractEventLoop) -> None:
        with self.lock:
            self.server, self.loop = server, loop

    def detach(self) -> None:
        with self.lock:
            self.server, self.loop = None, None

    def start(self, api: str, body: JsonObject) -> CapturedCall | None:
        """Registers a captured request; None when it must not be sent (its trial was
        cancelled, helper-api §Cancel)."""
        with self.lock:
            call = CapturedCall(api, body, time.monotonic())
            if self.server is None:
                return call
            trial = CURRENT_TRIAL.get()
            if trial is None:
                trial = self.trial_without_context(call)
            if trial is not None and trial.rendering:
                # Render mode: the request gets the render-mode 400 and, while the render runs,
                # is one of its calls, a request outside every context that joined it included.
                call.render_only = True
                if trial.state == "running":
                    trial.calls.append(call)
                return call
            if call.render_only:
                return call
            if trial is not None and trial.cancelled:
                return None
            call.trial = trial
            if trial is not None and trial.state == "running":
                trial.calls.append(call)
            else:
                call.notify = True
                self.notified.append(call)
            return call

    def trial_without_context(self, call: CapturedCall) -> Trial | None:
        """data-model §Outside the Trial Context: the one trial in progress (a running render
        included); with two or more, all of them end as A10, and the request gets the render-mode
        400 when one is a render; with none, the one trial waiting to send its result."""
        running = [trial for trial in self.trials.values() if trial.state == "running"]
        if len(running) == 1:
            return running[0]
        if running:
            for trial in running:
                trial.outside_context = True
            call.render_only = any(trial.rendering for trial in running)
            return None
        waiting = [trial for trial in self.trials.values() if trial.state == "waiting"]
        return waiting[0] if len(waiting) == 1 else None

    def call_changed(self, call: CapturedCall) -> None:
        if not call.notify or not call.finished() or self.loop is None:
            return
        server = self.server
        if server is not None:
            self.loop.call_soon_threadsafe(server.flush_notifications)

    def unreported(self, force: bool = False) -> list[CapturedCall]:
        """Notified calls whose notification can go out now: finished (or all, with `force`),
        and their trial's result already sent."""
        with self.lock:
            ready = [
                call
                for call in self.notified
                if not call.record_sent
                and (
                    force
                    or (call.finished() and (call.trial is None or call.trial.state == "sent"))
                )
            ]
            for call in ready:
                call.record_sent = True
            self.notified = [call for call in self.notified if not call.record_sent]
            return ready


HUB = Hub()


# --- Calls as received (data-model §When a Call Ended, §Unread Response) ------------------

OK, UNREAD, FAILED, UNFINISHED, CUT = "ok", "unread", "failed", "unfinished", "cut"


@dataclass
class Seen:
    """A call as it stood at one moment: when the function returned, which decides the
    outcome, or after the wait for unfinished calls, which gives their records."""

    call: CapturedCall
    state: str
    ended_at: float | None
    failure: Failure | None
    parsed: Parsed | None
    sse: bool
    background: bool
    generation_end: bool
    stream_tool_end: bool
    stream_output: list[Any] | None
    response_id: str | None
    had_headers: bool
    # When the service last read the body, else when the headers arrived.
    read_at: float | None
    error: ErrorObject

    @property
    def kind(self) -> str | None:
        """The failure's error kind (helper-api §Error Classification)."""
        if self.failure is None:
            return None
        if self.failure.not_json or self.failure.bad_scheme:
            return "config"
        return classify(self.failure.status, self.error, self.failure.transport)

    @property
    def outcome(self) -> str:
        """data-model §Call Outcome."""
        if self.state == CUT or (self.state == UNFINISHED and not self.had_headers):
            return "unanswered"
        failure = self.failure
        if self.state != FAILED or failure is None:
            return "ok"
        if failure.usage is not None:
            return "failed"
        if failure.status == 200 or failure.transport in (DISCONNECT, TIMEOUT):
            return "unanswered"
        return "failed"

    def ended_in_tool_call(self) -> bool:
        if self.state == OK and self.parsed is not None and self.parsed.choices:
            return self.parsed.choices[0].tool_end
        return self.sse and self.state == UNREAD and self.stream_tool_end

    def output_items(self) -> list[Any] | None:
        if self.parsed is not None:
            return self.parsed.output_items
        return self.stream_output

    def successful(self) -> bool:
        return self.state in (OK, UNREAD)


def freeze(call: CapturedCall) -> Seen:
    with HUB.lock:
        background = False
        if call.cut:
            state = CUT
        elif call.failure is not None:
            state = FAILED
        elif call.in_flight():
            state = UNFINISHED
        elif call.sse or call.parsed is None:
            state = UNREAD
        elif call.parsed.status in ("queued", "in_progress"):
            state, background = UNREAD, True
        else:
            state = OK
        ended_at = call.ended_at
        if state == UNREAD:
            ended_at = call.generation_end_at or call.last_read_at or call.headers_at
        marks = call.reader.marks if call.reader is not None else StreamMarks()
        return Seen(
            call=call,
            state=state,
            ended_at=ended_at,
            failure=call.failure,
            parsed=call.parsed if state in (OK, UNREAD) else None,
            sse=call.sse,
            background=background,
            generation_end=call.generation_end_at is not None,
            stream_tool_end=marks.tool_end,
            stream_output=marks.output_items,
            response_id=(call.parsed.response_id if call.parsed else None) or marks.response_id,
            had_headers=call.headers_at is not None,
            read_at=call.last_read_at or call.headers_at,
            error=ErrorObject.of(call.error_object()),
        )


def call_record(seen: Seen, branch: str | None, ended_by_return: bool = True) -> JsonObject:
    """The protocol call record (001 data-model §Trial). A call that had not ended when the
    function returned has no `latencyMs` (data-model §When a Call Ended)."""
    call = seen.call
    record: JsonObject = {"model": call.model, "outcome": seen.outcome}
    if seen.parsed is not None:
        if seen.parsed.response_model:
            record["responseModel"] = seen.parsed.response_model
        if seen.parsed.usage is not None and not seen.background:
            record["usage"] = seen.parsed.usage
        finish = seen.parsed.choices[-1].finish_raw if seen.parsed.choices else None
        if finish is not None and not seen.background:
            record["finishReason"] = finish
    if seen.state == FAILED and seen.failure is not None:
        record["errorKind"] = seen.kind
        # helper-api §`retryAfterMs`: only a `transient` call carries the wait.
        if seen.failure.retry_after_ms is not None and seen.kind == "transient":
            record["retryAfterMs"] = seen.failure.retry_after_ms
        if seen.failure.usage is not None:
            record["usage"] = seen.failure.usage
    if branch is not None:
        record["branch"] = branch
    if ended_by_return and seen.ended_at is not None and seen.state not in (UNFINISHED, CUT):
        record["latencyMs"] = milliseconds(seen.ended_at - call.sent_at)
    return record


def milliseconds(seconds: float) -> int:
    return rounded(max(seconds, 0.0) * 1000)


def call_error(seen: Seen) -> JsonObject | None:
    """A failed call's `error` under `ModelCallError`'s names (helper-api §Target Function)."""
    failure = seen.failure
    if seen.state != FAILED or failure is None:
        return None
    error: JsonObject = {}
    if failure.status is not None:
        error["status"] = failure.status
        if seen.error.type is not None:
            error["type"] = seen.error.type
        if seen.error.code is not None:
            error["code"] = seen.error.code
    else:
        error["kind"] = failure.transport
    if failure.retry_after_ms is not None:
        error["retry_after_ms"] = failure.retry_after_ms
    return error


def call_view(seen: Seen, retried: bool | None) -> Call:
    """The `Call` of a seen call; an unfinished call has no response fields."""
    call = seen.call
    tool_names = tool_names_of(call.body)
    view = Call(call.model, call.messages, tool_names)
    view._source = call
    if seen.state == UNFINISHED:
        return view
    first = seen.parsed.choices[0] if seen.parsed is not None and seen.parsed.choices else None
    usage = seen.parsed.usage if seen.parsed is not None else None
    if seen.failure is not None and seen.failure.usage is not None:
        usage = seen.failure.usage
    response = CallResponse(
        text=first.text if first is not None and seen.state == OK else None,
        tool_calls=list(first.tool_calls) if first is not None and seen.state == OK else [],
        finish_reason=first.finish_raw if first is not None else None,
        usage=usage,
        outcome=seen.outcome,
        error=call_error(seen),
        retried=retried if seen.state == FAILED else None,
    )
    view = Call(call.model, call.messages, tool_names, response)
    view._source = call
    return view


class TrialCalls(Sequence[Call]):
    """The target function's third argument: the calls captured in its trial so far."""

    def __init__(self, trial: Trial) -> None:
        self.trial = trial

    def views(self) -> list[Call]:
        with HUB.lock:
            seens = [freeze(call) for call in in_send_order(self.trial.calls)]
        roots = branch_roots(seens)
        return [call_view(seen, retried(seens, roots, index)) for index, seen in enumerate(seens)]

    def __getitem__(self, index: Any) -> Any:
        return self.views()[index]

    def __len__(self) -> int:
        return len(self.trial.calls)

    def __iter__(self) -> Iterator[Call]:
        return iter(self.views())


def in_send_order(calls: list[CapturedCall]) -> list[CapturedCall]:
    return sorted(calls, key=lambda call: call.sent_at)


def retried(seens: list[Seen], roots: list[int], index: int) -> bool:
    """A request was sent in the failed call's branch after the failure ended."""
    failure = seens[index].failure
    if failure is None:
        return False
    return any(
        roots[other] == roots[index] and seens[other].call.sent_at > failure.ended_at
        for other in range(len(seens))
    )


# --- Call branches (data-model §Call Branches) --------------------------------------------


def branch_roots(seens: list[Seen]) -> list[int]:
    """For each call, the index of the first call of its branch."""
    roots: list[int] = []
    for index, later in enumerate(seens):
        roots.append(index)
        conversation = (
            later.call.body.get("conversation") if later.call.api == "responses" else None
        )
        for earlier_index in range(index - 1, -1, -1):
            earlier = seens[earlier_index]
            if earlier.call.key == later.call.key:
                roots[index] = roots[earlier_index]
                break
            same_conversation = (
                earlier.call.api == "responses"
                and earlier.call.body.get("conversation") == conversation
            )
            if conversation is not None and not same_conversation:
                continue
            if tool_loop_step(later, earlier):
                roots[index] = roots[earlier_index]
                break
            if conversation is not None:
                break
    return roots


def tool_loop_step(later: Seen, earlier: Seen) -> bool:
    """The later request continues the earlier response's tool call."""
    api = later.call.api
    if api != earlier.call.api or not earlier.ended_in_tool_call():
        return False
    if later.call.system != earlier.call.system:
        return False
    if canonical_json(later.call.tools) != canonical_json(earlier.call.tools):
        return False
    body = later.call.body
    if api == "responses" and (
        body.get("previous_response_id") is not None or body.get("conversation") is not None
    ):
        previous = body.get("previous_response_id")
        if previous is not None and previous != earlier.response_id:
            return False
        items = responses_input(body)
        return bool(items) and all(is_tool_result(api, item) for item in items)
    before = conversation_items(api, earlier.call.body)
    after = conversation_items(api, body)
    if len(after) <= len(before):
        return False
    if any(canonical_json(a) != canonical_json(b) for a, b in zip(before, after)):
        return False
    return copies_and_results(api, after[len(before) :], earlier.output_items())


def is_tool_result(api: str, item: Any) -> bool:
    item = as_dict(item)
    if api == "chat-completions":
        return item.get("role") in ("tool", "function")
    if api == "responses":
        return item.get("type") in RESULT_ITEM_TYPES
    blocks = as_list(item.get("content"))
    return (
        item.get("role") == "user"
        and bool(blocks)
        and all(as_dict(block).get("type") == "tool_result" for block in blocks)
    )


def copies_and_results(api: str, extra: list[Any], outputs: list[Any] | None) -> bool:
    """What follows the earlier messages is only copies of the earlier response's output items
    and tool results. A stream's output items are not read, so its copies are not compared."""
    copies = [item for item in extra if not is_tool_result(api, item)]
    if api == "responses":
        copied = [output_key(item) for item in copies]
        known = None if outputs is None else [output_key(item) for item in outputs]
    else:
        if any(as_dict(item).get("role") != "assistant" for item in copies):
            return False
        if api == "chat-completions":
            copied = [chat_key(item) for item in copies]
            known = None if outputs is None else [chat_key(item) for item in outputs]
        else:
            copied = [block_key(block) for item in copies for block in content_blocks(item)]
            known = None if outputs is None else [block_key(block) for block in outputs]
    return known is None or is_subsequence(copied, known)


def is_subsequence(items: list[str], within: list[str]) -> bool:
    remaining = iter(within)
    return all(any(item == other for other in remaining) for item in items)


def chat_key(item: Any) -> str:
    item = as_dict(item)
    calls = [
        [
            call.get("id"),
            as_dict(call.get("function")).get("name"),
            as_dict(call.get("function")).get("arguments"),
        ]
        for call in map(as_dict, as_list(item.get("tool_calls")))
    ]
    return canonical_json(["assistant", parts_text(item.get("content")), calls])


def output_key(item: Any) -> str:
    """An output item by kind, text, tool-call ID, name, arguments and reasoning fields."""
    item = as_dict(item)
    kind = item.get("type") or ("message" if "role" in item else None)
    text = parts_text(item.get("content")) if kind == "message" else None
    arguments = item.get("arguments", item.get("input"))
    fields = [
        kind,
        text,
        call_id_of(item) if kind in RESULT_ITEMS or kind == "tool_search_call" else None,
    ]
    fields.extend(
        [item.get("name"), arguments, item.get("encrypted_content"), item.get("signature")]
    )
    return canonical_json(fields)


def content_blocks(item: Any) -> list[Any]:
    content = as_dict(item).get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return as_list(content)


def block_key(block: Any) -> str:
    block = as_dict(block)
    fields = [block.get("type"), block.get("text", block.get("thinking")), block.get("id")]
    fields.extend(
        [block.get("name"), block.get("input"), block.get("signature"), block.get("data")]
    )
    return canonical_json(fields)


# --- Reported values (helper-api §Return Values, §`Result`, §`ModelCallError`) -------------

FINAL_KINDS = ("model", "fallback", "discarded")
FINISH_REASONS = ("stop", "length", "content_filter", "other")
USAGE_BUCKETS = ("input", "cachedInput", "cacheWrite", "output", "reasoning")
# The largest integer a double holds exactly; protocol integers stay within it.
SAFE_INTEGER = 2**53 - 1


def whole_number(value: Any) -> bool:
    """An integer (helper-api §Shared Conventions): a finite number that is not a bool, has no
    fractional part and is at most 2^53 - 1 in absolute value (3 and 3.0, not True)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        number = float(value)
    except OverflowError:
        return False
    return number.is_integer() and abs(number) <= SAFE_INTEGER


def one_of(value: Any, names: tuple[str, ...]) -> bool:
    return isinstance(value, str) and value in names


def text_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def is_usage(value: Any) -> bool:
    """Token buckets: keys among the five bucket names, values non-negative integers."""
    if not isinstance(value, dict):
        return False
    return all(
        one_of(name, USAGE_BUCKETS) and whole_number(count) and count >= 0
        for name, count in value.items()
    )


def reported_usage(value: Any) -> dict[str, int] | None:
    """The given usage, or None when it breaks the rules of `is_usage`."""
    return {name: int(count) for name, count in value.items()} if is_usage(value) else None


def is_stages(value: Any) -> bool:
    return isinstance(value, list) and all(
        isinstance(stage, dict)
        and isinstance(stage.get("name"), str)
        and isinstance(stage.get("text"), str)
        for stage in value
    )


def valid_result(result: Result) -> bool:
    """helper-api §Checking `Result` and `ModelCallError` Values: a `Result` the helper can
    use; any other is adapter error A14. None stands for a field not given, apart from an
    explicit `final=None`; a `final` with kind `discarded` is ignored."""
    kind = "model" if result.kind is None else result.kind
    if not one_of(kind, FINAL_KINDS):
        return False
    if kind != "discarded" and result.final is not OMITTED and not isinstance(result.final, str):
        return False
    texts = (result.raw, result.discard_reason, result.model, result.model_snapshot)
    if any(text is not None and not isinstance(text, str) for text in texts):
        return False
    if result.model == "" or result.model_snapshot == "":
        return False
    if result.answers is not None and result.answers == 0 and kind == "model":
        return False
    checks = (
        (result.answers, lambda value: whole_number(value) and value >= 0),
        (result.finish_reason, lambda value: one_of(value, FINISH_REASONS)),
        (result.stopped_early, lambda value: isinstance(value, bool)),
        (result.usage, is_usage),
        (result.stages, is_stages),
    )
    return all(value is None or check(value) for value, check in checks)


def reported_status(value: Any) -> int | None:
    """`ModelCallError(status=)`: an integer from 100 to 599, else not given."""
    return int(value) if whole_number(value) and 100 <= value <= 599 else None


def reported_wait(value: Any) -> int | None:
    """`ModelCallError(retry_after_ms=)`: a number that is not a bool, read as a double and
    converted as a header's wait is; not given otherwise."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        return wait_ms(float(value))
    except OverflowError:
        return None


def reported_outcome(
    usage: dict[str, int] | None, corrected: bool, status: int | None, kind: str | None
) -> str:
    """data-model §Matching Reported Failures: the `outcome` of a corrected or added call."""
    if usage is not None:
        return "failed"
    if corrected or status == 200 or kind in (DISCONNECT, TIMEOUT):
        return "unanswered"
    return "failed"


# --- Outcome (data-model §Answers, §Outcome Decision, §Raw Cannot Be Determined,
# §Derived Result Fields; helper-api §Trial Warnings) --------------------------------------

DATED_SUFFIX = re.compile(r"-(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{8})")
NO_ANSWER_TEXT = "No answer within the service's time limit."


def is_variant_model(model: str, variant: str) -> bool:
    """data-model §Variant Model Call: the variant model, or it followed only by a date."""
    if model == variant:
        return True
    return model.startswith(variant) and DATED_SUFFIX.fullmatch(model[len(variant) :]) is not None


@dataclass(frozen=True)
class Answer:
    """One answer: a `choices` item, a text response or an `answer_tool` call."""

    index: int
    text: str
    finish: str


@dataclass
class FunctionEnd:
    """How the target function ended."""

    value: str | None = None
    is_fallback: bool = False
    error: BaseException | None = None
    discarded: bool = False
    # A return value that is not text, `fallback(text)` or `Result` (adapter error A14).
    not_text: bool = False
    # The `Result` the function returned, or the `ModelCallError` it raised.
    result: Result | None = None
    thrown: ModelCallError | None = None
    # A `Result` without `final` and with kind `model` ships the raw answer.
    final_is_raw: bool = False

    @property
    def raised(self) -> bool:
        """It raised an exception that is not in `discard_on`."""
        return self.error is not None and not self.discarded

    def take_result(self) -> None:
        """Ends the function as its valid `Result` says (data-model §Derived Result Fields,
        `final`): kind `discarded` counts as a `discard_on` exception."""
        result = self.result
        assert result is not None
        kind = "model" if result.kind is None else result.kind
        self.is_fallback = kind == "fallback"
        self.discarded = kind == "discarded"
        if isinstance(result.final, str) and kind != "discarded":
            self.value = result.final
        self.final_is_raw = result.final is OMITTED and kind == "model"

    def discard_text(self) -> str | None:
        """`discardReason`: the given reason or the exception's, cut to 200 code points."""
        if self.result is not None:
            reason = self.result.discard_reason
            return reason[:DISCARD_REASON_LIMIT] if isinstance(reason, str) else None
        return discard_reason(self.error) if self.error is not None else None

    def with_exception(self, message_id: str, **placeholders: str) -> str:
        """The message, in its form naming the exception when the function raised one."""
        if self.raised:
            assert self.error is not None
            exception = exception_text(self.error)
            return message(f"{message_id}-raised", exception=exception, **placeholders)
        return message(message_id, **placeholders)


def tool_answer_text(arguments: str, key: str) -> str:
    """data-model §Answer, `answer_tool` item 2."""
    value = as_dict(read_json_or_none(arguments)).get(key)
    if value is None:
        return ""
    return value if isinstance(value, str) else canonical_json(value)


class Analysis:
    """The trial's calls as the service had received them when the function returned."""

    def __init__(self, trial: Trial, seens: list[Seen], finals: list[Seen]) -> None:
        self.trial = trial
        self.target = trial.target
        self.seens = seens
        self.finals = finals
        self.variant_model = trial.variant.model
        self.is_variant = [is_variant_model(seen.call.model, self.variant_model) for seen in seens]
        self.roots = branch_roots(seens)
        reply_call = self.target.reply_call
        self.chosen: list[bool] | None = None
        if reply_call is not None:
            views = [call_view(seen, retried(seens, self.roots, i)) for i, seen in enumerate(seens)]
            self.chosen = [bool(reply_call(view)) for view in views]
        self.candidates = [
            index
            for index in range(len(seens))
            if self.is_variant[index] and (self.chosen is None or self.chosen[index])
        ]
        self.answer_roots = {self.roots[index] for index in self.candidates}
        self.answers = self.find_answers()

    # Answers

    def find_answers(self) -> list[Answer]:
        answers: list[Answer] = []
        tool_answered: set[int] = set()
        for index in self.candidates:
            if self.continues_tool_answer(index, tool_answered):
                continue
            answers.extend(self.answers_of(index))
            if self.calls_answer_tool(index):
                tool_answered.add(index)
        return answers

    def answers_of(self, index: int) -> list[Answer]:
        seen = self.seens[index]
        if seen.state != OK or seen.parsed is None or seen.background:
            return []
        found = []
        tool = self.target.answer_tool
        for choice in seen.parsed.choices:
            tool_call = next((c for c in choice.tool_calls if tool and c.name == tool[0]), None)
            if tool is not None and tool_call is not None:
                finish = choice.finish if choice.finish in ("length", "content_filter") else "stop"
                found.append(Answer(index, tool_answer_text(tool_call.arguments, tool[1]), finish))
            elif not choice.tool_end:
                found.append(Answer(index, choice.text, choice.finish))
        return found

    def calls_answer_tool(self, index: int) -> bool:
        tool = self.target.answer_tool
        parsed = self.seens[index].parsed
        if tool is None or parsed is None:
            return False
        return any(c.name == tool[0] for choice in parsed.choices for c in choice.tool_calls)

    def continues_tool_answer(self, index: int, answered: set[int]) -> bool:
        """A response continued after the service sent a tool result for an `answer_tool`
        call is not an answer (data-model §Answer, item 4)."""
        later = self.seens[index]
        for earlier in sorted(answered, reverse=True):
            if self.roots[earlier] == self.roots[index] and tool_loop_step(
                later, self.seens[earlier]
            ):
                answered.add(index)
                return True
        return False

    def stream_answer(self, index: int) -> bool:
        """data-model §Outcome Row 6 Details: an SSE response that received its
        generation-end marker counts as an answer, unless it ended in a tool call."""
        seen = self.seens[index]
        if not seen.sse or not seen.generation_end:
            return False
        return self.target.answer_tool is not None or not seen.stream_tool_end

    # Failures

    def failures(self) -> list[int]:
        return [i for i, seen in enumerate(self.seens) if seen.state == FAILED]

    def unrecovered(self, strict: bool = False) -> list[int]:
        """data-model §Successful Calls and Unrecovered Failures. `strict`: for the
        matching-failure candidate and the `call` check, an SSE response that ended before a
        generation-end marker is not a successful call."""
        found = []
        for index in self.failures():
            seen = self.seens[index]
            recovered = False
            for other, candidate in enumerate(self.seens):
                if other == index or self.roots[other] != self.roots[index]:
                    continue
                cut = strict and candidate.sse and not candidate.generation_end
                if candidate.state == UNFINISHED and other > index:
                    recovered = True
                elif (
                    candidate.successful()
                    and not cut
                    and (other > index or (candidate.ended_at or 0) > seen.call.sent_at)
                ):
                    recovered = True
                if recovered:
                    break
            if not recovered:
                found.append(index)
        return found

    def followed(self, index: int) -> bool:
        """A captured call of the trial was sent after this failure ended."""
        ended = self.seens[index].ended_at or 0
        return any(seen.call.sent_at > ended for seen in self.seens)

    def latest(self, indices: list[int]) -> int:
        return max(indices, key=lambda index: (self.seens[index].ended_at or 0, index))

    def deciding_failure(self, indices: list[int]) -> int:
        """The latest-ended failure of the answer branch when there is one, else of all."""
        in_answer = [index for index in indices if self.roots[index] in self.answer_roots]
        return self.latest(in_answer or indices)

    def config_failure(self) -> Seen | None:
        """Outcome row 1, calls that ended while the helper waited included."""
        configs = [seen for seen in self.finals if seen.state == FAILED and seen.kind == "config"]
        return max(configs, key=lambda seen: seen.ended_at or 0) if configs else None

    # Answer candidate calls

    def row5_cause(self) -> str | None:
        """data-model Outcome row 5: why the answer candidate calls cannot be determined."""
        if self.chosen is not None and not self.candidates:
            others = [i for i, chosen in enumerate(self.chosen) if chosen]
            return "A3-a" if others else "A3-b"
        if self.chosen is None and len(self.answer_roots) >= 2:
            return "A3-c"
        answer_roots = list(dict.fromkeys(self.roots[answer.index] for answer in self.answers))
        systems = {canonical_json(self.seens[root].call.system) for root in answer_roots}
        return "A3-d" if len(systems) > 1 else None

    def chosen_models(self) -> list[str]:
        chosen = self.chosen or []
        return [self.seens[i].call.model for i, flag in enumerate(chosen) if flag]

    def branch_of(self, index: int, decided: bool, all_side: bool) -> str | None:
        if all_side:
            return "side"
        if not decided:
            return None
        return "answer" if self.roots[index] in self.answer_roots else "side"

    def branch_decided(self) -> bool:
        return any(self.is_variant) and self.row5_cause() is None

    # Raw Cannot Be Determined

    def undeterminable(self) -> str | None:
        """data-model §Raw Cannot Be Determined rows 2 and 3."""
        for index in self.candidates:
            seen = self.seens[index]
            if seen.background:
                return "A6"
            if self.unparsed(seen):
                return "A5"
        return None

    @staticmethod
    def unparsed(seen: Seen) -> bool:
        """A stream response or a body that was not fully read. SSE responses that failed
        before the generation-end marker through a provider error event or a drop are not."""
        if seen.state in (UNREAD, UNFINISHED):
            return seen.had_headers
        if seen.state == FAILED and seen.sse and seen.failure is not None:
            if seen.generation_end:
                return True
            return seen.failure.transport == TIMEOUT
        return False


class Decision:
    """The `generate` response: a result, or an adapter error's message and data."""

    def __init__(self, analysis: Analysis, end: FunctionEnd, latency_ms: int) -> None:
        self.a = analysis
        self.end = end
        self.latency_ms = latency_ms
        # (ID number, sentence): helper-api §Trial Warnings lists them in ascending ID order.
        self.warnings: list[tuple[int, str]] = []

    # Records and shared fields

    def records(self, all_side: bool = False) -> list[JsonObject]:
        decided = self.a.branch_decided()
        return [
            call_record(
                final,
                self.a.branch_of(index, decided, all_side),
                self.a.seens[index].state != UNFINISHED,
            )
            for index, final in enumerate(self.a.finals)
        ]

    def usage(self) -> dict[str, int] | None:
        total: dict[str, int] = {}
        for final in self.a.finals:
            record_usage = call_record(final, None).get("usage")
            for name, value in as_dict(record_usage).items():
                total[name] = total.get(name, 0) + int(value)
        return total or None

    def cost(self, all_side: bool = False) -> JsonObject:
        fields: JsonObject = {}
        if self.a.finals:
            fields["calls"] = self.records(all_side)
        usage = self.usage()
        if usage is not None:
            fields["usage"] = usage
        return fields

    def adapter_error(self, text: str, captured_raw: str | None = None) -> tuple[str, JsonObject]:
        data = self.cost()
        if captured_raw is not None:
            data["capturedRaw"] = captured_raw
        return "error", {"message": text, "data": data}

    def failure(
        self,
        kind: str,
        text: str,
        retry_after: int | None,
        cost: JsonObject | None = None,
    ) -> tuple[str, JsonObject]:
        """A failure result; `retryAfterMs` only for a `transient` one (helper-api
        §`retryAfterMs`). `cost` replaces the calls' own `calls` and `usage`."""
        error: JsonObject = {"kind": kind, "message": text}
        if retry_after is not None and kind == "transient":
            error["retryAfterMs"] = retry_after
        fields = self.cost() if cost is None else cost
        result: JsonObject = {"error": error, "latencyMs": self.latency_ms, **fields}
        self.add_usage_warning()
        if self.warnings:
            result["warnings"] = self.ordered_warnings()
        return "result", result

    def call_failure(self, seen: Seen) -> tuple[str, JsonObject]:
        assert seen.failure is not None
        kind = seen.kind or "transient"
        return self.failure(kind, failure_message(seen), seen.failure.retry_after_ms)

    # The decision

    def decide(self) -> tuple[str, JsonObject]:
        a, end = self.a, self.end
        if a.trial.outside_context:
            return self.adapter_error(message("A10"))
        config = a.config_failure()
        if config is not None:
            return self.call_failure(config)
        if end.thrown is not None:
            return self.decide_thrown(end.thrown)
        if end.not_text or (end.result is not None and not valid_result(end.result)):
            return self.adapter_error(message("A14"), self.captured_raw())
        if end.result is not None:
            end.take_result()
            if end.result.raw is not None:
                return RawDecision(self, end.result).decide()
            if end.result.stopped_early is True:
                self.warn("W7")
        if not a.seens:
            return "error", {"message": end.with_exception("A1"), "data": {}}
        unrecovered = a.unrecovered()
        if unrecovered and (end.raised or not a.candidates):
            pool = unrecovered if end.raised else [i for i in unrecovered if not a.followed(i)]
            if pool:
                return self.call_failure(a.seens[a.deciding_failure(pool)])
        if not any(a.is_variant):
            models = model_list([seen.call.model for seen in a.seens])
            return self.adapter_error(
                end.with_exception("A2", model=self.a.variant_model, models=models)
            )
        cause = a.row5_cause()
        if cause is not None:
            if cause in ("A3-a", "A3-b") and (end.is_fallback or end.discarded):
                return self.answered("", 0, "other", all_side=True)
            models = model_list(a.chosen_models()) if cause == "A3-a" else ""
            text = end.with_exception(cause, models=models) if models else end.with_exception(cause)
            return self.adapter_error(text)
        row6 = self.row6(unrecovered)
        if row6 is not None:
            return row6
        if end.raised:
            assert end.error is not None
            return self.adapter_error(
                message("row9", exception=exception_text(end.error)), self.captured_raw()
            )
        undeterminable = a.undeterminable()
        if undeterminable is not None:
            return self.adapter_error(message(undeterminable))
        if not a.answers:
            if not (end.is_fallback or end.discarded):
                return self.adapter_error(message("A4"))
            return self.answered(self.last_candidate_text(), 0, "other")
        return self.answered_from_answers()

    # A thrown `ModelCallError` (data-model §Matching Reported Failures)

    def decide_thrown(self, thrown: ModelCallError) -> tuple[str, JsonObject]:
        """After Outcome row 1: A12 unless exactly one of `status`, `kind` and `call` is given
        and a given `status` or `kind` is one of its values, A13 for a `call` that is not a
        failure of this trial the service received, else the trial is the failure of the
        matched or added call."""
        a = self.a
        status = reported_status(thrown.status)
        kind = thrown.kind if one_of(thrown.kind, tuple(TRANSPORT_KINDS)) else None
        given = [value is not None for value in (thrown.status, thrown.kind, thrown.call)]
        if sum(given) != 1 or (given[0] and status is None) or (given[1] and kind is None):
            return self.adapter_error(message("A12"))
        if thrown.call is not None:
            source = thrown.call._source if isinstance(thrown.call, Call) else None
            call = next((i for i, seen in enumerate(a.seens) if seen.call is source), None)
            if call is None or not self.received_failure(call):
                return self.adapter_error(message("A13"))
            return self.matched_failure(call, None)
        text = trim_text(thrown.message) if isinstance(thrown.message, str) else ""
        if not text:
            text = f"HTTP {status}" if status is not None else str(kind)
        usage = reported_usage(thrown.usage)
        wait = reported_wait(thrown.retry_after_ms)
        error = ErrorObject(
            text_or_none(thrown.type), text_or_none(thrown.code), text_or_none(thrown.message)
        )
        thrown_kind = classify(status, error, kind)
        model = thrown.model if isinstance(thrown.model, str) and thrown.model else a.variant_model
        searched = self.calls_to(model, a.chosen)
        candidates: list[tuple[int, str]] = []
        if status == 200 or kind in (DISCONNECT, TIMEOUT):
            started = [i for i in searched if self.started_response(a.seens[i])]
            candidates += [(started[-1], "started")] if started else []
        unrecovered = set(a.unrecovered(strict=True))
        failures = [
            i for i in searched if i in unrecovered and self.matches(a.seens[i], status, kind)
        ]
        candidates += [(failures[-1], "failure")] if failures else []
        if kind == TIMEOUT:
            unfinished = [i for i in searched if a.seens[i].state == UNFINISHED]
            candidates += [(unfinished[-1], "unfinished")] if unfinished else []
        if candidates:
            index, how = max(candidates)
            if how == "failure":
                return self.matched_failure(index, thrown_kind)
        else:
            index, how = -1, "none"
            self.w10(model, status, kind)
        records = self.records()
        record: JsonObject = {"model": model, "errorKind": thrown_kind}
        if how == "started":
            record = records[index]
            record["errorKind"] = thrown_kind
            record.pop("finishReason", None)
        if how in ("started", "none"):
            record["outcome"] = reported_outcome(usage, how == "started", status, kind)
            if wait is not None and thrown_kind == "transient":
                record["retryAfterMs"] = wait
            if usage is not None:
                record["usage"] = usage
        if how == "none" and a.seens:
            records.append(record)
        if not a.seens:
            cost: JsonObject = {} if usage is None else {"usage": usage}
        else:
            cost = records_cost(records)
        return self.failure(thrown_kind, text, wait, cost)

    def received_failure(self, index: int) -> bool:
        """helper-api §The `call` Check: an unrecovered failure, not resent, and with
        `reply_call` one it is true for."""
        a = self.a
        if index not in a.unrecovered(strict=True):
            return False
        if retried(a.seens, a.roots, index):
            return False
        return a.chosen is None or a.chosen[index]

    def matched_failure(self, index: int, thrown_kind: str | None) -> tuple[str, JsonObject]:
        """The matching-failure candidate decides by its own kind and `retryAfterMs`, unless
        the thrown value classifies as `config`, which makes the trial and the call `config`."""
        seen = self.a.seens[index]
        assert seen.failure is not None
        records = self.records()
        if thrown_kind == "config":
            records[index]["errorKind"] = "config"
            records[index].pop("retryAfterMs", None)
            return self.failure("config", failure_message(seen), None, records_cost(records))
        kind = seen.kind or "transient"
        return self.failure(kind, failure_message(seen), seen.failure.retry_after_ms)

    def calls_to(self, model: str, chosen: list[bool] | None) -> list[int]:
        """The calls a thrown failure of `model` is matched among: to the variant model, only
        those `reply_call` is true for (when `chosen` is given)."""
        a = self.a
        if model == a.variant_model:
            return [
                i for i in range(len(a.seens)) if a.is_variant[i] and (chosen is None or chosen[i])
            ]
        return [i for i, seen in enumerate(a.seens) if seen.call.model == model]

    @staticmethod
    def started_response(seen: Seen) -> bool:
        """An unread response; an SSE one only without a generation-end marker."""
        return seen.state == UNREAD and not (seen.sse and seen.generation_end)

    @staticmethod
    def matches(seen: Seen, status: int | None, kind: str | None) -> bool:
        """A failure that matches the thrown value: an error response of that status, or with
        `kind` a failure without an error response."""
        if seen.state != FAILED or seen.failure is None:
            return False
        if status is not None:
            return seen.failure.status == status
        return kind is not None and seen.failure.status is None

    def w10(self, model: str, status: int | None, kind: str | None) -> None:
        """W10: no candidate, and every captured failure of that model matching a thrown
        `status` or a `kind` other than `timeout` was resent."""
        a = self.a
        if status is None and kind == TIMEOUT:
            return
        if model == a.variant_model and a.chosen is not None and not any(a.chosen):
            return
        matching = [i for i in self.calls_to(model, None) if self.matches(a.seens[i], status, kind)]
        if matching and all(retried(a.seens, a.roots, i) for i in matching):
            self.warn("W10")

    def row6(self, unrecovered: list[int]) -> tuple[str, JsonObject] | None:
        a = self.a
        answered = bool(a.answers) or any(a.stream_answer(index) for index in a.candidates)
        if answered:
            return None
        in_answer = [index for index in unrecovered if a.roots[index] in a.answer_roots]
        unfinished = [
            index
            for index, seen in enumerate(a.seens)
            if seen.state == UNFINISHED and a.roots[index] in a.answer_roots
        ]
        if unfinished and (in_answer or not self.end.raised):
            return self.failure("timeout", NO_ANSWER_TEXT, None)
        if in_answer:
            return self.call_failure(a.seens[a.latest(in_answer)])
        return None

    def captured_raw(self) -> str | None:
        """Outcome row 9: the first answer, else the text of the last successful response."""
        if self.a.answers:
            return self.a.answers[0].text
        texts = [
            seen.parsed.choices[0].text
            for seen in self.a.seens
            if seen.state == OK and seen.parsed is not None and seen.parsed.choices
        ]
        return texts[-1] if texts else None

    def last_candidate_text(self) -> str:
        texts = [
            seen.parsed.choices[0].text
            for index in self.a.candidates
            if (seen := self.a.seens[index]).state == OK
            and seen.parsed is not None
            and seen.parsed.choices
        ]
        return texts[-1] if texts else ""

    # Results with an answer (Outcome rows 7 and 8)

    def answered_from_answers(self) -> tuple[str, JsonObject]:
        answers = self.a.answers
        first, last = answers[0], answers[-1]
        if self.finish_not_given() and last.finish != "stop" and self.earlier_stop(last):
            self.warn("W3")
        return self.answered(first.text, len(answers), last.finish, raw_index=first.index)

    def finish_not_given(self) -> bool:
        given = self.end.result
        return given is None or given.finish_reason is None

    def earlier_stop(self, last: Answer, answers: list[Answer] | None = None) -> bool:
        """W3: an earlier answer of the same request (an earlier `choices` item, an answer of
        a request with the same body) ended with `stop`."""
        earlier = (self.a.answers if answers is None else answers)[:-1]
        key = self.a.seens[last.index].call.key
        return any(
            answer.finish == "stop" and self.a.seens[answer.index].call.key == key
            for answer in earlier
        )

    def answered(
        self,
        raw: str,
        answers: int,
        finish: str,
        raw_index: int | None = None,
        all_side: bool = False,
    ) -> tuple[str, JsonObject]:
        a = self.a
        snapshot, request = self.raw_sources(raw_index)
        system = a.seens[a.roots[a.answers[0].index]].call.system if a.answers else None
        return self.result_of(
            raw,
            answers,
            finish,
            records=self.records(all_side) if a.finals else None,
            snapshot=snapshot,
            usage_index=snapshot,
            request=None if request is None else a.seens[request].call,
            w2_system=system,
            w2_text_only=False,
            has_answer=answers > 0,
        )

    def result_of(
        self,
        raw: str,
        answers: int,
        finish: str,
        *,
        records: list[JsonObject] | None,
        snapshot: int | None,
        usage_index: int | None,
        request: CapturedCall | None,
        w2_system: list[str] | None,
        w2_text_only: bool,
        has_answer: bool,
    ) -> tuple[str, JsonObject]:
        """A result with the shipped text, the values a `Result` gives over the helper's
        (data-model §Derived Result Fields) and the trial warnings."""
        end, given = self.end, self.end.result
        result: JsonObject = {
            "raw": raw,
            "answers": answers,
            "finalKind": "discarded"
            if end.discarded
            else "fallback"
            if end.is_fallback
            else "model",
            "latencyMs": self.latency_ms,
            "finishReason": finish,
        }
        if end.discarded:
            reason = end.discard_text()
            if reason is not None:
                result["discardReason"] = reason
        elif end.value is not None:
            result["final"] = end.value
        else:
            result["final"] = raw if end.final_is_raw else ""
        if snapshot is not None:
            parsed = self.a.seens[snapshot].parsed
            if parsed is not None and parsed.response_model:
                result["modelSnapshot"] = parsed.response_model
        if request is not None:
            result["fingerprint"] = render_fingerprint(request.messages, request.tools)
        usage = None
        if given is not None:
            if given.answers is not None:
                result["answers"] = int(given.answers)
            if given.finish_reason is not None:
                result["finishReason"] = given.finish_reason
            if given.model_snapshot is not None:
                result["modelSnapshot"] = given.model_snapshot
            if given.stages is not None:
                result["stages"] = [
                    {"name": stage["name"], "text": stage["text"]} for stage in given.stages
                ]
            usage = reported_usage(given.usage)
        if records is not None:
            if usage is not None and usage_index is not None:
                records[usage_index]["usage"] = usage
                seens = self.a.seens
                if usage_index < len(seens) and seens[usage_index].state == FAILED:
                    records[usage_index]["outcome"] = "failed"
            result.update(records_cost(records))
        elif usage is not None:
            result["usage"] = usage
        if has_answer and result["finalKind"] in ("fallback", "discarded"):
            self.w1()
        if result["finalKind"] == "model" and (w2_system is not None or w2_text_only):
            self.w2(str(result.get("final", "")), w2_system)
        self.add_usage_warning()
        result["warnings"] = self.ordered_warnings()
        return "result", result

    def raw_sources(self, raw_index: int | None) -> tuple[int | None, int | None]:
        """The call whose response model is `modelSnapshot` and the call whose request gives
        the fingerprint (data-model §Derived Result Fields): with an answer, the first
        answer's call and the first request of its branch; with none, the last successful
        answer candidate call and the first answer candidate request."""
        if raw_index is not None:
            return raw_index, self.a.roots[raw_index]
        candidates = self.a.candidates
        successful = [index for index in candidates if self.a.seens[index].successful()]
        return (successful[-1] if successful else None), (candidates[0] if candidates else None)

    # Warnings

    def warn(self, message_id: str, **placeholders: str) -> None:
        number = int(message_id[1:].split("-")[0])
        self.warnings.append((number, message(message_id, **placeholders)))

    def ordered_warnings(self) -> list[str]:
        return [text for _, text in sorted(self.warnings, key=lambda warning: warning[0])]

    def add_usage_warning(self) -> None:
        if any(final.parsed is not None and final.parsed.negative_input for final in self.a.finals):
            self.warn("W9")

    def w1(self) -> None:
        a = self.a
        transient = [
            index
            for index in a.unrecovered()
            if a.seens[index].kind == "transient" and not a.followed(index)
        ]
        if not transient:
            return
        index = a.latest(transient)
        if a.is_variant[index]:
            self.warn("W1-variant")
        else:
            self.warn("W1", model=a.seens[index].call.model)

    def w2(self, shipped: str, system: list[str] | None) -> None:
        """W2: another model's answer with the shipped text, or from a branch whose first
        request has the answer branch's system (`system` None: the text only)."""
        a = self.a
        for index, seen in enumerate(a.seens):
            if a.is_variant[index] or seen.state != OK:
                continue
            for answer in a.answers_of(index):
                same_text = trim_text(answer.text) == trim_text(shipped)
                same_system = system is not None and a.seens[a.roots[index]].call.system == system
                if same_text or same_system:
                    self.warn("W2", model=seen.call.model)
                    return


MATCHED, LAST_UNREAD = "matched", "unread"


class RawDecision:
    """data-model §When the Adapter Gives Raw: the trial of a valid `Result` with `raw`, after
    Outcome row 1. Cut streams are taken by the view the given values choose (§Cut Streams)."""

    def __init__(self, decision: Decision, given: Result) -> None:
        self.d = decision
        self.a = a = decision.a
        self.given = given
        self.raw = str(given.raw)
        self.kind = "model" if given.kind is None else str(given.kind)
        self.empty = is_empty_text(self.raw)
        self.fallback = self.kind in ("fallback", "discarded")
        self.stopped = given.stopped_early is True
        self.honoured = self.stopped and not self.empty and self.kind == "model"
        zero = given.answers is not None and given.answers == 0
        if self.empty and zero and self.fallback:
            self.view = 5
        elif not self.empty and self.fallback:
            self.view = 2
        else:
            self.view = 3 if self.honoured else 1
        self.searched = list(a.candidates)
        self.ignored = self.view_5_ignored() if self.view == 5 else set()
        self.live = [i for i in self.searched if i not in self.ignored]
        self.cut = {i for i in self.live if self.is_cut(a.seens[i])}
        # Cut streams taken as `timeout` failures (view 1, and view 3 apart from unread ones).
        self.cut_failures = {
            i for i in self.cut if self.view == 1 or (self.view == 3 and a.seens[i].state != UNREAD)
        }
        # Unread responses after the failure check.
        self.unread = {i for i in self.live if a.seens[i].state == UNREAD} | self.cut
        if self.kind == "model":
            self.unread |= {i for i in self.live if self.failed_after_marker(a.seens[i])}
        self.answers = [answer for answer in a.answers if answer.index not in self.ignored]
        failures = {
            i: self.ended(i)
            for i in self.live
            if (a.seens[i].state == FAILED and i not in self.unread) or i in self.cut_failures
        }
        self.failure_ends = failures
        self.unrecovered = self.unrecovered_of(failures, self.cut_failures | self.ignored)
        self.unfinished = [
            i for i in self.live if a.seens[i].state == UNFINISHED and i not in self.cut
        ]

    # Calls under the chosen view

    @staticmethod
    def is_cut(seen: Seen) -> bool:
        """A searched SSE call that ended before its generation-end marker: failed with
        `timeout`, left unread, or unfinished when the function returned."""
        if not seen.sse or seen.generation_end:
            return False
        if seen.state in (UNREAD, UNFINISHED):
            return True
        return (
            seen.state == FAILED and seen.failure is not None and seen.failure.transport == TIMEOUT
        )

    @staticmethod
    def failed_after_marker(seen: Seen) -> bool:
        """An SSE call that failed by a drop or time-out after its generation-end marker."""
        failure = seen.failure
        return (
            seen.state == FAILED
            and seen.sse
            and seen.generation_end
            and failure is not None
            and failure.status is None
        )

    def ended(self, index: int) -> float:
        """When the call ended; a cut stream still being read, when the service last read it."""
        seen = self.a.seens[index]
        if seen.ended_at is not None:
            return seen.ended_at
        return seen.read_at or self.a.trial.function_ended_at or time.monotonic()

    def view_5_ignored(self) -> set[int]:
        """View 5: cut streams, calls that failed with `timeout`, unfinished calls, and a
        failure followed by another searched call sent after it ended."""
        seens = self.a.seens
        ignored = {
            i
            for i in self.searched
            if self.is_cut(seens[i]) or seens[i].kind == "timeout" or seens[i].state == UNFINISHED
        }
        for i in self.searched:
            if seens[i].state == FAILED and any(
                seens[j].call.sent_at > self.ended(i) for j in self.searched
            ):
                ignored.add(i)
        return ignored

    def unrecovered_of(self, failures: dict[int, float], unsuccessful: set[int]) -> list[int]:
        """data-model §Successful Calls and Unrecovered Failures over `failures`, where the
        calls in `unsuccessful` are not successful calls."""
        a = self.a
        found = []
        for index in sorted(failures):
            sent = a.seens[index].call.sent_at
            recovered = False
            for other, seen in enumerate(a.seens):
                if other == index or a.roots[other] != a.roots[index]:
                    continue
                if other in failures or other in unsuccessful:
                    continue
                if seen.state == UNFINISHED and other > index:
                    recovered = True
                elif (seen.successful() or other in self.unread) and (
                    other > index or (seen.ended_at or 0) > sent
                ):
                    recovered = True
                if recovered:
                    break
            if not recovered:
                found.append(index)
        return found

    def received(self, index: int) -> bool:
        """An answer, or a stream that received a generation-end marker (one that ended in a
        tool call only with `answer_tool`)."""
        if any(answer.index == index for answer in self.answers):
            return True
        seen = self.a.seens[index]
        tool = self.a.target.answer_tool
        return seen.sse and seen.generation_end and (tool is not None or not seen.stream_tool_end)

    # The order of checks

    def decide(self) -> tuple[str, JsonObject]:
        d, a, given = self.d, self.a, self.given
        if self.stopped and not self.honoured:
            d.warn("W7")
        if given.answers is not None and given.answers == 0:
            if any(self.received(i) for i in self.live):
                return d.adapter_error(message("A8"))
        decided = self.failure_check() if self.live else self.no_searched_calls()
        if decided is not None:
            return decided
        matching = [
            answer for answer in self.answers if trim_text(answer.text) == trim_text(self.raw)
        ]
        if matching:
            return self.checked(matching[0].index, MATCHED)
        if self.unread:
            return self.checked(max(self.unread), LAST_UNREAD)
        exception = (
            given.model is None
            and self.empty
            and self.fallback
            and any(a.is_variant)
            and not self.answers
        )
        if given.model is None and not exception:
            models = model_list([seen.call.model for seen in a.seens])
            return d.adapter_error(message("A7", model=a.variant_model, models=models))
        if not self.result_model_is_variant():
            return self.wrong_result_model()
        return self.uncaptured(exception)

    def result_model_is_variant(self) -> bool:
        model = self.given.model
        return model is None or is_variant_model(str(model), self.a.variant_model)

    def wrong_result_model(self) -> tuple[str, JsonObject]:
        """Outcome row 4 applied to `Result(model=)`."""
        models = model_list([str(self.given.model)])
        text = message("A2-result-model", model=self.a.variant_model, models=models)
        return self.no_branch_error(text)

    def no_branch_error(self, text: str) -> tuple[str, JsonObject]:
        """An adapter error of Outcome row 4 or 5, whose calls carry no `branch`."""
        a = self.a
        records = [call_record(f, None, s.state != UNFINISHED) for f, s in zip(a.finals, a.seens)]
        return "error", {"message": text, "data": records_cost(records) if records else {}}

    def failure_check(self) -> tuple[str, JsonObject] | None:
        """§Failure Check: an unrecovered failure or an unfinished call among the searched
        calls, no unread response, and no answer the given raw can stand for."""
        if not self.unrecovered and not self.unfinished:
            return None
        tool = self.a.target.answer_tool
        for i in self.unread - self.cut_failures:
            seen = self.a.seens[i]
            if tool is not None or not (seen.sse and seen.stream_tool_end):
                return None
        if self.answers and not (
            self.empty and not any(is_empty_text(answer.text) for answer in self.answers)
        ):
            return None
        return self.failed(cut_last_answer=False)

    def no_searched_calls(self) -> tuple[str, JsonObject] | None:
        """§No Searched Calls: an empty raw without `Result(model=)` is the unrecovered
        failure Outcome row 3 would take."""
        a = self.a
        if not self.empty or self.given.model is not None:
            return None
        failures = {
            i: self.ended(i)
            for i, seen in enumerate(a.seens)
            if seen.state == FAILED and i not in self.ignored
        }
        pool = [i for i in self.unrecovered_of(failures, self.ignored) if not a.followed(i)]
        if not pool:
            return None
        return self.d.call_failure(a.seens[a.deciding_failure(pool)])

    def failed(self, cut_last_answer: bool) -> tuple[str, JsonObject]:
        """The trial decided like Outcome row 6: `timeout` when an unfinished call exists,
        else the latest-ended unrecovered failure, a cut stream being a `timeout` one; W6 when
        a cut stream or an unfinished call decides, else W5."""
        d, a = self.d, self.a
        suffix = "-cut-last-answer" if cut_last_answer else ""
        index = None
        if not self.unfinished:
            index = max(self.unrecovered, key=lambda i: (self.failure_ends[i], i))
        if index is None or index in self.cut_failures:
            if self.honoured:
                suffix += "-stopped-early-honoured"
            elif self.stopped:
                suffix += "-stopped-early-ignored"
            d.warn("W6" + suffix)
        else:
            d.warn("W5" + suffix)
        seen = None if index is None else a.seens[index]
        if seen is None or seen.state != FAILED:
            return d.failure("timeout", NO_ANSWER_TEXT, None)
        return d.call_failure(seen)

    # A captured raw call

    def checked(self, raw_index: int, source: str) -> tuple[str, JsonObject]:
        """Outcome row 4 and row 5 when raw is given, §Cut Last Answer, the finish-reason
        check, then the result."""
        a, given = self.a, self.given
        if not self.result_model_is_variant():
            return self.wrong_result_model()
        if a.chosen is not None:
            accepted = set(self.searched) | {raw_index}
        else:
            branches = {a.roots[raw_index]} | {a.roots[i] for i in self.unread if i < raw_index}
            accepted = {i for i in range(len(a.seens)) if a.roots[i] in branches}
        branches = {a.roots[i] for i in accepted}
        both = given.finish_reason is not None and given.answers is not None
        raw_system = a.seens[a.roots[raw_index]].call.system
        if a.chosen is None:
            systems = {canonical_json(a.seens[root].call.system) for root in branches}
            if len(systems) > 1:
                return self.no_branch_error(message("A3-raw-unread-systems"))
            if not both and any(a.roots[x.index] != a.roots[raw_index] for x in self.answers):
                return self.no_branch_error(message("A3-raw-other-answer"))
        cut_last_answer = self.cut_last_answer(raw_index, source)
        if source == MATCHED:
            recovered_cuts = self.cut_failures - set(self.unrecovered)
            later = [i for i in self.unread if i > raw_index and i not in recovered_cuts]
            if later:
                differs = any(
                    a.seens[a.roots[i]].call.system != raw_system for i in later if i in self.cut
                )
                if a.chosen is None and differs:
                    return self.no_branch_error(message("A3-raw-unread-systems"))
                if not cut_last_answer and not both:
                    return self.no_branch_error(message("A3-raw-unread-follows"))
        if cut_last_answer:
            return self.failed(cut_last_answer=True)
        return self.captured_result(raw_index, source, accepted, branches)

    def cut_last_answer(self, raw_index: int, source: str) -> bool:
        """§Cut Last Answer: the last call cut without `Result(answers=)`, or the raw call cut
        with `Result(answers=1)`; only cut streams that stay unrecovered `timeout` failures."""
        a, given = self.a, self.given
        cuts = set(self.unrecovered) & self.cut_failures
        if not cuts:
            return False
        answered = {answer.index for answer in self.answers} | self.unread
        if given.answers is None and answered and max(answered) in cuts:
            return True
        if source != LAST_UNREAD or raw_index not in cuts or given.answers != 1:
            return False
        if a.chosen is None:
            return True
        sent = a.seens[raw_index].call.sent_at
        return not any(
            i != raw_index and self.received(i) and self.ended(i) > sent for i in self.live
        )

    def captured_result(
        self, raw_index: int, source: str, accepted: set[int], branches: set[int]
    ) -> tuple[str, JsonObject]:
        """§Answer Candidate Calls When Raw Is Given: `answers`, the finish reason,
        `fingerprint` and `branch`, with `Result(usage=)` on the raw call."""
        d, a, given = self.d, self.a, self.given
        answers = [answer for answer in self.answers if answer.index in accepted]
        count = len(answers)
        from_raw = False
        raw_seen = a.seens[raw_index]
        tool_end = raw_seen.sse and raw_seen.stream_tool_end
        if source == LAST_UNREAD:
            counts = not (tool_end and a.target.answer_tool is None and self.fallback)
            count += 1 if counts else 0
            from_raw = counts and (not answers or raw_index > answers[-1].index)
        finish = given.finish_reason
        if finish is None:
            if from_raw and not tool_end:
                return d.adapter_error(message("A9"))
            if from_raw or not answers:
                finish = "stop" if self.kind == "model" and tool_end else "other"
            else:
                last = answers[-1]
                finish = last.finish
                if last.finish != "stop" and d.earlier_stop(last, answers):
                    d.warn("W3")
        first = min([i for i in self.unread if i < raw_index] + [raw_index])
        records = [
            call_record(
                final,
                "answer" if a.roots[i] in branches else "side",
                a.seens[i].state != UNFINISHED,
            )
            for i, final in enumerate(a.finals)
        ]
        return d.result_of(
            self.raw,
            count,
            str(finish),
            records=records,
            snapshot=raw_index if source == MATCHED else None,
            usage_index=raw_index,
            request=a.seens[a.roots[first]].call,
            w2_system=a.seens[a.roots[raw_index]].call.system,
            w2_text_only=False,
            has_answer=self.given.answers != 0,
        )

    # The uncaptured call

    def uncaptured(self, exception: bool) -> tuple[str, JsonObject]:
        """§Raw Call, the uncaptured call: added to `calls` with `Result(model=)`; under the
        uncaptured-call exception nothing is added and `answers` is 0."""
        d, a, given = self.d, self.a, self.given
        records = [
            call_record(final, None, s.state != UNFINISHED) for final, s in zip(a.finals, a.seens)
        ]
        if exception:
            return d.result_of(
                self.raw,
                0,
                str(given.finish_reason or "other"),
                records=records if a.finals else None,
                snapshot=None,
                usage_index=None,
                request=None,
                w2_system=None,
                w2_text_only=False,
                has_answer=False,
            )
        if given.finish_reason is None:
            return d.adapter_error(message("A9"))
        if self.answers:
            d.warn("W4")
        self.w8()
        if a.finals:
            added: JsonObject = {"model": str(given.model), "outcome": "ok"}
            if given.model_snapshot is not None:
                added["responseModel"] = given.model_snapshot
            records.append(added)
        return d.result_of(
            self.raw,
            1,
            str(given.finish_reason),
            records=records if a.finals else None,
            snapshot=None,
            usage_index=len(records) - 1 if a.finals else None,
            request=None,
            w2_system=None,
            w2_text_only=True,
            has_answer=given.answers != 0,
        )

    def w8(self) -> None:
        """W8: a captured call to another model looks like the source of the raw answer."""
        a = self.a
        raw = trim_text(self.raw)
        for i, seen in enumerate(a.seens):
            if a.is_variant[i] or (a.chosen is not None and not a.chosen[i]):
                continue
            looks = seen.state in (UNREAD, UNFINISHED) or (
                seen.state == FAILED
                and seen.sse
                and not seen.generation_end
                and seen.failure is not None
                and seen.failure.transport == TIMEOUT
            )
            if not looks and raw:
                texts = [trim_text(answer.text) for answer in a.answers_of(i)]
                looks = any(raw in text and 2 * len(raw) >= len(text) for text in texts)
            if looks:
                self.d.warn("W8", model=seen.call.model)
                return


def failure_message(seen: Seen) -> str:
    failure = seen.failure
    assert failure is not None
    if failure.status is not None and failure.status != 200:
        detail = seen.error.message
        return f"HTTP {failure.status}" + (f": {detail}" if detail else "")
    return seen.error.message or failure.text or "The model call failed."


# --- Service version (data-model §Service Version) ----------------------------------------


class VersionError(Exception):
    """A git call, `lstat` or a file read failed: nothing is reported, with log warning L1."""


class NotReported(Exception):
    """The service folder has no version to report, and no warning is due."""


Identity: TypeAlias = "tuple[int, int]"


def identity(result: os.stat_result) -> Identity:
    return result.st_dev, result.st_ino


def tool_identities(tool_paths: Sequence[str]) -> set[Identity]:
    """Each existing `toolPaths` entry by both its `lstat` and its `stat` identity."""
    found: set[Identity] = set()
    for path in tool_paths:
        for read in (os.lstat, os.stat):
            try:
                found.add(identity(read(path)))
            except OSError:
                continue
    return found


class GitTree:
    """`version`, `dirty` and `treeHash` of one service folder."""

    def __init__(self, folder: str, tool_paths: Sequence[str]) -> None:
        self.folder = os.path.abspath(folder)
        self.tools = tool_identities(tool_paths)
        self.env = dict(os.environ)

    def git(
        self, folder: str, *arguments: str, check: bool = True
    ) -> subprocess.CompletedProcess[bytes]:
        try:
            done = subprocess.run(
                ["git", *arguments],
                cwd=folder,
                env=self.env,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                check=False,
            )
        except OSError as error:
            # data-model §When Nothing Is Reported: git not installed is silent; git that fails
            # to start for another reason, or a folder gone before git ran, is a failure.
            if error.errno == errno.ENOENT and os.path.isdir(folder):
                raise NotReported from error
            code = errno.errorcode.get(error.errno or 0, str(error.errno))
            raise VersionError(f"git {subcommand(arguments)}: {code}") from error
        if check and done.returncode != 0:
            raise VersionError(f"git {subcommand(arguments)}: {git_failure(done)}")
        return done

    def report(self) -> JsonObject:
        try:
            os.lstat(os.path.join(self.folder, "."))
        except OSError as error:
            raise VersionError(self.os_failure("lstat", os.fsencode("."), error)) from error
        names = self.git(self.folder, "rev-parse", "--local-env-vars", check=False)
        for name in os.fsdecode(names.stdout).split():
            self.env.pop(name, None)
        inside = self.git(self.folder, "rev-parse", "--is-inside-work-tree", check=False)
        if inside.returncode != 0 or inside.stdout.strip() != b"true":
            raise NotReported
        ignored = self.git(self.folder, "check-ignore", "-q", ".", check=False)
        if ignored.returncode == 0:
            raise NotReported
        if ignored.returncode != 1:
            raise VersionError(f"git check-ignore: {git_failure(ignored)}")
        version = self.git(self.folder, "rev-parse", "HEAD").stdout.decode().strip()
        top = os.fsdecode(
            self.git(self.folder, "rev-parse", "--show-toplevel").stdout.rstrip(b"\n")
        )
        dirty = self.dirty(top)
        tree = self.tree_hash(self.folder)
        if tree is None:
            raise NotReported
        return {"version": version, "dirty": dirty, "treeHash": tree}

    def dirty(self, top: str) -> bool:
        arguments = ["--no-optional-locks", "status", "--porcelain", "-z"]
        arguments += ["--untracked-files=all", "--ignore-submodules=none", "--", "."]
        done = self.git(self.folder, *arguments)
        entries = done.stdout.split(b"\0")
        index = 0
        while index < len(entries):
            entry = entries[index]
            index += 1
            if len(entry) < 4:
                continue
            paths = [entry[3:]]
            if b"R" in entry[:2] or b"C" in entry[:2]:
                paths.append(entries[index] if index < len(entries) else b"")
                index += 1
            for path in paths:
                if path and not self.excluded(
                    os.path.join(os.fsencode(top), path), os.fsencode(top)
                ):
                    return True
        return False

    def excluded(self, path: bytes, stop: bytes) -> bool:
        """The path, or a parent folder up to `stop`, is the same file as a `toolPaths` entry."""
        current = path
        while True:
            try:
                if identity(os.lstat(current)) in self.tools:
                    return True
            except OSError:
                pass
            if current == stop or len(current) <= len(stop):
                return False
            parent = os.path.dirname(current)
            if parent == current:
                return False
            current = parent

    def listed(self, folder: str) -> list[bytes]:
        cached = self.git(folder, "ls-files", "-z", "--cached").stdout
        others = self.git(folder, "ls-files", "-z", "--others", "--exclude-standard").stdout
        paths = {path.rstrip(b"/") for path in (cached + others).split(b"\0") if path}
        return sorted(paths)

    def tree_hash(self, folder: str, nested: bool = False) -> str | None:
        """data-model §`treeHash`; None for an empty list at `service_dir`."""
        base = os.fsencode(folder)
        parts: list[bytes] = []
        left_out: list[bytes] = []
        for path in self.listed(folder):
            if any(path.startswith(parent + b"/") for parent in left_out):
                continue
            entry = self.entry(base, path)
            if entry is None:
                left_out.append(path)
                continue
            kind, content = entry
            parts.append(path + b"\0" + kind + b"\0" + str(len(content)).encode() + b"\0" + content)
        if not parts and not nested:
            return None
        return "sha256:" + hashlib.sha256(b"".join(parts)).hexdigest()

    def entry(self, base: bytes, path: bytes) -> tuple[bytes, bytes] | None:
        """The kind and content of a listed path, or None when it is left out. A folder that
        is not a repository top is left out with the files placed in it."""
        full = os.path.join(base, path)
        if self.excluded(full, base):
            return None
        try:
            info = os.lstat(full)
        except FileNotFoundError:
            return None
        except OSError as error:
            raise VersionError(self.os_failure("lstat", full, error)) from error
        content: bytes | None = None
        if stat.S_ISLNK(info.st_mode):
            content = self.read(full, os.readlink)
            return None if content is None else (b"l", content)
        if stat.S_ISREG(info.st_mode):
            content = self.read(full, read_bytes)
            return None if content is None else (b"f", content)
        if stat.S_ISDIR(info.st_mode):
            return self.nested_entry(full)
        return None

    def nested_entry(self, folder: bytes) -> tuple[bytes, bytes] | None:
        """A folder's `s` entry when it is a repository top. When its git fails and the folder
        is gone, it disappeared while computing and is left out; otherwise the failure counts."""
        try:
            if not self.is_repository_top(folder):
                return None
            tree = self.tree_hash(os.fsdecode(folder), nested=True)
        except VersionError:
            try:
                os.lstat(folder)
            except FileNotFoundError:
                return None
            raise
        return (b"s", tree.encode()) if tree is not None else None

    def read(self, path: bytes, reader: Callable[[bytes], bytes]) -> bytes | None:
        """The bytes, or None for a path that vanished while computing."""
        try:
            return reader(path)
        except FileNotFoundError:
            return None
        except OSError as error:
            raise VersionError(self.os_failure("read", path, error)) from error

    def is_repository_top(self, folder: bytes) -> bool:
        done = self.git(os.fsdecode(folder), "rev-parse", "--show-toplevel")
        try:
            top = os.stat(done.stdout.rstrip(b"\n"))
            return identity(top) == identity(os.stat(folder))
        except OSError:
            return False

    def os_failure(self, operation: str, path: bytes, error: OSError) -> str:
        relative = (
            path if not os.path.isabs(path) else os.path.relpath(path, os.fsencode(self.folder))
        )
        code = errno.errorcode.get(error.errno or 0, str(error.errno))
        return f"{operation} {os.fsdecode(relative)}: {code}"


def read_bytes(path: bytes) -> bytes:
    with open(path, "rb") as file:
        return file.read()


def subcommand(arguments: Sequence[str]) -> str:
    """The git subcommand of an argument list that may start with global options."""
    return next((argument for argument in arguments if not argument.startswith("-")), "")


def git_failure(done: subprocess.CompletedProcess[bytes]) -> str:
    """git's last non-empty stderr line, trimmed, or `exit code N`."""
    lines = [trim_text(line) for line in done.stderr.decode("utf-8", "replace").splitlines()]
    lines = [line for line in lines if line]
    return lines[-1] if lines else f"exit code {done.returncode}"


def service_version(
    service_dir: str | None, tool_paths: Sequence[str]
) -> tuple[JsonObject, str | None]:
    """`initialize`'s `service` and, when computing it failed, the L1 warning."""
    if service_dir is None:
        return {}, None
    try:
        return GitTree(service_dir, tool_paths).report(), None
    except NotReported:
        return {}, None
    except VersionError as error:
        return {}, message("L1", reason=str(error))


# --- Protocol server (001 adapter-protocol §Transport, §Methods; helper-api §Cancel) ------

PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS = -32700, -32600, -32601, -32602
ADAPTER_ERROR = -32000
STDIN_CHUNK = 65536


class ProtocolOut:
    """Protocol messages on the kept descriptor, one JSON line each, written whole."""

    def __init__(self, fd: int) -> None:
        self.fd = fd
        self.lock = threading.Lock()

    def send(self, value: JsonObject) -> None:
        data = (canonical_json(value) + "\n").encode("utf-8")
        with self.lock:
            view = memoryview(data)
            while view:
                written = os.write(self.fd, view)
                view = view[written:]


class Server:
    """Answers the tool's requests for one adapter process."""

    def __init__(self, adapter: Adapter, loop: asyncio.AbstractEventLoop) -> None:
        self.adapter = adapter
        self.loop = loop
        self.out = ProtocolOut(PROTOCOL_FD)
        self.variant = Variant("", "")
        self.timeout_ms = 120_000
        self.stopped = asyncio.Event()
        self.tasks: set[asyncio.Future[Any]] = set()
        self.ending: asyncio.Future[None] | None = None

    async def serve(self) -> None:
        HUB.attach(self, self.loop)
        self.loop.set_exception_handler(self.background_exception)
        reader = threading.Thread(target=self.read_stdin, name="model-eval-stdin", daemon=True)
        reader.start()
        await self.stopped.wait()

    def read_stdin(self) -> None:
        """Reads protocol lines from descriptor 0 with `os.read`. This thread is a daemon still
        blocked in a read when the process exits after `shutdown`; reading through
        `sys.stdin`'s buffer would hold its lock then, and closing that buffer at interpreter
        shutdown aborts the process."""
        buffer = bytearray()
        failed = False
        while True:
            try:
                chunk = os.read(0, STDIN_CHUNK)
            except BlockingIOError:
                select.select([0], [], [])
                continue
            except OSError:
                failed = True
                break
            if not chunk:
                break
            self.post_lines(buffer, chunk)
        if buffer and not failed:
            self.post(self.received, bytes(buffer))
        self.post(self.input_ended)

    def post_lines(self, buffer: bytearray, chunk: bytes) -> None:
        """Appends a chunk and posts the lines it completes, searching only the new bytes for
        line ends so that a very long line is not scanned again on every read."""
        search = len(buffer)
        buffer.extend(chunk)
        start = 0
        while (end := buffer.find(b"\n", search)) >= 0:
            self.post(self.received, bytes(buffer[start:end]))
            start = search = end + 1
        del buffer[:start]

    def post(self, callback: Callable[..., None], *arguments: Any) -> None:
        """Hands a callback to the event loop; after the loop closed there is nobody to run it."""
        try:
            self.loop.call_soon_threadsafe(callback, *arguments)
        except RuntimeError:
            pass

    def input_ended(self) -> None:
        """stdin closed: the requests already read are answered, then the process ends."""

        async def finish_pending() -> None:
            pending = [task for task in self.tasks if not task.done()]
            if pending:
                await asyncio.wait(pending)
            self.stopped.set()

        self.ending = asyncio.ensure_future(finish_pending())

    # Messages

    def received(self, line: bytes) -> None:
        if not line.strip():
            return
        try:
            request = json.loads(line)
        except ValueError:
            self.send_error(None, PARSE_ERROR, "The line is not JSON.")
            return
        if not isinstance(request, dict) or request.get("jsonrpc") != "2.0":
            self.send_error(None, INVALID_REQUEST, "The message is not a JSON-RPC 2.0 object.")
            return
        method, params, request_id = (
            request.get("method"),
            as_dict(request.get("params")),
            request.get("id"),
        )
        if request_id is None:
            if method == "cancel":
                self.cancel(params.get("id"))
            return
        handlers: dict[str, Callable[[int, JsonObject], Any]] = {
            "initialize": self.initialize,
            "generate": self.generate,
            "shutdown": self.shutdown,
            "render": self.render,
        }
        handler = handlers.get(str(method))
        if handler is None:
            self.send_error(request_id, METHOD_NOT_FOUND, f"Unknown method {method}.")
            return
        task = asyncio.ensure_future(self.answer(handler, request_id, params))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def answer(
        self, handler: Callable[[int, JsonObject], Any], request_id: int, params: JsonObject
    ) -> None:
        try:
            await handler(request_id, params)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.send_error(
                request_id, ADAPTER_ERROR, f"The helper failed: {exception_text(error)}"
            )

    def send_result(self, request_id: int, result: Any) -> None:
        self.out.send({"jsonrpc": "2.0", "id": request_id, "result": result})

    def send_error(
        self, request_id: Any, code: int, text: str, data: JsonObject | None = None
    ) -> None:
        error: JsonObject = {"code": code, "message": text}
        if data is not None:
            error["data"] = data
        self.out.send({"jsonrpc": "2.0", "id": request_id, "error": error})

    def log(self, text: str) -> None:
        self.out.send(
            {"jsonrpc": "2.0", "method": "log", "params": {"level": "warn", "message": text}}
        )

    # initialize

    async def initialize(self, request_id: int, params: JsonObject) -> None:
        variant = as_dict(params.get("variant"))
        self.variant = Variant(
            str(variant.get("id", "")),
            str(variant.get("model", "")),
            as_dict(variant.get("params")),
        )
        self.timeout_ms = as_count(params.get("timeoutMs")) or self.timeout_ms
        tool_paths = [str(path) for path in as_list(params.get("toolPaths"))]
        service, warning = await asyncio.to_thread(
            service_version, self.adapter.service_dir, tool_paths
        )
        if warning is not None:
            self.log(warning)
        targets = list(self.adapter.targets.values())
        capabilities: JsonObject = {
            "render": any(self.adapter.renders(target) for target in targets),
            "stages": True,
            "postprocess": any(target.postprocess for target in targets) if targets else True,
            "cancel": True,
        }
        if self.adapter.max_concurrency is not None:
            capabilities["maxConcurrency"] = self.adapter.max_concurrency
        result: JsonObject = {
            "protocolVersion": PROTOCOL_VERSION,
            "adapter": {
                "name": self.adapter.name,
                "version": self.adapter.version,
                "helper": {"language": "python", "version": HELPER_VERSION},
            },
            "targets": [target_description(target) for target in targets],
            "capabilities": capabilities,
        }
        if service:
            result["service"] = service
        self.send_result(request_id, result)

    # generate

    async def render(self, request_id: int, params: JsonObject) -> None:
        """helper-api §Render Mode: runs the target with `case.rendering`, or the adapter's
        render function, and answers with the render result. A target without render mode is
        adapter error A15."""
        target = self.adapter.targets.get(str(params.get("target")))
        if target is None:
            self.send_error(request_id, INVALID_PARAMS, f"Unknown target {params.get('target')}.")
            return
        if not self.adapter.renders(target):
            self.send_error(request_id, ADAPTER_ERROR, message("A15"), {})
            return
        case = Case(
            id=str(params.get("caseId", "")),
            lang=as_str(params.get("lang")),
            input=as_dict(params.get("input")),
            repeat=0,
            seed=as_count(params.get("seed")) or 0,
            rendering=True,
        )
        function = target.render if callable(target.render) else None
        function = self.adapter.render_functions.get(target.name, function)
        trial = Trial(request_id, target, case, self.variant, self.timeout_ms)
        with HUB.lock:
            HUB.trials[request_id] = trial
        try:
            if function is not None:
                kind, payload = await self.render_by_function(trial, function)
            else:
                await self.run_function(trial)
                kind, payload = render_decision(trial)
        finally:
            with HUB.lock:
                trial.state = "sent"
                HUB.trials.pop(request_id, None)
        if kind == "result":
            self.send_result(request_id, payload)
        else:
            self.send_error(request_id, ADAPTER_ERROR, payload["message"], {})

    async def render_by_function(
        self, trial: Trial, function: Callable[..., Any]
    ) -> tuple[str, JsonObject]:
        """A render function run like the service function in render mode, in the render's
        trial context (a sync one in a worker thread), its captured requests answered with the
        render-mode 400. Its result is normalised as a captured request is: A17 when it raises,
        A18 when its value is not a render result."""
        arguments = (trial.case, trial.variant)

        async def in_context() -> Any:
            CURRENT_TRIAL.set(trial)
            try:
                if inspect.iscoroutinefunction(function):
                    value = await function(*arguments)
                else:
                    value = await in_daemon_thread(function, *arguments)
                return await value if inspect.isawaitable(value) else value
            except asyncio.CancelledError as error:
                if self.stopped.is_set():
                    raise
                return RaisedCancel(error)

        try:
            value = await asyncio.ensure_future(in_context())
        except Exception as error:
            return "error", {"message": message("A17", exception=exception_text(error))}
        finally:
            with HUB.lock:
                trial.state = "waiting"
        if isinstance(value, RaisedCancel):
            return "error", {"message": message("A17", exception=exception_text(value.error))}
        if trial.outside_context:
            return "error", {"message": message("A10")}
        if not is_render_result(value):
            return "error", {"message": message("A18")}
        return "result", normalised_render(value)

    async def generate(self, request_id: int, params: JsonObject) -> None:
        target = self.adapter.targets.get(str(params.get("target")))
        if target is None:
            self.send_error(request_id, INVALID_PARAMS, f"Unknown target {params.get('target')}.")
            return
        case = Case(
            id=str(params.get("caseId", "")),
            lang=as_str(params.get("lang")),
            input=as_dict(params.get("input")),
            repeat=as_count(params.get("repeat")) or 0,
            seed=as_count(params.get("seed")) or 0,
        )
        trial = Trial(request_id, target, case, self.variant, self.timeout_ms)
        with HUB.lock:
            HUB.trials[request_id] = trial
        try:
            end = await self.run_function(trial)
            if trial.cancelled:
                self.send_cancelled(trial)
            else:
                await self.finish(trial, end)
        finally:
            with HUB.lock:
                trial.state = "sent"
                HUB.trials.pop(request_id, None)
            self.flush_notifications()

    async def run_function(self, trial: Trial) -> FunctionEnd:
        target = trial.target
        arguments: list[Any] = [trial.case, trial.variant]
        if target.takes_calls:
            arguments.append(TrialCalls(trial))

        async def in_context() -> Any:
            CURRENT_TRIAL.set(trial)
            try:
                if target.is_async:
                    value = await target.function(*arguments)
                else:
                    value = await in_daemon_thread(target.function, *arguments)
                # helper-api §Return Values: an awaitable value is awaited once, and from then on
                # the trial is cancelled as an asynchronous one.
                if not inspect.isawaitable(value):
                    return value
                with HUB.lock:
                    trial.asynchronous = True
                return await value
            except asyncio.CancelledError as error:
                if trial.cancelled or self.stopped.is_set():
                    raise
                return RaisedCancel(error)

        trial.task = asyncio.ensure_future(in_context())
        try:
            value = await trial.task
        except asyncio.CancelledError:
            if not trial.cancelled:
                raise
            return FunctionEnd(error=asyncio.CancelledError())
        except ModelCallError as error:
            return FunctionEnd(thrown=error)
        except Exception as error:
            return FunctionEnd(error=error)
        finally:
            with HUB.lock:
                trial.function_ended_at = time.monotonic()
                if trial.state == "running":
                    trial.state = "waiting"
        if isinstance(value, RaisedCancel):
            return FunctionEnd(error=value.error)
        if isinstance(value, Fallback) and isinstance(value.text, str):
            return FunctionEnd(value=value.text, is_fallback=True)
        if isinstance(value, str):
            return FunctionEnd(value=value)
        if isinstance(value, Result):
            return FunctionEnd(result=value)
        return FunctionEnd(not_text=True)

    async def finish(self, trial: Trial, end: FunctionEnd) -> None:
        """Waits for the trial's unfinished calls, then sends its result."""
        assert trial.function_ended_at is not None
        latency = milliseconds(trial.function_ended_at - trial.started)
        await asyncio.sleep(0)
        with HUB.lock:
            calls = in_send_order(trial.calls)
            seens = [freeze(call) for call in calls]
        await self.wait_for(
            lambda: trial.cancelled or not any(call.in_flight() for call in calls), trial.deadline()
        )
        if trial.cancelled:
            self.send_cancelled(trial, seens)
            return
        with HUB.lock:
            finals = [seen if seen.state != UNFINISHED else freeze(seen.call) for seen in seens]
        try:
            if end.error is not None and not isinstance(end.error, asyncio.CancelledError):
                end.discarded = trial.target.discards(end.error)
            analysis = Analysis(trial, seens, finals)
            kind, payload = Decision(analysis, end, latency).decide()
        except Exception as error:
            self.send_decision_failure(trial, error, seens, finals, latency)
            return
        if kind == "result":
            self.send_result(trial.request_id, payload)
        else:
            self.send_error(trial.request_id, ADAPTER_ERROR, payload["message"], payload["data"])

    async def wait_for(self, condition: Callable[[], bool], deadline: float) -> None:
        while time.monotonic() < deadline:
            with HUB.lock:
                if condition():
                    return
            await asyncio.sleep(POLL_S)

    # cancel

    def cancel(self, request_id: Any) -> None:
        """helper-api §Cancel: later requests of the trial are not sent; an asynchronous
        function is cancelled and its calls in flight are cut as `unanswered`, those awaited in
        other tasks too."""
        with HUB.lock:
            trial = HUB.trials.get(request_id) if isinstance(request_id, int) else None
            if trial is None or trial.state not in ("running", "waiting"):
                return
            trial.cancelled = True
            others: set[asyncio.Task[Any]] = set()
            if trial.asynchronous:
                for call in trial.calls:
                    if call.in_flight():
                        call.cut_now()
                        task = None if call.task is None else call.task()
                        if task is not None and task is not trial.task and not task.done():
                            call.cutting = True
                            others.add(task)
        if trial.asynchronous and trial.task is not None and not trial.task.done():
            trial.task.cancel()
        # Calls awaited in other tasks (background work of the trial) are cut by cancelling
        # those tasks; their wrappers turn the cancellation into a dropped request.
        for task in others:
            task.cancel()

    def send_decision_failure(
        self,
        trial: Trial,
        error: Exception,
        seens: list[Seen],
        finals: list[Seen],
        latency: int,
    ) -> None:
        """data-model §Outcome Decision, decision failure: Outcome row 1 when a call failed with
        `config` (unless classifying failed too), else adapter error A16 with the calls."""
        result = config_result(finals, seens, latency)
        if result is not None:
            self.send_result(trial.request_id, result)
            return
        text = message("A16", exception=exception_text(error))
        self.send_error(trial.request_id, ADAPTER_ERROR, text, cost_of(finals, seens))

    def send_cancelled(self, trial: Trial, returned: list[Seen] | None = None) -> None:
        """helper-api §Cancel: the response to a cancelled trial, sent without waiting for
        calls: a failure result with its calls, `config` when a call failed so (Outcome row 1),
        else `timeout` with F2. It needs no `reply_call`, so a raising one changes nothing.
        `returned` holds the calls as they were when the function returned, when it returned
        before the cancel."""
        with HUB.lock:
            finals = [freeze(call) for call in in_send_order(trial.calls)]
        assert trial.function_ended_at is not None
        latency = milliseconds(trial.function_ended_at - trial.started)
        result = config_result(finals, returned, latency)
        if result is None:
            error: JsonObject = {"kind": "timeout", "message": message("F2")}
            result = {"error": error, "latencyMs": latency, **cost_of(finals, returned)}
        self.send_result(trial.request_id, result)

    # Notifications and background work

    def flush_notifications(self, force: bool = False) -> None:
        for call in HUB.unreported(force):
            params: JsonObject = {"calls": [call_record(freeze(call), None)]}
            if call.trial is not None:
                params["id"] = call.trial.request_id
            self.out.send({"jsonrpc": "2.0", "method": "calls", "params": params})

    def background_exception(
        self, loop: asyncio.AbstractEventLoop, context: dict[str, Any]
    ) -> None:
        """L3 when a request of an abandoned trial that the helper cut or blocked caused the
        exception, a cancellation included; else L2 for an unhandled exception in an asyncio
        task."""
        error = context.get("exception")
        if not isinstance(error, BaseException):
            loop.default_exception_handler(context)
            return
        if any(getattr(item, ABANDONED, False) for item in exception_chain(error)):
            self.log(message("L3", exception=exception_text(error)))
        elif isinstance(error, Exception):
            self.log(message("L2", exception=exception_text(error)))
        else:
            loop.default_exception_handler(context)

    # shutdown

    async def shutdown(self, request_id: int, params: JsonObject) -> None:
        """Waits for running trials and for calls no result included, reports them, then
        answers (001 adapter-protocol §`shutdown`)."""
        deadline = time.monotonic() + (self.timeout_ms - KEPT_MS) / 1000
        current = asyncio.current_task()
        others = [task for task in self.tasks if task is not current and not task.done()]
        if others:
            await asyncio.wait(others, timeout=max(deadline - time.monotonic(), 0))
        await self.wait_for(lambda: not any(call.in_flight() for call in HUB.notified), deadline)
        self.flush_notifications(force=True)
        self.send_result(request_id, None)
        self.stopped.set()


def render_decision(trial: Trial) -> tuple[str, JsonObject]:
    """The answer to a `render` once the function has ended: A10 when an out-of-context
    request met two trials in progress, A16 when `reply_call` raised, the render result of
    the render target, else A11 (helper-api §When Render Fails)."""
    if trial.outside_context:
        return "error", {"message": message("A10")}
    reply_call = trial.target.reply_call
    with HUB.lock:
        calls = in_send_order(trial.calls)
    try:
        for call in calls:
            if not is_variant_model(call.model, trial.variant.model):
                continue
            view = Call(call.model, call.messages, tool_names_of(call.body))
            if reply_call is None or reply_call(view):
                if not renderable(call):
                    return "error", {"message": message("A19")}
                return "result", rendered_request(call)
    except Exception as error:
        return "error", {"message": message("A16", exception=exception_text(error))}
    return "error", {"message": message("A11")}


OUTPUT_LIMITS = ("max_tokens", "max_completion_tokens", "max_output_tokens")


def renderable(call: CapturedCall) -> bool:
    """helper-api §Render Mode, A19: the render target request gives at least one message,
    every message has a role (an item with neither `role` nor `type` has none), and its
    `tools`, when given, is a list."""
    messages = call.messages
    if not messages or any(not item["role"] for item in messages):
        return False
    return call.tools is None or isinstance(call.tools, list)


def rendered_request(call: CapturedCall) -> JsonObject:
    """The render result of the render target request."""
    tools = call.tools
    limits = (as_count(call.body.get(name)) for name in OUTPUT_LIMITS)
    limit = next((value for value in limits if value is not None and value > 0), None)
    return render_result(call.messages, tools, limit)


def is_render_result(value: Any) -> bool:
    """helper-api §Render Mode, render function: an object whose `messages` is a non-empty list
    of objects with a non-empty string `role`, whose `tools`, when given, is a list and whose
    `maxOutputTokens`, when given, is a positive integer."""
    if not isinstance(value, dict):
        return False
    messages = value.get("messages")
    if not isinstance(messages, list) or not messages:
        return False
    for item in messages:
        if not isinstance(item, dict) or not isinstance(item.get("role"), str) or not item["role"]:
            return False
    if value.get("tools") is not None and not isinstance(value["tools"], list):
        return False
    limit = value.get("maxOutputTokens")
    if limit is not None and (as_count(limit) is None or limit <= 0):
        return False
    return is_json(messages) and is_json(value.get("tools")) and is_json(limit)


def is_json(value: Any) -> bool:
    """A value JSON can carry: no object of another class, NaN, infinity, integer too large for
    a double (number_text refuses the same numbers) or non-string key."""
    if value is None or isinstance(value, (bool, str)):
        return True
    if isinstance(value, (int, float)):
        try:
            return math.isfinite(float(value))
        except OverflowError:
            return False
    if isinstance(value, list):
        return all(is_json(item) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and is_json(item) for key, item in value.items())
    return False


def normalised_render(value: JsonObject) -> JsonObject:
    """A render function's result, its `messages` read as Chat Completions messages."""
    messages = [chat_message(as_dict(item)) for item in as_list(value.get("messages"))]
    return render_result(messages, value.get("tools"), as_count(value.get("maxOutputTokens")))


def render_result(messages: list[JsonObject], tools: Any, limit: int | None) -> JsonObject:
    result: JsonObject = {"messages": messages, "fingerprint": render_fingerprint(messages, tools)}
    if tools is not None:
        result["tools"] = tools
    if limit is not None:
        result["maxOutputTokens"] = limit
    return result


@dataclass(frozen=True)
class RaisedCancel:
    """The target function raised `asyncio.CancelledError` itself, with no `cancel` from the
    tool: an exception of the service like any other."""

    error: BaseException


def in_daemon_thread(function: Callable[..., Any], *arguments: Any) -> asyncio.Future[Any]:
    """Runs a synchronous target function in the current context on a daemon thread, so a
    function still running after `shutdown` does not keep the process from exiting (the
    default executor's worker threads are joined at exit)."""
    loop = asyncio.get_running_loop()
    future: asyncio.Future[Any] = loop.create_future()
    context = contextvars.copy_context()

    def settle(value: Any, error: BaseException | None) -> None:
        if future.done():
            return
        if error is not None:
            future.set_exception(error)
        else:
            future.set_result(value)

    def work() -> None:
        value: Any = None
        error: BaseException | None = None
        try:
            value = context.run(function, *arguments)
        except BaseException as raised:
            error = raised
        try:
            loop.call_soon_threadsafe(settle, value, error)
        except RuntimeError:
            pass

    threading.Thread(target=work, name="model-eval-target", daemon=True).start()
    return future


def config_result(
    finals: list[Seen], returned: list[Seen] | None, latency: int
) -> JsonObject | None:
    """Outcome row 1 from the calls alone, without `reply_call`: the failure result of the
    latest-ended `config` failure, or None. A classification that raises counts as none."""
    try:
        configs = [seen for seen in finals if seen.state == FAILED and seen.kind == "config"]
    except Exception:
        return None
    if not configs:
        return None
    config = max(configs, key=lambda seen: seen.ended_at or 0)
    failure: JsonObject = {"kind": "config", "message": failure_message(config)}
    return {"error": failure, "latencyMs": latency, **cost_of(finals, returned)}


def cost_of(finals: list[Seen], returned: list[Seen] | None = None) -> JsonObject:
    """`calls` and `usage` of a trial's records when no decision gives them. `returned` holds
    the calls as they were when the function returned, for their `latencyMs`."""
    if not finals:
        return {}
    ended = [True] * len(finals) if returned is None else [s.state != UNFINISHED for s in returned]
    return records_cost([call_record(final, None, done) for final, done in zip(finals, ended)])


def records_cost(records: list[JsonObject]) -> JsonObject:
    """`calls` and the `usage` summed over them."""
    usage: dict[str, int] = {}
    for record in records:
        for name, value in as_dict(record.get("usage")).items():
            usage[name] = usage.get(name, 0) + int(value)
    return {"calls": records, **({"usage": usage} if usage else {})}


def target_description(target: Target) -> JsonObject:
    description: JsonObject = {"name": target.name}
    if target.languages is not None:
        description["languages"] = target.languages
    description["inputSchema"] = target.input_schema
    return description


install_capture()
