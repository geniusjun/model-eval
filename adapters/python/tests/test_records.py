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
