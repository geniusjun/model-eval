"""An adapter with no service and no SDK, for running the helper alone: under `python3 -I -S`
the helper folder is not on `sys.path`, so the first argument names it."""

from __future__ import annotations

import sys

sys.path.insert(0, sys.argv[1])

from model_eval_adapter import Adapter  # noqa: E402

adapter = Adapter(name="bare-service", version="0.0.1")


@adapter.target("chat", languages=["en"])
def chat(case: object, variant: object) -> str:
    return "unused"


if __name__ == "__main__":
    adapter.run()
