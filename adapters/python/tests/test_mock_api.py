"""The mock API server on its own, through the standard library only, so a broken server is not
mistaken for a helper bug. These are the behaviours later tests take as their oracle: compression,
connection faults, SSE framing and timing, script order and the request log, and TLS (T007)."""

from __future__ import annotations

import base64
import http.client
import json
import math
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import zlib
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from protocol_client import PYTHON_DIR, ROOT_CA, MockApi

import mock_api.server as server_module
from mock_api.server import CERTIFICATES, MockServer

SERVER = PYTHON_DIR / "mock_api" / "server.py"
CHAT = "/v1/chat/completions"
MESSAGES = "/v1/messages"
DELAY_MS = 150
# Only lower bounds on elapsed time are checked, so a slow machine cannot fail them.
DELAY_S = DELAY_MS / 1000 * 0.8


def address(mock: MockApi) -> tuple[str, int]:
    host, port = mock.url.removeprefix("http://").split(":")
    return host, int(port)


def send(
    mock: MockApi,
    path: str = CHAT,
    body: Any = None,
    accept_encoding: str | None = "identity",
    method: str = "POST",
    headers: dict[str, str] | None = None,
) -> http.client.HTTPResponse:
    """One request; `accept_encoding` None sends no accept-encoding header at all."""
    connection = http.client.HTTPConnection(*address(mock), timeout=10)
    default = {"model": "model-b"} if method == "POST" else None
    payload = b"" if body is None and default is None else json.dumps(body or default).encode()
    connection.putrequest(method, path, skip_accept_encoding=True)
    if accept_encoding is not None:
        connection.putheader("accept-encoding", accept_encoding)
    for name, value in (headers or {}).items():
        connection.putheader(name, value)
    connection.putheader("content-type", "application/json")
    connection.putheader("content-length", str(len(payload)))
    connection.endheaders(payload)
    return connection.getresponse()


def raw_exchange(mock: MockApi, request: bytes) -> bytes:
    """Every byte the server sends back on one connection until it closes it."""
    received = b""
    with socket.create_connection(address(mock), timeout=10) as connection:
        try:
            connection.sendall(request)
            while chunk := connection.recv(65536):
                received += chunk
        except ConnectionResetError:
            pass
    return received


def raw_post(
    mock: MockApi, body: bytes = b'{"model": "model-b"}', length: int | None = None
) -> bytes:
    declared = len(body) if length is None else length
    head = (
        f"POST {CHAT} HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n"
        f"content-type: application/json\r\ncontent-length: {declared}\r\n\r\n"
    )
    return raw_exchange(mock, head.encode() + body)


def head_and_body(response: bytes) -> tuple[bytes, bytes]:
    head, _, body = response.partition(b"\r\n\r\n")
    return head, body


def chunks_of(response: http.client.HTTPResponse) -> Iterator[tuple[float, bytes]]:
    """Each chunk of a chunked body with the time it arrived."""
    while chunk := response.read1(1 << 20):
        yield time.monotonic(), chunk


def events_in(chunk: bytes) -> int:
    return chunk.count(b"\n\n")


# --- Compression ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("accept", "served"),
    [
        ("gzip, br", "gzip"),
        ("br;q=1, gzip;q=0.5", "gzip"),
        ("gzip;q=0, br", "identity"),
        ("GZIP;Q=0", "identity"),
        ("identity", "identity"),
        (None, "identity"),
    ],
)
def test_003_SC_002_gzip_is_sent_only_when_accept_encoding_names_it(
    mock_api: MockApi, accept: str | None, served: str
) -> None:
    mock_api.load([{"text": '{"zipped": true}', "encoding": "gzip"}])
    response = send(mock_api, accept_encoding=accept)
    body = response.read()
    if served == "gzip":
        assert response.getheader("content-encoding") == "gzip"
        body = zlib.decompress(body, wbits=31)
    else:
        assert response.getheader("content-encoding") is None
    assert body == b'{"zipped": true}'
    assert mock_api.log()[0]["servedEncoding"] == served


