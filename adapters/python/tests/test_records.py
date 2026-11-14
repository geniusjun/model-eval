"""Call records (data-model §Captured Call, §Usage Buckets, §Finish Reasons, §Call Outcome,
§Derived Result Fields `calls`): per-call fields in send order, usage buckets, finish reasons,
the outcome of each failure shape and `retryAfterMs`. The rows are in
test/fixtures/helper/scenarios/records.json."""

from __future__ import annotations

from protocol_client import MockApi, ScenarioCase, assert_expect, run_case
from service_runs import case_of, generate, initialize, ok_result, started

SCENARIOS = "records.json"


def test_003_FR_007_FR_020_call_records(scenario_case: ScenarioCase, mock_api: MockApi) -> None:
    assert_expect(scenario_case.expect, run_case(scenario_case, mock_api))


def test_003_FR_007_calls_and_the_trial_record_latency(mock_api: MockApi) -> None:
    steps = [{"call": {"model": "model-a"}}, {"call": {}}]
    case = case_of(
        {
            "service": {"behaviour": "steps", "params": {"steps": steps}},
            "script": [
                {"delayMs": 300, "reply": {"text": "Side."}},
                {"delayMs": 200, "reply": {"text": "Answer."}},
            ],
        }
    )
    with started(case, mock_api) as adapter:
        initialize(adapter, case)
        result = ok_result(adapter.wait(generate(adapter, case)))
    latencies = [call["latencyMs"] for call in result["calls"]]
    assert [call["model"] for call in result["calls"]] == ["model-a", "model-b"]
    assert all(isinstance(latency, (int, float)) for latency in latencies), latencies
    assert latencies[0] >= 300
    assert latencies[1] >= 200
    assert result["latencyMs"] >= 500


def test_003_FR_007_S_RESP_18_latency_runs_from_send_to_the_end_of_each_call(
    mock_api: MockApi,
) -> None:
    # A received call, one dropped mid-body, and one still running when the function returns.
    steps = [
        {"call": {"user": "First."}},
        {"call": {"user": "Second."}, "swallow": True},
        {"background": {"user": "Third."}},
        {"sleep": 200},
        {"return": "Done."},
    ]
    case = case_of(
        {
            "service": {"behaviour": "steps", "params": {"steps": steps}},
            "script": [
                {"match": {"bodyIncludes": "First."}, "delayMs": 300, "reply": {"text": "One."}},
                {
                    "match": {"bodyIncludes": "Second."},
                    "delayMs": 200,
                    "reply": {"text": "A body cut short."},
                    "drop": {"chunks": 0, "bytes": 5},
                },
                {"match": {"bodyIncludes": "Third."}, "delayMs": 1000, "reply": {"text": "Late."}},
            ],
        },
        backend="async",
    )
    with started(case, mock_api) as adapter:
        initialize(adapter, case)
        response = adapter.wait(generate(adapter, case))
    calls = (
        response["result"]["calls"] if "result" in response else response["error"]["data"]["calls"]
    )
    assert [call["outcome"] for call in calls] == ["ok", "unanswered", "ok"]
    assert calls[0]["latencyMs"] >= 300
    assert calls[1]["latencyMs"] >= 200
    assert "latencyMs" not in calls[2]
