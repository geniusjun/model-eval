"""Mock OpenAI and Anthropic API server for the adapter helper tests. Standard library only.

    python3 server.py [--port 8787] [--host 127.0.0.1] [--log]

Answers POST /v1/chat/completions, /v1/responses and /v1/messages (and any other path) with the
script loaded through the control path, one script entry per request in send order, in the
format of test/fixtures/helper/scenario.schema.json (`scriptEntry`). The control path starts with
/__mock__/, which ends with none of the API path suffixes, so the helpers never capture it:

    POST /__mock__/script   {"requests": [entry, ...]}  load a script and clear the request log
    GET  /__mock__/log      {"requests": [record, ...]} the requests received since the load
    POST /__mock__/reset                                unload the script and clear the log
    POST /__mock__/tls      {"certificate": name}       a TLS listener presenting that certificate
                                                        of test/fixtures/helper/tls/: {"port": n}

The first line on stdout names the address it listens on. With --log every received request is
also printed to stdout as one JSON line.
"""

from __future__ import annotations

import argparse
import base64
import json
import socket
import ssl
import sys
import threading
import time
import zlib
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

JsonObject = dict[str, Any]

CONTROL_PREFIX = "/__mock__/"
TLS_DIR = Path(__file__).resolve().parents[3] / "test" / "fixtures" / "helper" / "tls"

# certificate name -> (certificate chain file, key file) in TLS_DIR, written by make.sh
CERTIFICATES: dict[str, tuple[str, str]] = {
    "valid": ("server-chain.pem", "server.key"),
    "self-signed": ("self-signed.pem", "self-signed.key"),
    "other-host": ("other-host-chain.pem", "other-host.key"),
    "expired": ("expired-chain.pem", "expired.key"),
    "missing-intermediate": ("server.pem", "server.key"),
}

API_SUFFIXES = {
    "/chat/completions": "chat-completions",
    "/responses": "responses",
    "/messages": "messages",
}

CONTENT_FIELDS = ("reply", "error", "body", "text", "sse")
BODY_FIELDS = {"model", "stream", "bodyIncludes"}
# How often a listener checks for shutdown, so stopping a test server takes no noticeable time.
POLL_S = 0.05


class ScriptError(Exception):
    """A script entry the server cannot answer with; reported as a 500 naming the problem."""


def compact_json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


# --- Script and request log -----------------------------------------------------------------


class ScriptBook:
    """The loaded script and the request log, shared by every listener and connection."""

    def __init__(self, print_log: bool) -> None:
        self._lock = threading.Lock()
        self._entries: list[JsonObject] | None = None
        self._remaining: list[int] = []
        self._log: list[JsonObject] = []
        self._print_log = print_log
        self._ids = 0

    def load(self, entries: list[JsonObject]) -> None:
        for index, entry in enumerate(entries):
            check_entry(index, entry)
        with self._lock:
            self._entries = entries
            self._remaining = [int(entry.get("times", 1)) for entry in entries]
            self._log = []

    def reset(self) -> None:
        with self._lock:
            self._entries = None
            self._remaining = []
            self._log = []

    @property
    def loaded(self) -> bool:
        with self._lock:
            return self._entries is not None

    def peek(self, method: str, path: str) -> JsonObject | None:
        """The entry that answers a request known by method and path, or None when the body
        could decide it."""
        with self._lock:
            for index, entry in enumerate(self._entries or []):
                if self._remaining[index] == 0:
                    continue
                match = entry.get("match") or {}
                if BODY_FIELDS & match.keys():
                    return None
                if matches(match, method, path, None):
                    return entry
        return None

    def take(self, method: str, path: str, body: Any) -> JsonObject | None:
        with self._lock:
            for index, entry in enumerate(self._entries or []):
                if self._remaining[index] > 0 and matches(entry.get("match"), method, path, body):
                    self._remaining[index] -= 1
                    return entry
        return None

    def next_id(self) -> int:
        with self._lock:
            self._ids += 1
            return self._ids

    def record(self, record: JsonObject) -> None:
        with self._lock:
            self._log.append(record)

    def publish(self, record: JsonObject) -> None:
        """Prints a record with --log, once the response it describes is decided."""
        if self._print_log:
            with self._lock:
                line = compact_json(record)
            print(line, flush=True)

    def update(self, record: JsonObject, **fields: Any) -> None:
        with self._lock:
            record.update(fields)

    def log(self) -> list[JsonObject]:
        with self._lock:
            return [dict(record) for record in self._log]


def check_entry(index: int, entry: Any) -> None:
    if not isinstance(entry, dict):
        raise ScriptError(f"script entry {index} is not an object")
    contents = [field for field in CONTENT_FIELDS if field in entry]
    closes = entry.get("connection", "respond") != "respond"
    if closes and contents:
        raise ScriptError(f"script entry {index} closes the connection but gives {contents[0]}")
    if not closes and len(contents) != 1:
        raise ScriptError(f"script entry {index} needs exactly one of {', '.join(CONTENT_FIELDS)}")


