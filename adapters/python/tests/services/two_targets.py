"""An adapter with two targets: `drafted` renders and has no post-processing, `plain` has
neither (helper-api §Target Options, `render` and `postprocess`)."""

from __future__ import annotations

from typing import Any

from model_eval_adapter import Adapter

adapter = Adapter(name="two-targets", version="0.0.1")


@adapter.target("drafted", render=True, postprocess=False)
async def drafted(case: Any, variant: Any) -> str:
    return "unused"


@adapter.target("plain")
async def plain(case: Any, variant: Any) -> str:
    return "unused"


if __name__ == "__main__":
    adapter.run()
