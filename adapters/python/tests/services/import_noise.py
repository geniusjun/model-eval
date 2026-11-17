"""A service module that writes to stdout while it is imported."""

from __future__ import annotations

import os

print("printed while the service module is imported", flush=True)
os.write(1, b"written to descriptor 1 while the service module is imported\n")