def matches(match: JsonObject | None, method: str, path: str, body: Any) -> bool:
    """Whether a request fits `match`; with `body` None, fields read from the body never fit."""
    if not match:
        return True
    if "method" in match and match["method"] != method:
        return False
    if "path" in match and not path.endswith(match["path"]):
        return False
    if BODY_FIELDS & match.keys() and body is None:
        return False
    request = body if isinstance(body, dict) else {}
    if "model" in match and request.get("model") != match["model"]:
        return False
    if "stream" in match and (request.get("stream") is True) != match["stream"]:
        return False
    if "bodyIncludes" in match and match["bodyIncludes"] not in compact_json(body):
        return False
    return True


def api_of(path: str) -> str | None:
    """The captured API whose path suffix ends the path, as the helpers match it."""
    for suffix, api in API_SUFFIXES.items():
        if path.endswith(suffix):
            return api
    return None


def format_of(path: str) -> str:
    """The API whose format a reply or error is written in; OpenAI Chat Completions by default."""
    if "/responses" in path:
        return "responses"
    if path.endswith("/messages"):
        return "messages"
    return "chat-completions"


# --- Error bodies (OpenAI and Anthropic formats) --------------------------------------------

ANTHROPIC_ERROR_TYPES = {
    400: "invalid_request_error",
    401: "authentication_error",
    402: "billing_error",
    403: "permission_error",
    404: "not_found_error",
    413: "request_too_large",
    429: "rate_limit_error",
    500: "api_error",
    504: "timeout_error",
    529: "overloaded_error",
}


def default_error_type(api: str, status: int) -> str:
    """The type a provider usually gives; status 200 stands for a failure inside an answer."""
    if api == "messages":
        if status in ANTHROPIC_ERROR_TYPES:
            return ANTHROPIC_ERROR_TYPES[status]
        return "invalid_request_error" if 400 <= status < 500 else "api_error"
    if status == 429:
        return "requests"
    return "invalid_request_error" if 400 <= status < 500 else "server_error"


def error_object(api: str, error: JsonObject, status: int) -> JsonObject:
    """The provider's error object, the part under `error`."""
    kind = error.get("type") or default_error_type(api, status)
    message = error.get("message", f"mock error {status}")
    code = error.get("code")
    if api == "messages":
        anthropic: JsonObject = {"type": kind, "message": message}
        if code is not None:
            anthropic["details"] = {"error_code": code}
        return anthropic
    return {"message": message, "type": kind, "param": None, "code": code}


def error_body(api: str, error: JsonObject, status: int) -> JsonObject:
    if api == "messages":
        return {"type": "error", "error": error_object(api, error, status)}
    return {"error": error_object(api, error, status)}


def responses_failure(error: JsonObject) -> JsonObject:
    """The `error` of a failed Responses response: `code` and `message`."""
    failure: JsonObject = {
        "code": error.get("code") or error.get("type") or "server_error",
        "message": error.get("message", "mock failure"),
    }
    if error.get("code") and error.get("type"):
        failure["type"] = error["type"]
    return failure


# --- Replies (non-stream bodies) -------------------------------------------------------------

CHAT_FINISH = {"stop": "stop", "length": "length", "tool_calls": "tool_calls"}
CHAT_FINISH["content_filter"] = "content_filter"
MESSAGES_FINISH = {
    "stop": "end_turn",
    "length": "max_tokens",
    "tool_calls": "tool_use",
    "content_filter": "refusal",
}
INCOMPLETE_REASONS = {"length": "max_output_tokens", "content_filter": "content_filter"}
DEFAULT_USAGE = {"input": 10, "output": 5}


def choices_of(reply: JsonObject) -> list[JsonObject]:
    if "choices" in reply:
        return list(reply["choices"])
    return [{key: reply[key] for key in ("text", "toolCalls", "finishReason") if key in reply}]


def finish_of(choice: JsonObject) -> str:
    if "finishReason" in choice:
        return str(choice["finishReason"])
    return "tool_calls" if choice.get("toolCalls") else "stop"


def usage_of(reply: JsonObject) -> JsonObject | None:
    return reply["usage"] if "usage" in reply else DEFAULT_USAGE


