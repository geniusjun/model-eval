"""Answer calls: data-model §Call Branches, §Answers and §Raw Cannot Be Determined on the rows of
helper-scenarios §Answer Calls the US1 task lists and S-RESP-03, S-RESP-04, S-RESP-06 and
S-RESP-12; the four causes of adapter error A3; warnings W1 (variant and other-model forms), W2
and W3; User Story 1 acceptance scenarios 10 and 11 (S-ANS-01)."""

from __future__ import annotations

from protocol_client import MockApi, ScenarioCase, assert_expect, run_case

import model_eval_adapter as helper

SCENARIOS = "answer_calls.json"


def test_003_FR_009_FR_010_FR_012_FR_014_FR_015_FR_016_FR_020_answer_calls_decide_raw(
    scenario_case: ScenarioCase, mock_api: MockApi
) -> None:
    assert_expect(scenario_case.expect, run_case(scenario_case, mock_api))


def test_003_FR_012_an_empty_anthropic_system_text_block_is_an_empty_line() -> None:
    # helper-api §Render Mode: each text block gives one line, an empty text an empty one, so
    # the system that branches and answers compare keeps it (data-model §System Prompt).
    body = {
        "model": "model-b",
        "system": [
            {"type": "text", "text": "A"},
            {"type": "text", "text": ""},
            {"type": "text", "text": "B"},
        ],
        "messages": [{"role": "user", "content": "Say hello."}],
    }
    assert helper.render_messages("messages", body)[0] == {"role": "system", "content": "A\n\nB"}
