"""The Python helper's text, JSON, hashing, discard reason and retry-after values equal the shared
vectors of test/fixtures/helper/parity/values.json, which the tool's own code also passes
(helper-scenarios S-PAR-01 to S-PAR-06, S-PAR-09, S-PAR-10, S-PAR-12)."""

from __future__ import annotations

import json
from typing import Any

import pytest
from protocol_client import HELPER_FIXTURES

import model_eval_adapter as helper

with open(HELPER_FIXTURES / "parity" / "values.json", encoding="utf-8") as file:
    VALUES: dict[str, Any] = json.load(file)


def named(vectors: list[dict[str, Any]]) -> pytest.MarkDecorator:
    return pytest.mark.parametrize("vector", vectors, ids=[vector["name"] for vector in vectors])


@named(VALUES["whitespace"])
def test_003_FR_024_trims_only_the_25_white_space_code_points(vector: dict[str, Any]) -> None:
    assert helper.trim_text(vector["text"]) == vector["trimmed"]
    assert helper.is_empty_text(vector["text"]) is vector["empty"]


@named(VALUES["canonicalJson"])
def test_003_FR_024_reads_and_writes_canonical_json(vector: dict[str, Any]) -> None:
    assert helper.canonical_json(helper.read_json(vector["text"])) == vector["canonical"]


@named(VALUES["canonicalJson"])
def test_003_FR_024_hashes_canonical_json_as_sha256(vector: dict[str, Any]) -> None:
    assert helper.sha256_of_text(vector["canonical"]) == vector["sha256"]


@named(VALUES["notJson"])
def test_003_FR_024_rejects_text_that_is_not_json(vector: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        helper.read_json(vector["text"])


def test_003_FR_024_writes_python_values_as_their_double() -> None:
    value = {"b": [1.0, -0.0, 1e-07, 2**53 + 1, True, None], "a": "\ud800"}
    assert (
        helper.canonical_json(value) == '{"a":"\\ud800","b":[1,0,1e-7,9007199254740992,true,null]}'
    )


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_003_FR_024_refuses_to_write_numbers_without_a_canonical_form(value: float) -> None:
    with pytest.raises(ValueError):
        helper.canonical_json({"n": value})


@named(VALUES["discardReason"])
def test_003_FR_024_cuts_discard_reasons_to_200_code_points(vector: dict[str, Any]) -> None:
    error_class = type(vector["exceptionName"], (Exception,), {})
    error = error_class(vector["message"])
    assert helper.discard_reason(error) == vector["discardReason"]


@named(VALUES["retryAfter"]["cases"])
def test_003_FR_024_reads_retry_after_headers(vector: dict[str, Any]) -> None:
    now_ms = vector.get("nowMs", VALUES["retryAfter"]["nowMs"])
    assert helper.retry_after_ms(vector["headers"], now_ms) == vector["retryAfterMs"]


def test_003_FR_024_reads_retry_after_headers_in_any_case() -> None:
    headers = {"Retry-After-Ms": "250", "RETRY-AFTER": "5"}
    assert helper.retry_after_ms(headers, VALUES["retryAfter"]["nowMs"]) == 250