def openai_usage(usage: JsonObject, api: str) -> JsonObject:
    """Chat Completions and Responses usage: input totals include cache hits and writes."""
    names = (
        ("prompt_tokens", "completion_tokens", "prompt_tokens_details", "completion_tokens_details")
        if api == "chat-completions"
        else ("input_tokens", "output_tokens", "input_tokens_details", "output_tokens_details")
    )
    input_name, output_name, input_details, output_details = names
    fields: JsonObject = {}
    input_parts = [usage[key] for key in ("input", "cachedInput", "cacheWrite") if key in usage]
    if input_parts:
        fields[input_name] = sum(input_parts)
    details: JsonObject = {}
    if "cachedInput" in usage:
        details["cached_tokens"] = usage["cachedInput"]
    if "cacheWrite" in usage:
        details["cache_write_tokens"] = usage["cacheWrite"]
    if details:
        fields[input_details] = details
    if "output" in usage:
        fields[output_name] = usage["output"]
    if "reasoning" in usage:
        fields[output_details] = {"reasoning_tokens": usage["reasoning"]}
    if input_name in fields and output_name in fields:
        fields["total_tokens"] = fields[input_name] + fields[output_name]
    return fields


def anthropic_usage(usage: JsonObject) -> JsonObject:
    names = {
        "input": "input_tokens",
        "cachedInput": "cache_read_input_tokens",
        "cacheWrite": "cache_creation_input_tokens",
        "output": "output_tokens",
    }
    fields: JsonObject = {name: usage[key] for key, name in names.items() if key in usage}
    if "reasoning" in usage:
        fields["output_tokens_details"] = {"thinking_tokens": usage["reasoning"]}
    return fields


def chat_tool_call(rid: int, index: int, call: JsonObject) -> JsonObject:
    return {
        "id": f"call_mock_{rid}_{index}",
        "type": "function",
        "function": {"name": call["name"], "arguments": call["arguments"]},
    }


def chat_body(rid: int, model: str, reply: JsonObject) -> JsonObject:
    choices = []
    for index, choice in enumerate(choices_of(reply)):
        calls = choice.get("toolCalls") or []
        content = choice.get("text", None if calls else "")
        message: JsonObject = {"role": "assistant", "content": content, "refusal": None}
        if calls:
            message["tool_calls"] = [chat_tool_call(rid, k, call) for k, call in enumerate(calls)]
        finish = finish_of(choice)
        choices.append(
            {
                "index": index,
                "message": message,
                "logprobs": None,
                "finish_reason": CHAT_FINISH.get(finish, finish),
            }
        )
    body: JsonObject = {
        "id": f"chatcmpl-mock-{rid}",
        "object": "chat.completion",
        "created": 0,
        "model": model,
        "choices": choices,
    }
    usage = usage_of(reply)
    if usage is not None:
        body["usage"] = openai_usage(usage, "chat-completions")
    return body


def responses_items(rid: int, choice: JsonObject, done: bool) -> list[JsonObject]:
    status = "completed" if done else "in_progress"
    items: list[JsonObject] = []
    if choice.get("text") is not None or not choice.get("toolCalls"):
        items.append(
            {
                "type": "message",
                "id": f"msg_mock_{rid}_0",
                "status": status,
                "role": "assistant",
                "content": [
                    {"type": "output_text", "text": choice.get("text", ""), "annotations": []}
                ],
            }
        )
    for index, call in enumerate(choice.get("toolCalls") or []):
        items.append(
            {
                "type": "function_call",
                "id": f"fc_mock_{rid}_{index}",
                "call_id": f"call_mock_{rid}_{index}",
                "name": call["name"],
                "arguments": call["arguments"],
                "status": status,
            }
        )
    return items


def responses_status(reply: JsonObject, choice: JsonObject) -> tuple[str, JsonObject | None]:
    if "status" in reply:
        status = str(reply["status"])
    else:
        status = "incomplete" if finish_of(choice) in INCOMPLETE_REASONS else "completed"
    reason = INCOMPLETE_REASONS.get(finish_of(choice)) if status == "incomplete" else None
    return status, ({"reason": reason} if reason else None)


def responses_object(rid: int, model: str, reply: JsonObject, status: str) -> JsonObject:
    """A Responses response object; `status` decides whether output and usage are filled."""
    choice = choices_of(reply)[0]
    finished = status not in ("queued", "in_progress")
    incomplete = responses_status(reply, choice)[1] if status == "incomplete" else None
    usage = usage_of(reply) if finished else None
    error = responses_failure(reply["failure"]) if status == "failed" else None
    return {
        "id": f"resp_mock_{rid}",
        "object": "response",
        "created_at": 0,
        "status": status,
        "model": model,
        "output": responses_items(rid, choice, True) if finished and status != "failed" else [],
        "error": error,
        "incomplete_details": incomplete,
        "usage": openai_usage(usage, "responses") if usage is not None else None,
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
        "text": {"format": {"type": "text"}},
        "metadata": {},
    }


def responses_body(rid: int, model: str, reply: JsonObject) -> JsonObject:
    if "failure" in reply:
        return responses_object(rid, model, reply, "failed")
    status = responses_status(reply, choices_of(reply)[0])[0]
    return responses_object(rid, model, reply, status)


