"""Test client for Python adapters: spawns one, speaks protocol v1 over its stdio, and checks
results against the `expect` of a scenario case (test/fixtures/helper/scenario.schema.json).

Any stdout line that is not a JSON-RPC message fails the test, since a helper must keep stdout
for the protocol alone.
"""

from __future__ import annotations

import ipaddress
import json
import math
import os
import queue
import re
import subprocess
import sys
import threading
import time
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

JsonObject = dict[str, Any]

PYTHON_DIR = Path(__file__).resolve().parents[1]
SERVICES_DIR = PYTHON_DIR / "tests" / "services"
REPO_DIR = PYTHON_DIR.parents[1]
HELPER_FIXTURES = REPO_DIR / "test" / "fixtures" / "helper"
ROOT_CA = HELPER_FIXTURES / "tls" / "root-ca.pem"

OPENAI_API_KEY = "test-openai-key"
ANTHROPIC_API_KEY = "test-anthropic-key"
BASE_URL_VARIABLES = ("OPENAI_BASE_URL", "ANTHROPIC_BASE_URL")

DEFAULT_TIMEOUT_S = 30.0
DEFAULT_VARIANT = {"id": "next", "model": "model-b"}


class ProtocolViolation(AssertionError):
    """The adapter wrote something on stdout that is not a protocol message."""


# --- Mock API server ------------------------------------------------------------------------


class MockApi:
    """The control path of a running mock API server (adapters/python/mock_api/server.py)."""

    def __init__(self, url: str) -> None:
        self.url = url

    def control(self, action: str, body: Any = None) -> Any:
        data = json.dumps(body if body is not None else {}).encode("utf-8")
        request = urllib.request.Request(f"{self.url}/__mock__/{action}", data=data, method="POST")
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read())

    def load(self, script: list[JsonObject]) -> None:
        self.control("script", {"requests": script})

    def reset(self) -> None:
        self.control("reset")

    def log(self) -> list[JsonObject]:
        with urllib.request.urlopen(f"{self.url}/__mock__/log", timeout=10) as response:
            requests: list[JsonObject] = json.loads(response.read())["requests"]
            return requests

    def tls_url(self, certificate: str) -> str:
        port = self.control("tls", {"certificate": certificate})["port"]
        return f"https://localhost:{port}"


def require_loopback(env: dict[str, str]) -> None:
    """Refuses to start an adapter whose model API base URL leaves the machine."""
    for name in BASE_URL_VARIABLES:
        host = urlsplit(env.get(name, "")).hostname or ""
        if not is_loopback(host):
            raise AssertionError(f"{name} must be a loopback address, not {env.get(name)!r}")


def is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


# Inherited settings that could send a request past the mock server or with real credentials.
REMOVED_VARIABLES = frozenset(
    {
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "ANTHROPIC_AUTH_TOKEN",
        "OPENAI_ORG_ID",
        "OPENAI_PROJECT_ID",
    }
)


def api_env(base_url: str, parent: Mapping[str, str] | None = None) -> dict[str, str]:
    """The environment of an adapter process: the parent's (this process's by default) without
    proxies and real credentials, with the mock server's base URLs and dummy keys."""
    inherited = os.environ if parent is None else parent
    env = {
        name: value for name, value in inherited.items() if name.upper() not in REMOVED_VARIABLES
    }
    env.update(
        {
            "OPENAI_BASE_URL": f"{base_url}/v1",
            "ANTHROPIC_BASE_URL": base_url,
            "OPENAI_API_KEY": OPENAI_API_KEY,
            "ANTHROPIC_API_KEY": ANTHROPIC_API_KEY,
            "NO_PROXY": "*",
            "no_proxy": "*",
        }
    )
    return env


# --- Adapter process ------------------------------------------------------------------------


@dataclass
class Exchange:
    """What one adapter process sent besides its responses."""

    calls: list[JsonObject] = field(default_factory=list)
    logs: list[JsonObject] = field(default_factory=list)
    stderr: list[str] = field(default_factory=list)
    violations: list[str] = field(default_factory=list)


