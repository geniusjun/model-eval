"""The scenario service of a service that calls `httpx2.alias_httpx()` before any SDK is imported,
so `httpx` names the `httpx2` classes (S-UNC-03)."""

from __future__ import annotations

import runpy
from pathlib import Path

import model_eval_adapter  # noqa: F401  (the helper before httpx2 and any SDK)

import httpx2  # isort: skip

httpx2.alias_httpx()

runpy.run_path(str(Path(__file__).with_name("scenario.py")), run_name="__main__")
