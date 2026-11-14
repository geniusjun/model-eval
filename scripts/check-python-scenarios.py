"""Fails when a scenario of test/fixtures/helper/scenarios/ that has a Python case ran in no
Python CI entry.

pytest marks an empty parameter set as skipped (`empty_parameter_set_mark = "skip"` in
adapters/python/pyproject.toml), so a selection that leaves a scenario out of every environment
would pass each entry on its own. This reads the JUnit XML report of every entry and lists the
scenario IDs no test ran.

Usage: python3 scripts/check-python-scenarios.py <folder of JUnit XML reports>
"""

from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

SCENARIOS = Path(__file__).resolve().parent.parent / "test" / "fixtures" / "helper" / "scenarios"
# A scenario case's test ID starts with its scenario ID: case_id of
# adapters/python/tests/conftest.py.
CASE_ID = re.compile(r"\[(\S+) ")


def python_scenarios() -> set[str]:
    """The scenario IDs with at least one case the Python helper runs."""
    scenarios = set()
    for path in sorted(SCENARIOS.glob("*.json")):
        for scenario, cases in json.loads(path.read_text(encoding="utf-8")).items():
            if any("python" in case.get("languages", ["python"]) for case in cases):
                scenarios.add(scenario)
    return scenarios


def ran(testcase: ET.Element) -> bool:
    """Whether pytest ran the test; an expected failure ran, though JUnit reports it as skipped."""
    skipped = testcase.find("skipped")
    return skipped is None or skipped.get("type") == "pytest.xfail"


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    reports = sorted(Path(argv[1]).rglob("*.xml"))
    if not reports:
        print(f"::error::no JUnit XML report under {argv[1]}")
        return 1
    run = set()
    for report in reports:
        for testcase in ET.parse(report).iter("testcase"):
            match = CASE_ID.search(testcase.get("name", ""))
            if match is not None and ran(testcase):
                run.add(match.group(1))
    expected = python_scenarios()
    missing = sorted(expected - run)
    for scenario in missing:
        print(f"::error::{scenario} has a Python case but ran in no Python CI entry")
    ran_count = len(expected) - len(missing)
    print(f"{ran_count} of {len(expected)} scenarios ran in {len(reports)} reports")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
