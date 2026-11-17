"""Transport failures and time limits: helper-scenarios §Connections and Time rows S-CONN-01 to
S-CONN-19, S-CONN-21 and S-CONN-23 (Python parts), per helper-api §Reading Response Bodies,
§End Events, §Error Classification and §Transport Exceptions, on the httpx and httpx2 default
transports and the aiohttp backend."""

from __future__ import annotations

import socket
import threading
from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from protocol_client import MockApi, ScenarioCase, assert_expect, run_case
from service_runs import case_of, generate, initialize, started

SCENARIOS = "connections.json"


def test_003_FR_007_FR_017_transport_failures_decide_the_error_kind_and_call_outcome(
    scenario_case: ScenarioCase, mock_api: MockApi
) -> None:
    assert_expect(scenario_case.expect, run_case(scenario_case, mock_api))


@contextmanager
def server_that_never_reads() -> Iterator[str]:
    """A loopback listener that accepts connections and never reads from them, so a large
    request body stops being sent once the socket buffers are full."""
    listener = socket.create_server(("127.0.0.1", 0))
    accepted: list[socket.socket] = []
    stop = threading.Event()

    def accept() -> None:
        listener.settimeout(0.1)
        while not stop.is_set():
            try:
                accepted.append(listener.accept()[0])
            except TimeoutError:
                continue

    worker = threading.Thread(target=accept, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{listener.getsockname()[1]}/v1"
    finally:
        stop.set()
        worker.join()
        for connection in accepted:
            connection.close()
        listener.close()


@pytest.mark.parametrize("backend", ["sync", "async"])
def test_003_FR_017_S_CONN_27_a_write_time_out_is_never_arrived(
    mock_api: MockApi, backend: str
) -> None:
    # httpcore WriteTimeout while the request body is sent: the request never fully arrived.
    with server_that_never_reads() as url:
        spec = {
            "baseUrl": url,
            "userBytes": 16_000_000,
            "timeoutMs": 500,
            "connectTimeoutMs": 30_000,
        }
        case = case_of(
            {"service": {"behaviour": "flow", "params": {"steps": [{"call": spec}]}}, "script": []},
            backend=backend,
        )
        with started(case, mock_api) as adapter:
            initialize(adapter, case)
            result = adapter.wait(generate(adapter, case))["result"]
    assert result["error"]["kind"] == "transient"
    assert [(call["outcome"], call["errorKind"]) for call in result["calls"]] == [
        ("failed", "transient")
    ]