def tool_input(call: JsonObject) -> JsonObject:
    try:
        value = json.loads(call["arguments"])
    except ValueError as error:
        raise ScriptError(f"tool_use arguments must be a JSON object: {error}") from None
    if not isinstance(value, dict):
        raise ScriptError("tool_use arguments must be a JSON object")
    return value


def messages_content(rid: int, choice: JsonObject) -> list[JsonObject]:
    calls = choice.get("toolCalls") or []
    blocks: list[JsonObject] = []
    if choice.get("text") is not None or not calls:
        blocks.append({"type": "text", "text": choice.get("text", "")})
    for index, call in enumerate(calls):
        blocks.append(
            {
                "type": "tool_use",
                "id": f"toolu_mock_{rid}_{index}",
                "name": call["name"],
                "input": tool_input(call),
            }
        )
    return blocks


def messages_body(rid: int, model: str, reply: JsonObject) -> JsonObject:
    choice = choices_of(reply)[0]
    finish = finish_of(choice)
    body: JsonObject = {
        "id": f"msg_mock_{rid}",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": messages_content(rid, choice),
        "stop_reason": MESSAGES_FINISH.get(finish, finish),
        "stop_sequence": None,
    }
    usage = usage_of(reply)
    if usage is not None:
        body["usage"] = anthropic_usage(usage)
    return body


def reply_body(api: str, rid: int, model: str, reply: JsonObject) -> JsonObject:
    if api == "responses":
        return responses_body(rid, model, reply)
    if "failure" in reply:
        return error_body(api, reply["failure"], 200)
    if api == "messages":
        return messages_body(rid, model, reply)
    return chat_body(rid, model, reply)


# --- Replies as SSE streams ------------------------------------------------------------------


def split_text(text: str, pieces: int) -> list[str]:
    """`text` in up to `pieces` parts of near-equal length in code points; none for empty text."""
    if not text:
        return []
    count = min(pieces, len(text))
    size, extra = divmod(len(text), count)
    parts, start = [], 0
    for index in range(count):
        end = start + size + (1 if index < extra else 0)
        parts.append(text[start:end])
        start = end
    return parts


Event = JsonObject


class StreamParts:
    """A rendered stream in three parts, so `ending` can cut it between them."""

    def __init__(self) -> None:
        self.text: list[Event] = []
        self.generation_end: list[Event] = []
        self.end: list[Event] = []


def chat_stream(
    rid: int, model: str, reply: JsonObject, request: JsonObject, deltas: int
) -> StreamParts:
    parts = StreamParts()

    def chunk(choices: list[JsonObject], **extra: Any) -> Event:
        data = {
            "id": f"chatcmpl-mock-{rid}",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": model,
            "choices": choices,
        }
        data.update(extra)
        return {"data": data}

    def delta(index: int, body: JsonObject, finish: str | None = None) -> Event:
        choice = {"index": index, "delta": body, "logprobs": None, "finish_reason": finish}
        return chunk([choice])

    for index, choice in enumerate(choices_of(reply)):
        parts.text.append(delta(index, {"role": "assistant", "content": ""}))
        for piece in split_text(choice.get("text", ""), deltas):
            parts.text.append(delta(index, {"content": piece}))
        for k, call in enumerate(choice.get("toolCalls") or []):
            opening = chat_tool_call(rid, k, call)
            opening["function"] = {"name": call["name"], "arguments": ""}
            parts.text.append(delta(index, {"tool_calls": [{"index": k, **opening}]}))
            arguments = {"index": k, "function": {"arguments": call["arguments"]}}
            parts.text.append(delta(index, {"tool_calls": [arguments]}))
        finish = finish_of(choice)
        parts.generation_end.append(delta(index, {}, CHAT_FINISH.get(finish, finish)))
    options = request.get("stream_options")
    usage = usage_of(reply)
    if isinstance(options, dict) and options.get("include_usage") and usage is not None:
        parts.generation_end.append(chunk([], usage=openai_usage(usage, "chat-completions")))
    parts.end.append({"data": "[DONE]"})
    return parts