@pytest.mark.parametrize("encoding", ["br", "zstd"])
def test_003_SC_002_a_stored_blob_is_sent_byte_for_byte_when_named(
    mock_api: MockApi, encoding: str
) -> None:
    stored = bytes(range(256))
    entry = {
        "text": '{"plain": true}',
        "encoding": encoding,
        "compressed": {encoding: base64.b64encode(stored).decode()},
    }
    mock_api.load([entry, entry])
    named = send(mock_api, accept_encoding=f"gzip, {encoding}")
    assert (named.getheader("content-encoding"), named.read()) == (encoding, stored)
    plain = send(mock_api, accept_encoding="gzip")
    assert (plain.getheader("content-encoding"), plain.read()) == (None, b'{"plain": true}')
    assert [record["servedEncoding"] for record in mock_api.log()] == [encoding, "identity"]


def test_003_SC_002_br_without_a_stored_blob_is_a_script_error(mock_api: MockApi) -> None:
    mock_api.load([{"text": "{}", "encoding": "br"}])
    response = send(mock_api, accept_encoding="br")
    assert response.status == 500
    error = json.loads(response.read())["error"]
    assert error["type"] == "mock_script_error"
    assert "compressed.br" in error["message"]


def test_003_SC_002_a_gzip_stream_decodes_chunk_by_chunk_as_it_arrives(mock_api: MockApi) -> None:
    chunks = [{"text": "data: one\n\n"}, {"text": "data: two\n\n", "delayMs": DELAY_MS}]
    mock_api.load([{"sse": {"chunks": chunks}, "encoding": "gzip"}])
    arrived = list(chunks_of(send(mock_api, accept_encoding="gzip")))
    decoder = zlib.decompressobj(wbits=31)
    assert [decoder.decompress(chunk) for _, chunk in arrived] == [
        b"data: one\n\n",
        b"data: two\n\n",
    ]
    assert decoder.eof
    assert arrived[1][0] - arrived[0][0] >= DELAY_S


@pytest.mark.parametrize(
    ("entry", "body"),
    [
        ({"text": '{"a": 1}'}, b'{"a": 1}'),
        ({"sse": {"chunks": [{"text": "data: a\n\n"}]}}, b"data: a\n\n"),
    ],
)
def test_003_SC_002_bom_puts_the_utf_8_byte_order_mark_before_the_body(
    mock_api: MockApi, entry: dict[str, Any], body: bytes
) -> None:
    mock_api.load([{**entry, "bom": True}, entry])
    assert send(mock_api).read() == b"\xef\xbb\xbf" + body
    assert send(mock_api).read() == body


# --- Connections ----------------------------------------------------------------------------


def test_003_SC_002_a_delay_comes_before_the_status_line(mock_api: MockApi) -> None:
    mock_api.load([{"text": "{}", "delayMs": DELAY_MS}])
    started = time.monotonic()
    response = send(mock_api)
    assert time.monotonic() - started >= DELAY_S
    assert response.status == 200


def test_003_SC_002_close_before_headers_sends_no_status_line(mock_api: MockApi) -> None:
    mock_api.load([{"connection": "close-before-headers"}])
    assert raw_post(mock_api) == b""
    assert [(record["model"], record["scripted"]) for record in mock_api.log()] == [
        ("model-b", True)
    ]


def test_003_SC_002_close_unread_ends_without_a_response_and_logs_the_request(
    mock_api: MockApi,
) -> None:
    mock_api.load([{"connection": "close-unread"}])
    assert raw_post(mock_api, b'{"model": "model-b"', length=1_000_000) == b""
    assert [(record["path"], record["body"], record["scripted"]) for record in mock_api.log()] == [
        (CHAT, None, True)
    ]


