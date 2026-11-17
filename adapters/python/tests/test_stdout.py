"""stdout protection (helper-api §stdout Protection; User Story 1 acceptance scenario 4): output
the service writes goes to stderr and protocol lines stay intact. The test client fails a test on
any stdout line that is not a protocol message (tests/protocol_client.py)."""

from __future__ import annotations

import time

from protocol_client import AdapterProcess, MockApi, ScenarioCase, assert_expect, run_case
from service_runs import case_of, generate, initialize, ok_result, started

SCENARIOS = "stdout.json"


def stderr_of(adapter: AdapterProcess, wanted: list[str], timeout: float = 5.0) -> str:
    """The adapter's stderr once it holds every wanted text, or as it is at the time limit; the
    reading thread may still be behind the process."""
    deadline = time.monotonic() + timeout
    while True:
        stderr = "".join(adapter.exchange.stderr)
        if all(text in stderr for text in wanted) or time.monotonic() > deadline:
            return stderr
        time.sleep(0.05)


def test_003_FR_002_S_RESP_09_service_print(scenario_case: ScenarioCase, mock_api: MockApi) -> None:
    assert_expect(scenario_case.expect, run_case(scenario_case, mock_api))


def steps_case(
    steps: list[dict[str, object]], backend: str = "async", times: int = 1
) -> ScenarioCase:
    return case_of(
        {
            "service": {"behaviour": "steps", "params": {"steps": steps}},
            "script": [{"times": times, "reply": {"text": "Hello."}}],
        },
        backend=backend,
    )


def test_003_FR_002_print_descriptor_1_and_child_processes_go_to_stderr(
    mock_api: MockApi,
) -> None:
    wanted = ["from print", "from descriptor 1", "from a child process"]
    for backend in ("sync", "async"):
        case = steps_case(
            [
                {"print": wanted[0]},
                {"write-fd": wanted[1] + "\n"},
                {"child": wanted[2]},
                {"call": {}},
            ],
            backend,
        )
        with started(case, mock_api) as adapter:
            initialize(adapter, case)
            result = ok_result(adapter.wait(generate(adapter, case)))
            stderr = stderr_of(adapter, wanted)
        assert result["raw"] == "Hello."
        assert [text for text in wanted if text not in stderr] == [], backend


def test_003_FR_002_output_while_the_service_module_is_imported_goes_to_stderr(
    mock_api: MockApi,
) -> None:
    case = steps_case([{"call": {}}])
    wanted = [
        "printed while the service module is imported",
        "written to descriptor 1 while the service module is imported",
    ]
    with started(case, mock_api, service="stdout_service") as adapter:
        initialize(adapter, case)
        result = ok_result(adapter.wait(generate(adapter, case)))
        stderr = stderr_of(adapter, wanted)
    assert result["raw"] == "Hello."
    assert [text for text in wanted if text not in stderr] == []


def test_003_FR_002_protocol_lines_stay_intact_around_long_unterminated_output(
    mock_api: MockApi,
) -> None:
    # The service repeats the text: Linux limits one environment variable to 128 KiB.
    long_output = {"write-fd": "x", "times": 200_000}
    case = steps_case(
        [long_output, {"call": {}}, long_output, {"return": "done"}],
        times=4,
    )
    with started(case, mock_api) as adapter:
        initialize(adapter, case)
        ids = [generate(adapter, case, caseId=f"case-{index}") for index in range(4)]
        results = [ok_result(adapter.wait(request_id)) for request_id in ids]
    assert [result["final"] for result in results] == ["done"] * 4
    assert [result["raw"] for result in results] == ["Hello."] * 4
