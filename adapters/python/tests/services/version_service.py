"""An adapter that reports the version of the folder `MODEL_EVAL_SERVICE_DIR` names, or no
`service_dir` when the variable is unset (data-model §Service Version)."""

from __future__ import annotations

import os

from model_eval_adapter import Adapter

service_dir = os.environ.get("MODEL_EVAL_SERVICE_DIR")
adapter = (
    Adapter(name="version-service", version="0.0.1", service_dir=service_dir)
    if service_dir is not None
    else Adapter(name="version-service", version="0.0.1")
)


@adapter.target("chat", languages=["en"])
def chat(case: object, variant: object) -> str:
    return "unused"


if __name__ == "__main__":
    adapter.run()