def test_003_SC_002_a_drop_sends_exactly_the_bytes_before_it(mock_api: MockApi) -> None:
    text = "0123456789abcdefghijklmnopqrstuvwxyz"
    mock_api.load([{"text": text, "drop": {"chunks": 0, "bytes": 10}}])
    head, body = head_and_body(raw_post(mock_api))
    assert f"content-length: {len(text)}".encode() in head.lower()
    assert body == b"0123456789"


def test_003_SC_002_a_stream_drop_has_no_terminating_chunk(mock_api: MockApi) -> None:
    chunks = [{"text": "data: a\n\n"}, {"text": "data: b\n\n"}, {"text": "data: ccc\n\n"}]
    mock_api.load([{"sse": {"chunks": chunks}, "drop": {"chunks": 2, "bytes": 4}}])
    head, body = head_and_body(raw_post(mock_api))
    assert b"transfer-encoding: chunked" in head.lower()
    assert body == b"9\r\ndata: a\n\n\r\n9\r\ndata: b\n\n\r\nb\r\ndata"


def test_003_SC_002_a_whole_stream_ends_with_the_terminating_chunk(mock_api: MockApi) -> None:
    mock_api.load([{"sse": {"chunks": [{"text": "data: a\n\n"}]}}])
    assert head_and_body(raw_post(mock_api))[1] == b"9\r\ndata: a\n\n\r\n0\r\n\r\n"


# --- SSE ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("last_line", "body"),
    [
        ("blank-line", b"data: a\n\ndata: [DONE]\n\n"),
        ("line-end", b"data: a\n\ndata: [DONE]\n"),
        ("none", b"data: a\n\ndata: [DONE]"),
    ],
)
def test_003_SC_002_the_last_event_can_lack_its_empty_line_or_its_line_end(
    mock_api: MockApi, last_line: str, body: bytes
) -> None:
    sse = {"chunks": [{"events": [{"data": "a"}, {"data": "[DONE]"}]}], "lastLine": last_line}
    reply = {"reply": {"text": "x"}, "stream": {"lastLine": last_line}}
    mock_api.load([{"sse": sse}, reply])
    assert send(mock_api).read() == body
    rendered = send(mock_api, body={"model": "model-b", "stream": True}).read()
    assert rendered.endswith(body[len(b"data: a\n\n") :])


def test_003_SC_002_events_per_chunk_groups_a_rendered_stream(mock_api: MockApi) -> None:
    reply = {"reply": {"text": "abcdef"}}
    mock_api.load(
        [dict(reply, stream={"deltas": 3}), dict(reply, stream={"deltas": 3, "eventsPerChunk": 4})]
    )
    request = {"model": "model-b", "stream": True}
    single = [events_in(chunk) for _, chunk in chunks_of(send(mock_api, body=request))]
    grouped = [events_in(chunk) for _, chunk in chunks_of(send(mock_api, body=request))]
    assert set(single) == {1}
    assert len(grouped) == math.ceil(len(single) / 4)
    assert grouped[:-1] == [4] * (len(grouped) - 1)
    assert sum(grouped) == len(single)


def test_003_SC_002_chunk_delays_split_chunks_in_time(mock_api: MockApi) -> None:
    stream = {"deltas": 2, "chunkDelaysMs": [0, 0, DELAY_MS]}
    mock_api.load([{"reply": {"text": "abcd"}, "stream": stream}])
    arrived = [
        moment for moment, _ in chunks_of(send(mock_api, body={"model": "m", "stream": True}))
    ]
    assert arrived[2] - arrived[1] >= DELAY_S


def test_003_SC_002_body_chunks_split_a_json_body_in_time(mock_api: MockApi) -> None:
    body = {"id": "resp-1", "status": "completed"}
    text = json.dumps(body, separators=(",", ":")).encode()
    chunking = {"splitAt": [5, 12], "chunkDelaysMs": [0, DELAY_MS]}
    mock_api.load([{"body": body, "bodyChunks": chunking}])
    response = send(mock_api)
    arrived = list(chunks_of(response))
    assert response.getheader("transfer-encoding") == "chunked"
    assert [chunk for _, chunk in arrived] == [text[:5], text[5:12], text[12:]]
    assert arrived[1][0] - arrived[0][0] >= DELAY_S