def responses_stream(rid: int, model: str, reply: JsonObject, deltas: int) -> StreamParts:
    parts = StreamParts()
    sequence = iter(range(1_000_000))

    def event(kind: str, **fields: Any) -> Event:
        return {"event": kind, "data": {"type": kind, "sequence_number": next(sequence), **fields}}

    choice = choices_of(reply)[0]
    started = responses_object(rid, model, reply, "in_progress")
    parts.text.append(event("response.created", response=started))
    parts.text.append(event("response.in_progress", response=started))
    for index, item in enumerate(responses_items(rid, choice, True)):
        opening = dict(item, status="in_progress")
        if item["type"] == "message":
            text = item["content"][0]["text"]
            opening["content"] = []
            parts.text.append(event("response.output_item.added", output_index=index, item=opening))
            empty = {"type": "output_text", "text": "", "annotations": []}
            ids = {"item_id": item["id"], "output_index": index, "content_index": 0}
            parts.text.append(event("response.content_part.added", **ids, part=empty))
            for piece in split_text(text, deltas):
                parts.text.append(event("response.output_text.delta", **ids, delta=piece))
            parts.generation_end.append(event("response.output_text.done", **ids, text=text))
            done_part = {"type": "output_text", "text": text, "annotations": []}
            parts.generation_end.append(event("response.content_part.done", **ids, part=done_part))
        else:
            opening["arguments"] = ""
            parts.text.append(event("response.output_item.added", output_index=index, item=opening))
            ids = {"item_id": item["id"], "output_index": index}
            arguments = item["arguments"]
            parts.text.append(
                event("response.function_call_arguments.delta", **ids, delta=arguments)
            )
            parts.generation_end.append(
                event("response.function_call_arguments.done", **ids, arguments=arguments)
            )
        parts.generation_end.append(
            event("response.output_item.done", output_index=index, item=item)
        )
    status = responses_status(reply, choice)[0]
    final = responses_object(rid, model, reply, status)
    parts.end.append(event(f"response.{status}", response=final))
    return parts


def messages_stream(rid: int, model: str, reply: JsonObject, deltas: int) -> StreamParts:
    parts = StreamParts()

    def event(kind: str, **fields: Any) -> Event:
        return {"event": kind, "data": {"type": kind, **fields}}

    choice = choices_of(reply)[0]
    usage = anthropic_usage(usage_of(reply) or {"input": 0, "output": 0})
    opening_usage = {key: value for key, value in usage.items() if key != "output_tokens"}
    message = dict(messages_body(rid, model, {**reply, "usage": None}), content=[])
    message.update(stop_reason=None, usage={**opening_usage, "output_tokens": 1})
    parts.text.append(event("message_start", message=message))
    parts.text.append(event("ping"))
    arguments = iter(call["arguments"] for call in choice.get("toolCalls") or [])
    for index, block in enumerate(messages_content(rid, choice)):
        opening: JsonObject
        if block["type"] == "text":
            opening = {"type": "text", "text": ""}
            deltas_of_block = [
                {"type": "text_delta", "text": piece} for piece in split_text(block["text"], deltas)
            ]
        else:
            opening = {**block, "input": {}}
            deltas_of_block = [{"type": "input_json_delta", "partial_json": next(arguments)}]
        parts.text.append(event("content_block_start", index=index, content_block=opening))
        for delta in deltas_of_block:
            parts.text.append(event("content_block_delta", index=index, delta=delta))
        parts.text.append(event("content_block_stop", index=index))
    finish = finish_of(choice)
    stop = {"stop_reason": MESSAGES_FINISH.get(finish, finish), "stop_sequence": None}
    closing_usage = {"output_tokens": usage.get("output_tokens", 0)}
    parts.generation_end.append(event("message_delta", delta=stop, usage=closing_usage))
    parts.end.append(event("message_stop"))
    return parts


def failure_event(api: str, rid: int, model: str, reply: JsonObject) -> Event:
    error = reply.get("failure") or {}
    if api == "responses":
        failed = responses_object(rid, model, reply, "failed")
        return {"event": "response.failed", "data": {"type": "response.failed", "response": failed}}
    if api == "messages":
        return {"event": "error", "data": error_body(api, error, 200)}
    return {"data": {"error": error_object(api, error, 200)}}


def stream_events(
    api: str, rid: int, model: str, reply: JsonObject, request: JsonObject, options: JsonObject
) -> list[Event]:
    deltas = int(options.get("deltas", 2))
    if api == "responses":
        parts = responses_stream(rid, model, reply, deltas)
    elif api == "messages":
        parts = messages_stream(rid, model, reply, deltas)
    else:
        parts = chat_stream(rid, model, reply, request, deltas)
    ending = options.get("ending", "end-event")
    if ending == "text-only":
        return parts.text
    if ending == "failure":
        if "failure" not in reply:
            raise ScriptError("stream ending `failure` needs reply.failure")
        return parts.text + [failure_event(api, rid, model, reply)]
    if ending == "no-end-event":
        return parts.text + parts.generation_end
    return parts.text + parts.generation_end + parts.end


def event_text(event: Event) -> str:
    """One SSE event with its final empty line."""
    lines = []
    if "comment" in event:
        lines.append(f": {event['comment']}")
    if "event" in event:
        lines.append(f"event: {event['event']}")
    if "id" in event:
        lines.append(f"id: {event['id']}")
    if "data" in event:
        data = event["data"]
        text = data if isinstance(data, str) else compact_json(data)
        lines.extend(f"data: {line}" for line in text.split("\n"))
    return "".join(f"{line}\n" for line in lines) + "\n"


