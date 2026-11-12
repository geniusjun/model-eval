"""A stand-in adapter for the harness's own tests of `trials` and `trialsInARow`, standard
library only. `final` is the request's caseId, and `service.params.raw` maps a caseId to a raw
of its own; otherwise `raw` tells how the requests arrived:

- with `params.trials` N, every `generate` is held until N of them have arrived, and `raw` is
  "together", or "alone" for one still held after `WAIT_S`, so a harness that waits for one
  response before sending the next request gets "alone";
- without it, each `generate` is answered after `params.delayMs` with `raw`
  "answered-before-<k>", k being the number of responses sent before it arrived, so requests
  sent one after another get 0, 1, 2 and requests sent at once all get 0.

With `params.requestAfterMs`, the stand-in also POSTs to `/v1/background` of the mock server
(`MODEL_EVAL_MOCK_URL`) that long after answering, as background work of a service does, and
`shutdown` exits at once, so the request is lost unless the harness waits for it first.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import urllib.request
from typing import Any

WAIT_S = 3.0
PARAMS: dict[str, Any] = json.loads(os.environ["MODEL_EVAL_SCENARIO"])["service"]["params"]
INITIALIZED = {
    "protocolVersion": "1",
    "adapter": {"name": "harness-trials", "version": "0.0.1"},
    "targets": [{"name": "chat", "inputSchema": True}],
}

lock = threading.Lock()
arrived = 0
answered = 0
everyone_arrived = threading.Event()


def send(request_id: int, result: Any) -> None:
    with lock:
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result}) + "\n")
        sys.stdout.flush()


def answer(request: dict[str, Any], answered_before: int) -> None:
    global answered
    if "trials" in PARAMS:
        raw = "together" if everyone_arrived.wait(WAIT_S) else "alone"
    else:
        threading.Event().wait(int(PARAMS.get("delayMs", 0)) / 1000)
        raw = f"answered-before-{answered_before}"
    case_id = request["params"]["caseId"]
    result = {
        "raw": PARAMS.get("raw", {}).get(case_id, raw),
        "finalKind": "model",
        "final": case_id,
        "latencyMs": 1,
        "finishReason": "stop",
    }
    with lock:
        answered += 1
    send(request["id"], result)
    if "requestAfterMs" in PARAMS:
        threading.Event().wait(int(PARAMS["requestAfterMs"]) / 1000)
        background = urllib.request.Request(
            os.environ["MODEL_EVAL_MOCK_URL"] + "/v1/background", data=b"{}", method="POST"
        )
        urllib.request.urlopen(background, timeout=10).close()


for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    if method == "initialize":
        send(message["id"], INITIALIZED)
    elif method == "generate":
        arrived += 1
        if arrived == int(PARAMS.get("trials", 0)):
            everyone_arrived.set()
        with lock:
            answered_before = answered
        threading.Thread(target=answer, args=(message, answered_before), daemon=True).start()
    elif method == "shutdown":
        send(message["id"], None)
        break