def load_error(mock: MockApi, entry: dict[str, Any]) -> str:
    """The message of the 400 a script load is refused with."""
    with pytest.raises(urllib.error.HTTPError) as refused:
        mock.load([entry])
    assert refused.value.code == 400
    message: str = json.loads(refused.value.read())["error"]
    return message


STORED_GZIP = base64.b64encode(zlib.compress(b"abc")).decode()


@pytest.mark.parametrize(
    ("entry", "named"),
    [
        ({"text": "abc", "bodyChunks": {"splitAt": [3]}}, "splitAt must fall inside"),
        ({"text": "abc", "bodyChunks": {"splitAt": [2, 1]}}, "splitAt must be positive"),
        ({"text": "abc", "bodyChunks": {"splitAt": [0]}}, "splitAt must be positive"),
        (
            {"text": "abc", "bodyChunks": {"splitAt": [1], "chunkDelaysMs": [0, 0, 5]}},
            "chunkDelaysMs has more entries",
        ),
        (
            {"reply": {"text": "abc"}, "stream": {}, "bodyChunks": {"splitAt": [1]}},
            "a stream reply",
        ),
        (
            {"sse": {"chunks": [{"text": "data: {}\n\n"}]}, "bodyChunks": {"splitAt": [1]}},
            "an sse body",
        ),
        (
            {
                "text": "abc",
                "encoding": "gzip",
                "compressed": {"gzip": STORED_GZIP},
                "bodyChunks": {"splitAt": [1]},
            },
            "a stored body",
        ),
    ],
)
def test_003_SC_002_body_chunks_the_server_cannot_apply_fail_the_script_load(
    mock_api: MockApi, entry: dict[str, Any], named: str
) -> None:
    assert named in load_error(mock_api, entry)


@pytest.mark.parametrize(
    ("entry", "request_body", "named"),
    [
        (
            {"reply": {"text": "abc"}, "bodyChunks": {"splitAt": [100000]}},
            None,
            "splitAt must fall inside",
        ),
        (
            {"reply": {"text": "abc"}, "bodyChunks": {"splitAt": [1]}},
            {"model": "m", "stream": True},
            "not SSE",
        ),
    ],
)
def test_003_SC_002_body_chunks_that_only_a_request_shows_wrong_are_a_script_error(
    mock_api: MockApi, entry: dict[str, Any], request_body: Any, named: str
) -> None:
    """A reply body is written per request, and a reply is SSE only when the request asks for a
    stream, so these two are found when the request arrives."""
    mock_api.load([entry])
    response = send(mock_api, body=request_body)
    assert response.status == 500
    assert named in response.read().decode()


# --- Script and request log -----------------------------------------------------------------


def test_003_SC_002_entries_answer_in_send_order_with_times_and_match(mock_api: MockApi) -> None:
    mock_api.load(
        [
            {"times": 2, "text": "first"},
            {"match": {"path": "/messages"}, "text": "messages"},
            {"match": {"model": "model-a"}, "text": "model-a"},
            {"text": "last"},
        ]
    )
    answers = [
        send(mock_api).read(),
        send(mock_api).read(),
        send(mock_api, body={"model": "model-a"}).read(),
        send(mock_api).read(),
        send(mock_api, MESSAGES).read(),
    ]
    assert answers == [b"first", b"first", b"model-a", b"last", b"messages"]


def test_003_SC_002_match_headers_pick_the_entry_whatever_order_the_requests_arrive_in(
    mock_api: MockApi,
) -> None:
    mock_api.load(
        [
            {"match": {"headers": {"X-Mock-Call": "late"}}, "text": "for late"},
            {"match": {"headers": {"x-mock-call": "early"}}, "text": "for early"},
        ]
    )
    early = send(mock_api, headers={"x-mock-call": "early"}).read()
    late = send(mock_api, headers={"x-mock-call": "late"}).read()
    assert (early, late) == (b"for early", b"for late")