def end_last_line(text: str, last_line: str) -> str:
    """Removes the final empty line (`line-end`) or also the last line end (`none`)."""
    if last_line == "line-end" and text.endswith("\n\n"):
        return text[:-1]
    if last_line == "none" and text.endswith("\n\n"):
        return text[:-2]
    return text


def sse_chunks(chunks: list[JsonObject], last_line: str) -> list[tuple[int, bytes]]:
    """(delay before the chunk in ms, bytes) per chunk of a literal SSE body."""
    rendered: list[tuple[int, str]] = []
    for chunk in chunks:
        text = chunk["text"] if "text" in chunk else "".join(map(event_text, chunk["events"]))
        rendered.append((int(chunk.get("delayMs", 0)), text))
    if rendered:
        delay, text = rendered[-1]
        rendered[-1] = (delay, end_last_line(text, last_line))
    return [(delay, text.encode("utf-8")) for delay, text in rendered]


def stream_chunks(events: list[Event], options: JsonObject) -> list[tuple[int, bytes]]:
    per_chunk = int(options.get("eventsPerChunk", 1))
    delays = list(options.get("chunkDelaysMs", []))
    groups = [events[start : start + per_chunk] for start in range(0, len(events), per_chunk)]
    chunks = [
        {"events": group, "delayMs": delays[index] if index < len(delays) else 0}
        for index, group in enumerate(groups)
    ]
    return sse_chunks(chunks, options.get("lastLine", "blank-line"))


# --- Building the response -------------------------------------------------------------------


class Response:
    """What to send: status, headers and the body as chunks, each after its delay."""

    def __init__(
        self, status: int, headers: dict[str, str], chunks: list[tuple[int, bytes]], sse: bool
    ) -> None:
        self.status = status
        self.headers = headers
        self.chunks = chunks
        self.sse = sse


def accepted_encodings(header: str | None) -> set[str]:
    """Content codings the request's accept-encoding names, leaving out those with q=0."""
    accepted = set()
    for item in (header or "").split(","):
        name, *params = [part.strip() for part in item.split(";")]
        quality = next((param[2:] for param in params if param.lower().startswith("q=")), "1")
        try:
            acceptable = float(quality) > 0
        except ValueError:
            acceptable = False
        if name and acceptable:
            accepted.add(name.lower())
    return accepted


def stored_chunks(value: Any) -> list[bytes]:
    blobs = value if isinstance(value, list) else [value]
    return [base64.b64decode(blob) for blob in blobs]


def gzip_chunks(chunks: list[bytes]) -> list[bytes]:
    """One gzip stream, flushed after each chunk, so each chunk decodes as it arrives and the
    chunk delays keep their meaning."""
    compressor = zlib.compressobj(wbits=31)
    blobs = [compressor.compress(chunk) + compressor.flush(zlib.Z_SYNC_FLUSH) for chunk in chunks]
    if not blobs:
        blobs.append(b"")
    blobs[-1] += compressor.flush()
    return blobs


def compress(response: Response, entry: JsonObject, accept_encoding: str | None) -> str:
    """Compresses the body when the entry asks for an encoding the request accepts."""
    encoding = entry.get("encoding")
    if encoding is None or encoding not in accepted_encodings(accept_encoding):
        return "identity"
    stored = (entry.get("compressed") or {}).get(encoding)
    if stored is not None:
        blobs = stored_chunks(stored)
    elif encoding == "gzip":
        blobs = gzip_chunks([chunk for _, chunk in response.chunks])
    else:
        raise ScriptError(f"encoding {encoding} needs the body stored in compressed.{encoding}")
    delays = [delay for delay, _ in response.chunks]
    response.chunks = [
        (delays[index] if index < len(delays) else 0, blob) for index, blob in enumerate(blobs)
    ]
    response.headers["content-encoding"] = str(encoding)
    return str(encoding)


def build_response(entry: JsonObject, api: str, request: JsonObject, rid: int) -> Response:
    model = str(request.get("model") or "model")
    if "reply" in entry:
        reply = entry["reply"]
        model = str(reply.get("model", model))
        if request.get("stream") is True:
            options = entry.get("stream") or {}
            events = stream_events(api, rid, model, reply, request, options)
            return Response(int(entry.get("status", 200)), {}, stream_chunks(events, options), True)
        body = compact_json(reply_body(api, rid, model, reply)).encode("utf-8")
        return Response(int(entry.get("status", 200)), {}, [(0, body)], False)
    if "error" in entry:
        status = int(entry.get("status", entry["error"].get("status", 500)))
        body = compact_json(error_body(api, entry["error"], status)).encode("utf-8")
        return Response(status, {}, [(0, body)], False)
    if "sse" in entry:
        sse = entry["sse"]
        chunks = sse_chunks(sse["chunks"], sse.get("lastLine", "blank-line"))
        return Response(int(entry.get("status", 200)), {}, chunks, True)
    text = entry["text"] if "text" in entry else compact_json(entry["body"])
    return Response(int(entry.get("status", 200)), {}, [(0, text.encode("utf-8"))], False)


