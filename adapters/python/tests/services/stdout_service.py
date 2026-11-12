"""The scenario service, with a service module imported after the helper that writes to stdout
while it is imported (helper-api §stdout Protection). Import order is the point of this file."""

# isort: skip_file
from __future__ import annotations

import model_eval_adapter  # noqa: F401
import import_noise  # noqa: F401
import scenario

if __name__ == "__main__":
    scenario.adapter.run()