NO_ENTRY = ("mock_script_error", "mock server: no script entry for this request")
STREAM = {"model": "model-b", "stream": True}
# Far below the 20 s cap, so a wait that does not end early fails this bound.
GIVE_UP_S = 5.0


def in_thread(work: Callable[[], Any]) -> Callable[[], Any]:
    """Runs `work` in a thread; the returned function joins it and gives its value or error."""
    outcome: dict[str, Any] = {}

    def run() -> None:
        try:
            outcome["value"] = work()
        except Exception as error:
            outcome["error"] = error

    thread = threading.Thread(target=run, daemon=True)
    thread.start()

    def result() -> Any:
        thread.join(timeout=30)
        if "error" in outcome:
            raise outcome["error"]
        return outcome["value"]

    return result


def wait_for_log(mock: MockApi, count: int) -> None:
    deadline = time.monotonic() + 10
    while len(mock.log()) < count:
        assert time.monotonic() < deadline, f"the server did not log {count} requests"
        time.sleep(0.01)


def read_all(response: http.client.HTTPResponse) -> bytes:
    try:
        return response.read()
    except http.client.IncompleteRead as error:
        return b"dropped:" + error.partial


def test_003_SC_002_a_request_whose_script_was_replaced_is_left_out_of_the_new_log() -> None:
    book = server_module.ScriptBook(print_log=False)
    book.load([{"text": "old"}])
    entry, generation = book.take(server_module.RequestHead("POST", CHAT, {}), {})
    assert entry == {"text": "old"}
    book.load([{"text": "new"}])
    assert book.record({"path": CHAT}, generation) is False
    assert book.record({"path": CHAT}, book.generation) is True
    assert len(book.log()) == 1


@pytest.mark.parametrize("delay_ms", [0, 500], ids=["no delay", "reset before the wait"])
def test_003_SC_002_a_response_held_by_after_requests_gives_up_when_the_script_is_replaced(
    mock_api: MockApi, delay_ms: int
) -> None:
    mock_api.load([{"afterRequests": 2, "delayMs": delay_ms, "text": "late"}])
    started = time.monotonic()
    response = in_thread(lambda: script_error(send(mock_api)))
    wait_for_log(mock_api, 1)
    mock_api.reset()
    message = "mock server: the response gave up waiting: the script was replaced"
    assert response() == ("mock_script_error", message)
    assert time.monotonic() - started < GIVE_UP_S


@pytest.mark.parametrize("delay_ms", [0, 500], ids=["no delay", "reset before the wait"])
def test_003_SC_002_a_chunk_held_by_chunk_after_requests_gives_up_when_the_script_is_replaced(
    mock_api: MockApi, delay_ms: int
) -> None:
    stream = {"chunkAfterRequests": [0, 2], "chunkDelaysMs": [0, delay_ms]}
    entry = {"reply": {"text": "Hello."}, "stream": stream}
    mock_api.load([entry])
    started = time.monotonic()
    body = in_thread(lambda: read_all(send(mock_api, body=STREAM)))
    wait_for_log(mock_api, 1)
    mock_api.load([])
    assert body().startswith(b"dropped:")
    assert time.monotonic() - started < GIVE_UP_S


@pytest.mark.parametrize("path", [CHAT, "/v1/responses", MESSAGES])
def test_003_SC_002_after_text_holds_the_rest_of_a_stream_until_the_next_request(
    mock_api: MockApi, path: str
) -> None:
    after = {"text": "BAD", "requests": 2}
    entry = {"reply": {"text": "Part one BAD part."}, "stream": {"deltas": 3, "afterText": after}}
    mock_api.load([entry, {"text": "next"}])
    response = send(mock_api, path, body=STREAM)
    received = b""

    def read_until(text: bytes) -> None:
        nonlocal received
        while text not in received:
            piece = response.fp.read1(65536)
            assert piece, f"the stream ended before {text!r}"
            received += piece

    read_until(b"ne BAD")
    assert b" part." not in received
    assert send(mock_api).read() == b"next"
    read_until(b" part.")
    mock_api.load([{"reply": {"text": "Hello."}, "stream": {"afterText": after}}])
    message = "mock server: stream.afterText: 'BAD' is not in the answer text"
    assert script_error(send(mock_api, path, body=STREAM)) == ("mock_script_error", message)