def unscripted(api: str, message: str) -> Response:
    body = compact_json(error_body(api, {"type": "mock_script_error", "message": message}, 500))
    return Response(500, {}, [(0, body.encode("utf-8"))], False)


# --- HTTP handling ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: MockHTTPServer

    def do_GET(self) -> None:
        self.dispatch()

    def do_POST(self) -> None:
        self.dispatch()

    def do_PUT(self) -> None:
        self.dispatch()

    def do_DELETE(self) -> None:
        self.dispatch()

    def do_PATCH(self) -> None:
        self.dispatch()

    def log_message(self, format: str, *args: Any) -> None:
        """Requests go to the request log, not to stderr."""

    def dispatch(self) -> None:
        try:
            if self.path.startswith(CONTROL_PREFIX):
                self.control()
            else:
                self.answer()
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
            self.close_connection = True

    # Control path

    def control(self) -> None:
        body = self.read_body()
        action = self.path[len(CONTROL_PREFIX) :].split("?", 1)[0]
        handlers: dict[str, Callable[[Any], Any]] = {
            "script": self.load_script,
            "log": lambda _: {"requests": self.server.book.log()},
            "reset": self.reset,
            "tls": self.start_tls,
        }
        handler = handlers.get(action)
        if handler is None:
            self.send_json(404, {"error": f"unknown control path {self.path}"})
            return
        try:
            self.send_json(200, handler(parse_json(body)))
        except ScriptError as error:
            self.send_json(400, {"error": str(error)})

    def load_script(self, body: Any) -> JsonObject:
        if not isinstance(body, dict) or not isinstance(body.get("requests"), list):
            raise ScriptError('the script is {"requests": [entry, ...]}')
        self.server.book.load(body["requests"])
        return {"loaded": len(body["requests"])}

    def reset(self, _: Any) -> JsonObject:
        self.server.book.reset()
        return {"reset": True}

    def start_tls(self, body: Any) -> JsonObject:
        name = body.get("certificate") if isinstance(body, dict) else None
        if name not in CERTIFICATES:
            raise ScriptError(f"certificate is one of {', '.join(CERTIFICATES)}")
        return {"port": self.server.tls_port(name)}

    def send_json(self, status: int, value: Any) -> None:
        body = compact_json(value).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # API requests

    def answer(self) -> None:
        book = self.server.book
        method, path = self.command, self.path.split("?", 1)[0]
        record: JsonObject = {
            "method": method,
            "path": path,
            "api": api_of(path),
            "model": None,
            "stream": False,
            "headers": {name.lower(): value for name, value in self.headers.items()},
            "body": None,
            "scripted": False,
            "servedEncoding": None,
        }
        early = book.peek(method, path)
        if early is not None and early.get("connection") == "close-unread":
            book.take(method, path, None)
            record["scripted"] = True
            book.record(record)
            book.publish(record)
            self.drop_connection()
            return
        raw_body = self.read_body()
        body = parse_json(raw_body)
        request = body if isinstance(body, dict) else {}
        model = request.get("model")
        record.update(
            model=model if isinstance(model, str) else None,
            stream=request.get("stream") is True,
            body=body if body is not None else raw_body.decode("utf-8", "replace"),
        )
        entry = book.take(method, path, body) if book.loaded else None
        record["scripted"] = entry is not None
        book.record(record)
        self.respond(entry, record, request)

    def respond(self, entry: JsonObject | None, record: JsonObject, request: JsonObject) -> None:
        book = self.server.book
        api = format_of(record["path"])
        if entry is None:
            message = "no script entry for this request" if book.loaded else "no script loaded"
            book.publish(record)
            self.send(unscripted(api, f"mock server: {message}"), None)
            return
        time.sleep(int(entry.get("delayMs", 0)) / 1000)
        if entry.get("connection") == "close-before-headers":
            book.publish(record)
            self.drop_connection()
            return
        try:
            response = build_response(entry, api, request, book.next_id())
            served = compress(response, entry, self.headers.get("accept-encoding"))
        except ScriptError as error:
            book.publish(record)
            self.send(unscripted(api, f"mock server: {error}"), None)
            return
        book.update(record, servedEncoding=served)
        book.publish(record)
        response.headers.update(
            {name.lower(): value for name, value in (entry.get("headers") or {}).items()}
        )
        self.send(response, entry.get("drop"))

    def send(self, response: Response, drop: JsonObject | None) -> None:
        content_type = "text/event-stream" if response.sse else "application/json"
        headers = {"content-type": content_type, **response.headers}
        chunked = response.sse or len(response.chunks) > 1
        if chunked:
            headers["transfer-encoding"] = "chunked"
        else:
            headers["content-length"] = str(sum(len(chunk) for _, chunk in response.chunks))
        self.send_response(response.status)
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        whole = len(response.chunks) if drop is None else int(drop.get("chunks", 0))
        for delay, chunk in response.chunks[:whole]:
            time.sleep(delay / 1000)
            self.wfile.write(frame(chunk) if chunked else chunk)
        if drop is not None:
            self.send_partial(response.chunks[whole:], int(drop.get("bytes", 0)), chunked)
            self.drop_connection()
        elif chunked:
            self.wfile.write(b"0\r\n\r\n")

    def send_partial(self, rest: list[tuple[int, bytes]], count: int, chunked: bool) -> None:
        """The first `count` bytes of the next chunk, its chunk header announcing all of it."""
        if not rest or count == 0:
            return
        delay, chunk = rest[0]
        time.sleep(delay / 1000)
        head = f"{len(chunk):x}\r\n".encode("ascii") if chunked else b""
        self.wfile.write(head + chunk[:count])

    def read_body(self) -> bytes:
        if self.headers.get("transfer-encoding", "").lower() == "chunked":
            return self.read_chunked()
        length = int(self.headers.get("content-length") or 0)
        return self.rfile.read(length) if length else b""

    def read_chunked(self) -> bytes:
        body = b""
        while True:
            size = int(self.rfile.readline().split(b";", 1)[0].strip() or b"0", 16)
            if size == 0:
                self.rfile.readline()
                return body
            body += self.rfile.read(size)
            self.rfile.readline()

    def drop_connection(self) -> None:
        self.close_connection = True
        self.wfile.flush()
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