class AdapterProcess:
    """One adapter of tests/services/, spoken to over stdin and stdout."""

    def __init__(self, service: str | Path, env: dict[str, str], cwd: Path = SERVICES_DIR) -> None:
        """`service` is a module name of tests/services/ or the path of an adapter file; `env` is
        its whole environment, normally built with `api_env`."""
        full_env = dict(env)
        require_loopback(full_env)
        path_entries = [str(PYTHON_DIR), str(SERVICES_DIR), full_env.get("PYTHONPATH", "")]
        full_env["PYTHONPATH"] = os.pathsep.join(entry for entry in path_entries if entry)
        self.process = subprocess.Popen(
            [
                sys.executable,
                str(service if isinstance(service, Path) else SERVICES_DIR / f"{service}.py"),
            ],
            cwd=cwd,
            env=full_env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.exchange = Exchange()
        self._responses: dict[int, queue.Queue[JsonObject]] = {}
        self._lock = threading.Lock()
        self._next_id = 0
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    # Reading

    def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        for raw in self.process.stdout:
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            message = parse_message(line)
            if message is None:
                self.exchange.violations.append(line)
            elif "method" in message:
                self._notification(message)
            elif isinstance(message.get("id"), int):
                self._mailbox(message["id"]).put(message)
            else:
                self.exchange.violations.append(line)

    def _read_stderr(self) -> None:
        assert self.process.stderr is not None
        for raw in self.process.stderr:
            self.exchange.stderr.append(raw.decode("utf-8", "replace"))

    def _notification(self, message: JsonObject) -> None:
        params = message.get("params") or {}
        if message["method"] == "calls":
            self.exchange.calls.append(params)
        elif message["method"] == "log":
            self.exchange.logs.append(params)
        else:
            self.exchange.violations.append(json.dumps(message))

    def _mailbox(self, request_id: int) -> queue.Queue[JsonObject]:
        with self._lock:
            return self._responses.setdefault(request_id, queue.Queue())

    # Writing

    def send(self, method: str, params: Any = None) -> int:
        with self._lock:
            self._next_id += 1
            request_id = self._next_id
        self._write({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        return request_id

    def notify(self, method: str, params: Any) -> None:
        self._write({"jsonrpc": "2.0", "method": method, "params": params})

    def _write(self, message: JsonObject) -> None:
        if message.get("params") is None:
            message.pop("params", None)
        assert self.process.stdin is not None
        self.process.stdin.write((json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8"))
        self.process.stdin.flush()

    def wait(self, request_id: int, timeout: float = DEFAULT_TIMEOUT_S) -> JsonObject:
        try:
            response = self._mailbox(request_id).get(timeout=timeout)
        except queue.Empty:
            stderr = "".join(self.exchange.stderr)
            raise AssertionError(
                f"no response to request {request_id}; stderr:\n{stderr}"
            ) from None
        self.check_stdout()
        return response

    def request(
        self, method: str, params: Any = None, timeout: float = DEFAULT_TIMEOUT_S
    ) -> JsonObject:
        return self.wait(self.send(method, params), timeout)

    def check_stdout(self) -> None:
        if self.exchange.violations:
            raise ProtocolViolation(
                f"stdout lines that are not protocol messages: {self.exchange.violations}"
            )

    def close(self, timeout: float = DEFAULT_TIMEOUT_S) -> None:
        """Waits for the process to exit after `shutdown`, killing it when it does not."""
        if self.process.stdin is not None and not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
            raise AssertionError("the adapter did not exit after shutdown") from None
        self.check_stdout()


def parse_message(line: str) -> JsonObject | None:
    """A JSON-RPC 2.0 object, or None for anything else."""
    try:
        message = json.loads(line)
    except ValueError:
        return None
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        return None
    return message


# --- Choosing scenario cases ----------------------------------------------------------------

REQUIREMENTS_DIR = PYTHON_DIR / "tests" / "requirements"
APIS = ("chat-completions", "responses", "messages")
BACKENDS = ("sync", "async", "aiohttp")
SDK_OF_API = {"chat-completions": "openai", "responses": "openai", "messages": "anthropic"}
PIN = re.compile(r"^(openai|anthropic)(?:\[[^\]]*\])?==(\S+)", re.MULTILINE)


def requirements_sdks(name: str) -> dict[str, str]:
    """The SDKs a file of tests/requirements/ pins, and their versions."""
    path = REQUIREMENTS_DIR / f"{name}.txt"
    if not path.is_file():
        raise ValueError(f"{name} is not a file of {REQUIREMENTS_DIR} without .txt")
    return dict(PIN.findall(path.read_text(encoding="utf-8")))


def environment_requirements(installed: Mapping[str, str], env: Mapping[str, str]) -> str | None:
    """The requirements file this environment was built from: `MODEL_EVAL_REQUIREMENTS`, else
    the one file whose pinned SDKs are exactly the installed ones."""
    named = env.get("MODEL_EVAL_REQUIREMENTS")
    if named:
        requirements_sdks(named)
        return named
    matching = [
        path.stem
        for path in sorted(REQUIREMENTS_DIR.glob("*.txt"))
        if requirements_sdks(path.stem) == dict(installed)
    ]
    return matching[0] if len(matching) == 1 else None


def runs_for(data: JsonObject, api: str, requirements: str | None) -> bool:
    """A case's `sdks` holds requirements files; one counts for an API only when it pins the SDK
    that serves that API, and the case runs when this environment's file is among those."""
    if "sdks" not in data:
        return True
    serving = {name for name in data["sdks"] if SDK_OF_API[api] in requirements_sdks(name)}
    return requirements in serving


def select_cases(
    fixture: Mapping[str, list[JsonObject]],
    installed: Mapping[str, str],
    requirements: str | None,
) -> list[ScenarioCase]:
    """The Python cases of a fixture this environment runs, per API and backend."""
    cases = []
    for scenario, entries in fixture.items():
        for data in entries:
            if "python" not in data.get("languages", ["python"]):
                continue
            for api in data.get("apis", APIS):
                sdk = SDK_OF_API[api]
                if sdk not in installed or not runs_for(data, api, requirements):
                    continue
                label = requirements or f"{sdk}-{installed[sdk]}"
                for backend in data.get("backends", BACKENDS):
                    cases.append(ScenarioCase(scenario, data["name"], data, api, backend, label))
    return cases


# --- Running a scenario case ----------------------------------------------------------------


@dataclass
class ScenarioCase:
    """One case of a scenario fixture, for one API, backend and SDK environment."""

    scenario: str
    name: str
    data: JsonObject
    api: str
    backend: str
    sdk: str

    @property
    def expect(self) -> JsonObject:
        expected: JsonObject = self.data["expect"]
        return expected


@dataclass
class Outcome:
    """Everything a case's `expect` is compared with."""

    response: JsonObject
    exchange: Exchange
    requests: list[JsonObject]
    render_fingerprint: str | None = None


def scenario_env(case: ScenarioCase) -> dict[str, str]:
    """What a scenario service needs to run the case: behaviour, options, API and backend."""
    spec = {
        "scenario": case.scenario,
        "service": case.data["service"],
        "target": case.data.get("target", {}),
        "adapter": case.data.get("adapter", {}),
        "api": case.api,
        "backend": case.backend,
    }
    return {"MODEL_EVAL_SCENARIO": json.dumps(spec)}


def initialize_params(case: ScenarioCase) -> JsonObject:
    initialize = case.data.get("initialize", {})
    return {
        "protocolVersion": "1",
        "client": {"name": "model-eval", "version": "0.0.0-test"},
        "variant": {**DEFAULT_VARIANT, **initialize.get("variant", {})},
        "timeoutMs": initialize.get("timeoutMs", 30_000),
        "toolPaths": initialize.get("toolPaths", []),
    }


def trial_params(case: ScenarioCase) -> JsonObject:
    defaults: JsonObject = {
        "target": "chat",
        "input": {},
        "caseId": "case-1",
        "repeat": 0,
        "seed": 1,
    }
    return {**defaults, **case.data.get("params", {})}


def run_case(case: ScenarioCase, mock: MockApi, service: str = "scenario") -> Outcome:
    """Loads the case's script, runs its request in a new adapter, and shuts the adapter down."""
    mock.load(case.data.get("script", []))
    base_url = mock.tls_url(case.data["tls"]) if "tls" in case.data else mock.url
    env = {**api_env(base_url), **scenario_env(case)}
    if "tls" in case.data:
        env["SSL_CERT_FILE"] = str(ROOT_CA)
    adapter = AdapterProcess(service, env)
    try:
        initialized = adapter.request("initialize", initialize_params(case))
        assert "result" in initialized, f"initialize failed: {initialized}"
        render_fingerprint = None
        if case.expect.get("fingerprint") in ("render", "not-render"):
            rendered = adapter.request("render", trial_params(case))
            render_fingerprint = rendered.get("result", {}).get("fingerprint")
        request = case.data.get("request", "generate")
        request_id = adapter.send(request, trial_params(case))
        if "cancel" in case.data:
            wait_to_cancel(case.data["cancel"], mock)
            adapter.notify("cancel", {"id": request_id})
        response = adapter.wait(request_id)
        adapter.request("shutdown")
    finally:
        adapter.close()
    return Outcome(response, adapter.exchange, mock.log(), render_fingerprint)


def wait_to_cancel(cancel: JsonObject, mock: MockApi, timeout: float = DEFAULT_TIMEOUT_S) -> None:
    if "afterMs" in cancel:
        time.sleep(cancel["afterMs"] / 1000)
        return
    deadline = time.monotonic() + timeout
    while len(mock.log()) < cancel["afterRequests"]:
        if time.monotonic() > deadline:
            raise AssertionError(
                f"the mock server never received {cancel['afterRequests']} requests"
            )
        time.sleep(0.01)


# --- Comparing with `expect` ----------------------------------------------------------------


def load_messages() -> dict[str, JsonObject]:
    with open(HELPER_FIXTURES / "messages.json", encoding="utf-8") as file:
        messages: dict[str, JsonObject] = json.load(file)["messages"]
        return messages


def fill_message(text: str, placeholders: dict[str, str]) -> str:
    """A message with its placeholders filled per helper-api §Messages: no period is added after
    a value that already ends with '.', '!' or '?'."""
    for name, value in placeholders.items():
        marker = f"<{name}>"
        if value.endswith((".", "!", "?")):
            text = text.replace(f"{marker}.", value)
        text = text.replace(marker, value)
    return text


def same(expected: Any, actual: Any) -> bool:
    """Equal as canonical JSON (001 data-model §Canonical JSON), as the TypeScript harness
    compares: numbers as IEEE 754 doubles, so `1.0` equals `1` and an integer above 2^53 equals
    the double it rounds to; `true` never equals `1`; keys in any order."""
    return comparable(expected) == comparable(actual)


def comparable(value: Any) -> str:
    """A text that is equal for two values exactly when their canonical JSON is. Written here,
    not taken from the helper, so the helper under test does not judge itself."""
    if value is None or isinstance(value, bool):
        return json.dumps(value)
    if isinstance(value, (int, float)):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError(f"{value} has no canonical JSON form")
        return repr(number + 0.0)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(comparable(item) for item in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value, key=lambda key: key.encode("utf-16-be", "surrogatepass"))
        return "{" + ",".join(f"{json.dumps(k)}:{comparable(value[k])}" for k in keys) + "}"
    raise TypeError(f"{type(value).__name__} is not a JSON value")


ABSENT = object()


def compare(path: str, expected: Any, actual: Any, mismatches: list[str]) -> None:
    """Expected null means the field is absent."""
    if expected is None:
        if actual is not ABSENT:
            mismatches.append(f"{path}: expected absent, got {json.dumps(actual)}")
    elif actual is ABSENT or not same(expected, actual):
        shown = "absent" if actual is ABSENT else json.dumps(actual, ensure_ascii=False)
        mismatches.append(
            f"{path}: expected {json.dumps(expected, ensure_ascii=False)}, got {shown}"
        )


def compare_records(
    path: str, expected: list[JsonObject], actual: Any, mismatches: list[str]
) -> None:
    """Records in order; only the fields each expected record lists are compared."""
    records = actual if isinstance(actual, list) else []
    if len(records) != len(expected):
        mismatches.append(f"{path}: expected {len(expected)} records, got {json.dumps(records)}")
        return
    for index, (wanted, record) in enumerate(zip(expected, records, strict=True)):
        for name, value in wanted.items():
            compare(f"{path}[{index}].{name}", value, record.get(name, ABSENT), mismatches)


def compare_messages(
    path: str, expected: list[JsonObject], actual: list[str], mismatches: list[str]
) -> None:
    messages = load_messages()
    sentences = [
        fill_message(messages[ref["message"]]["text"], ref.get("placeholders", {}))
        for ref in expected
    ]
    if sentences != actual:
        mismatches.append(f"{path}: expected {sentences}, got {actual}")


def status_of(response: JsonObject) -> str:
    if "error" in response:
        return "adapter-error"
    return "failed" if "error" in response.get("result", {}) else "ok"


def result_field(response: JsonObject, name: str) -> Any:
    """A field of the result, or of the JSON-RPC error's data for an adapter error."""
    if "error" in response:
        data = response["error"].get("data") or {}
        return data.get(name, ABSENT)
    result = response.get("result", {})
    if name == "answers" and "finalKind" in result:
        return result.get("answers", 1)
    return result.get(name, ABSENT)


def check_expect(expect: JsonObject, outcome: Outcome) -> list[str]:
    """Mismatches between `expect` and what the adapter and the mock server did."""
    mismatches: list[str] = []
    response = outcome.response
    result = response.get("result", {})
    model_error = result.get("error", {}) if isinstance(result, dict) else {}
    for name, value in expect.items():
        if name == "status":
            compare(name, value, status_of(response), mismatches)
        elif name == "errorKind":
            compare(name, value, model_error.get("kind", ABSENT), mismatches)
        elif name == "retryAfterMs":
            compare(name, value, model_error.get("retryAfterMs", ABSENT), mismatches)
        elif name == "fingerprint":
            check_fingerprint(value, result.get("fingerprint", ABSENT), outcome, mismatches)
        elif name == "adapterError":
            actual = [response["error"]["message"]] if "error" in response else []
            compare_messages(name, [value], actual, mismatches)
        elif name == "warnings":
            compare_messages(name, value, result.get("warnings", []), mismatches)
        elif name == "calls":
            check_calls(value, result_field(response, "calls"), mismatches)
        elif name == "render":
            for key, wanted in value.items():
                compare(f"render.{key}", wanted, result.get(key, ABSENT), mismatches)
        elif name == "notifications":
            check_notifications(value, outcome.exchange.calls, mismatches)
        elif name == "log":
            warnings = [
                log["message"] for log in outcome.exchange.logs if log.get("level") == "warn"
            ]
            compare_messages(name, value, warnings, mismatches)
        elif name == "stderrIncludes":
            stderr = "".join(outcome.exchange.stderr)
            mismatches.extend(f"stderr lacks {text!r}" for text in value if text not in stderr)
        elif name == "requests":
            compare_records(name, value, outcome.requests, mismatches)
        else:
            compare(name, value, result_field(response, name), mismatches)
    return mismatches


def check_calls(expected: list[JsonObject] | None, actual: Any, mismatches: list[str]) -> None:
    if expected is None:
        compare("calls", None, actual, mismatches)
    else:
        compare_records("calls", expected, [] if actual is ABSENT else actual, mismatches)


def check_notifications(
    expected: list[JsonObject], sent: list[JsonObject], mismatches: list[str]
) -> None:
    if len(sent) != len(expected):
        mismatches.append(f"notifications: expected {len(expected)}, got {json.dumps(sent)}")
        return
    for index, (wanted, notification) in enumerate(zip(expected, sent, strict=True)):
        path = f"notifications[{index}].calls"
        compare_records(path, wanted["calls"], notification.get("calls"), mismatches)


def check_fingerprint(
    expected: str | None, actual: Any, outcome: Outcome, mismatches: list[str]
) -> None:
    if expected in ("render", "not-render") and outcome.render_fingerprint is None:
        mismatches.append("fingerprint: the render gave no fingerprint to compare with")
    elif expected == "render":
        compare("fingerprint", outcome.render_fingerprint, actual, mismatches)
    elif expected == "not-render":
        if actual is ABSENT or actual == outcome.render_fingerprint:
            mismatches.append(
                f"fingerprint: expected a value other than {outcome.render_fingerprint}"
            )
    else:
        compare("fingerprint", expected, actual, mismatches)


def assert_expect(expect: JsonObject, outcome: Outcome) -> None:
    mismatches = check_expect(expect, outcome)
    assert not mismatches, "\n".join(mismatches)