def test_003_SC_002_after_text_with_no_chunk_after_its_text_is_a_script_error(
    mock_api: MockApi,
) -> None:
    stream = {"ending": "text-only", "afterText": {"text": "BAD", "requests": 2}}
    mock_api.load([{"reply": {"text": "Hi BAD"}, "stream": stream}])
    message = "mock server: stream.afterText: no chunk follows the one that completes 'BAD'"
    assert script_error(send(mock_api, body=STREAM)) == ("mock_script_error", message)


def test_003_SC_002_waits_past_the_cap_answer_500_or_drop_and_fail_the_log(
    mock_api: MockApi, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(server_module, "AFTER_REQUESTS_TIMEOUT_S", 0.2)
    mock_api.load([{"afterRequests": 2, "text": "late"}])
    message = "the response waited 0.2 s for 2 requests; 1 arrived"
    assert script_error(send(mock_api)) == ("mock_script_error", f"mock server: {message}")
    with pytest.raises(AssertionError, match=f"request 1: {message}"):
        mock_api.log()
    mock_api.load([{"reply": {"text": "Hello."}, "stream": {"chunkAfterRequests": [0, 2]}}])
    assert read_all(send(mock_api, body=STREAM)).startswith(b"dropped:")
    with pytest.raises(AssertionError, match="request 1: chunk 1 waited 0.2 s for 2 requests"):
        mock_api.log()


def script_error(response: http.client.HTTPResponse) -> tuple[str, str]:
    assert response.status == 500
    error = json.loads(response.read())["error"]
    return error["type"], error["message"]


def test_003_SC_002_a_request_no_entry_matches_gets_500(mock_api: MockApi) -> None:
    mock_api.load([{"match": {"model": "model-a"}, "text": "{}"}])
    assert script_error(send(mock_api)) == NO_ENTRY
    assert script_error(send(mock_api, MESSAGES)) == NO_ENTRY
    assert [record["scripted"] for record in mock_api.log()] == [False, False]


def test_003_SC_002_an_exhausted_or_empty_script_gets_500(mock_api: MockApi) -> None:
    mock_api.load([{"text": "first"}])
    assert send(mock_api).read() == b"first"
    assert script_error(send(mock_api)) == NO_ENTRY
    assert [record["scripted"] for record in mock_api.log()] == [True, False]
    mock_api.load([])
    assert script_error(send(mock_api)) == NO_ENTRY


# The example mode's fixed replies, per model and script of the last user message (T037).
EXAMPLE_QUESTIONS = [
    ("model-a", "오늘 비 와", "응, 그랬구나. 더 얘기해 줘."),
    ("model-a", "It's raining again.", "Oh, I see. Tell me more."),
    ("model-b", "また雨が降ってる。", "へえ、本当？何があったの？"),
    ("model-b", "I had ramen for lunch.", "Really? What happened?"),
]


def example_replies(mock: MockApi) -> list[tuple[int, str, bool]]:
    """Status, reply text and whether usage came, for each of EXAMPLE_QUESTIONS."""
    answers = []
    for model, question, _ in EXAMPLE_QUESTIONS:
        messages = [
            {"role": "system", "content": "Be brief."},
            {"role": "user", "content": question},
        ]
        response = send(mock, body={"model": model, "messages": messages})
        body = json.loads(response.read())
        text = body["choices"][0]["message"]["content"] if response.status == 200 else ""
        usage = body.get("usage", {})
        answers.append((response.status, text, usage.get("completion_tokens", 0) > 0))
    return answers


def test_003_SC_004_with_no_script_chat_completions_get_the_example_reply() -> None:
    expected = [(200, reply, True) for _, _, reply in EXAMPLE_QUESTIONS]
    server = MockServer().start()
    try:
        mock = MockApi(server.url)
        assert example_replies(mock) == expected
        assert script_error(send(mock, MESSAGES)) == (
            "mock_script_error",
            "mock server: no script loaded",
        )
        mock.load([{"text": "scripted"}])
        assert send(mock).read() == b"scripted"
        mock.reset()
        assert example_replies(mock) == expected
        assert [record["scripted"] for record in mock.log()] == [False] * len(expected)
    finally:
        server.stop()


def test_003_SC_002_loading_a_script_clears_the_log_and_control_requests_are_not_logged(
    mock_api: MockApi,
) -> None:
    mock_api.load([{"times": 2, "text": "{}"}])
    send(mock_api, body={"model": "model-b", "stream": False}).read()
    send(mock_api, "/v1/responses/resp_1", method="GET").read()
    log = mock_api.log()
    assert [(r["method"], r["path"], r["api"], r["model"]) for r in log] == [
        ("POST", CHAT, "chat-completions", "model-b"),
        ("GET", "/v1/responses/resp_1", None, None),
    ]
    assert log[0]["body"] == {"model": "model-b", "stream": False}
    assert log[0]["headers"]["accept-encoding"] == "identity"
    mock_api.load([])
    assert mock_api.log() == []


def test_003_SC_002_retry_after_headers_pass_through_unchanged(mock_api: MockApi) -> None:
    headers = {"retry-after": "Sun, 06 Nov 1994 08:49:37 GMT", "retry-after-ms": "30s"}
    mock_api.load([{"error": {"status": 429}, "headers": headers}])
    head, _ = head_and_body(raw_post(mock_api))
    lines = head.decode().split("\r\n")
    assert lines[0].startswith("HTTP/1.1 429")
    assert "retry-after: Sun, 06 Nov 1994 08:49:37 GMT" in lines
    assert "retry-after-ms: 30s" in lines


def test_003_SC_002_log_prints_each_request_with_its_served_encoding() -> None:
    server = subprocess.Popen(
        [sys.executable, str(SERVER), "--port", "0", "--log"], stdout=subprocess.PIPE, text=True
    )
    try:
        assert server.stdout is not None
        mock = MockApi(server.stdout.readline().split()[-1])
        mock.load([{"text": "{}", "encoding": "gzip"}])
        send(mock, accept_encoding="gzip").read()
        printed = json.loads(server.stdout.readline())
        assert (printed["path"], printed["servedEncoding"]) == (CHAT, "gzip")
    finally:
        server.terminate()
        server.wait(timeout=10)


# --- TLS ------------------------------------------------------------------------------------

VERIFY_RESULTS = {
    "valid": None,
    "self-signed": "self-signed certificate",
    "other-host": "Hostname mismatch",
    "expired": "certificate has expired",
    "missing-intermediate": "unable to get local issuer certificate",
}


@pytest.mark.parametrize("certificate", sorted(CERTIFICATES))
def test_003_SC_002_each_certificate_gives_its_verification_result(
    mock_api: MockApi, certificate: str
) -> None:
    port = mock_api.control("tls", {"certificate": certificate})["port"]
    mock_api.load([{"text": "over TLS"}])
    context = ssl.create_default_context(cafile=str(ROOT_CA))
    connection = http.client.HTTPSConnection("localhost", port, timeout=10, context=context)
    expected = VERIFY_RESULTS[certificate]
    if expected is None:
        connection.request("POST", CHAT, body=b'{"model": "m"}')
        assert connection.getresponse().read() == b"over TLS"
    else:
        with pytest.raises(ssl.SSLCertVerificationError) as refused:
            connection.request("POST", CHAT, body=b'{"model": "m"}')
        assert expected in str(refused.value.verify_message)