def frame(chunk: bytes) -> bytes:
    """One chunk of the chunked transfer coding."""
    return f"{len(chunk):x}\r\n".encode("ascii") + chunk + b"\r\n" if chunk else b""


def parse_json(body: bytes) -> Any:
    if not body:
        return None
    try:
        return json.loads(body)
    except ValueError:
        return None


# --- Servers ---------------------------------------------------------------------------------


class MockHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        address: tuple[str, int],
        book: ScriptBook,
        tls_dir: Path,
        context: ssl.SSLContext | None = None,
    ) -> None:
        super().__init__(address, Handler)
        self.book = book
        self.tls_dir = tls_dir
        self.context = context
        self.tls_listeners: dict[str, MockHTTPServer] = {}
        self.lock = threading.Lock()

    def finish_request(self, request: Any, client_address: Any) -> None:
        """TLS handshakes run in the connection's thread, so a refused one blocks no other."""
        if self.context is not None:
            try:
                request = self.context.wrap_socket(request, server_side=True)
            except (ssl.SSLError, OSError):
                request.close()
                return
        super().finish_request(request, client_address)

    def handle_error(self, request: Any, client_address: Any) -> None:
        error = sys.exc_info()[1]
        if not isinstance(error, (ConnectionError, ssl.SSLError, TimeoutError)):
            super().handle_error(request, client_address)

    def tls_port(self, name: str) -> int:
        with self.lock:
            if name not in self.tls_listeners:
                chain, key = CERTIFICATES[name]
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                context.load_cert_chain(self.tls_dir / chain, self.tls_dir / key)
                host = str(self.server_address[0])
                listener = MockHTTPServer((host, 0), self.book, self.tls_dir, context)
                threading.Thread(target=listener.serve_forever, args=(POLL_S,), daemon=True).start()
                self.tls_listeners[name] = listener
            return self.tls_listeners[name].server_address[1]

    def server_close(self) -> None:
        for listener in self.tls_listeners.values():
            listener.shutdown()
            listener.server_close()
        super().server_close()


class MockServer:
    """The mock server in a background thread, for tests that run it in their own process."""

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 0,
        print_log: bool = False,
        tls_dir: Path = TLS_DIR,
    ) -> None:
        self.host = host
        self.book = ScriptBook(print_log)
        self.http = MockHTTPServer((host, port), self.book, tls_dir)
        self.thread = threading.Thread(target=self.http.serve_forever, args=(POLL_S,), daemon=True)

    @property
    def port(self) -> int:
        return int(self.http.server_address[1])

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}"

    def start(self) -> MockServer:
        self.thread.start()
        return self

    def stop(self) -> None:
        self.http.shutdown()
        self.http.server_close()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Mock OpenAI and Anthropic API server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787, help="0 picks a free port")
    parser.add_argument("--log", action="store_true", help="print every received request")
    args = parser.parse_args(argv)
    server = MockServer(args.host, args.port, args.log)
    print(f"mock API server listening on {server.url}", flush=True)
    try:
        server.http.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.http.server_close()


if __name__ == "__main__":
    main()
