"""Cost of trials the target function reports: helper-scenarios §Cost rows S-COST-01 to S-COST-08,
per data-model §Derived Result Fields `usage` and `calls` and §Raw Call: `Result(usage=)` on the
raw call or the uncaptured call, no `calls` without a captured call, stream calls at their
reservation, and warning W4."""

from __future__ import annotations

from protocol_client import MockApi, ScenarioCase, assert_expect, run_case

SCENARIOS = "cost.json"


def test_003_FR_007_FR_015_FR_018_cost_follows_the_reported_usage(
    scenario_case: ScenarioCase, mock_api: MockApi
) -> None:
    assert_expect(scenario_case.expect, run_case(scenario_case, mock_api))
