"""Side calls reported by the target function: helper-scenarios §Side Calls rows S-SIDE-05 to
S-SIDE-36, reported and unreported, and the parts of S-SIDE-04, S-SIDE-09 and S-SIDE-37 where the
target function returns `Result` or throws `ModelCallError`, per helper-api §Trials Stopped by
Another Call's Failure and §Trials Stopped by a Parallel Check's Refusal: the `answers=0` check
(A8), cut stream view 5, matching thrown failures, and User Story 4 acceptance scenarios 9 and
10. The `asyncio.TaskGroup` and `except*` services of S-SIDE-06 and S-SIDE-07 need Python 3.11."""

from __future__ import annotations

import sys

import pytest
from conftest import case_id, scenario_cases
from protocol_client import MockApi, ScenarioCase, assert_expect, run_case

SCENARIOS = "side_calls.json"
CASES = scenario_cases(SCENARIOS)


def needs_task_group(case: ScenarioCase) -> bool:
    return bool(case.data["service"]["behaviour"] == "task-group")


@pytest.mark.parametrize(
    "case", [case for case in CASES if not needs_task_group(case)], ids=case_id
)
def test_003_FR_014_FR_015_FR_016_FR_018_FR_019_side_calls_count_as_the_target_reports_them(
    case: ScenarioCase, mock_api: MockApi
) -> None:
    assert_expect(case.expect, run_case(case, mock_api))


@pytest.mark.skipif(sys.version_info < (3, 11), reason="asyncio.TaskGroup needs Python 3.11")
@pytest.mark.parametrize("case", [case for case in CASES if needs_task_group(case)], ids=case_id)
def test_003_FR_014_FR_018_FR_019_a_task_group_cut_counts_as_the_thrown_check_failure(
    case: ScenarioCase, mock_api: MockApi
) -> None:
    assert_expect(case.expect, run_case(case, mock_api))
