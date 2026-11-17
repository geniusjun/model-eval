"""The scenario service with the installed SDKs imported at module level right after the helper,
as most services do (S-UNC-01), instead of inside the service function."""

from __future__ import annotations

import importlib
import importlib.util
import runpy
from pathlib import Path

import model_eval_adapter  # noqa: F401  (the helper before any SDK)

for name in ("openai", "anthropic"):
    if importlib.util.find_spec(name) is not None:
        importlib.import_module(name)

runpy.run_path(str(Path(__file__).with_name("scenario.py")), run_name="__main__")
