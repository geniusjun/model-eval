"""The Python helper is one file that needs only the standard library (helper-api
§Distribution): it imports and answers `initialize` with no site packages, and importing it
loads no module from outside the standard library."""

from __future__ import annotations

import json
import subprocess
import sys
import sysconfig
from pathlib import Path

from protocol_client import PYTHON_DIR, SERVICES_DIR, parse_message

HELPER_FILE = PYTHON_DIR / "model_eval_adapter.py"
INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "1",
        "client": {"name": "model-eval", "version": "0.0.0-test"},
        "variant": {"id": "next", "model": "model-b"},
        "timeoutMs": 30_000,
        "toolPaths": [],
    },
}
SHUTDOWN = {"jsonrpc": "2.0", "id": 2, "method": "shutdown"}


def isolated(arguments: list[str], stdin: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    """Runs this interpreter with `-I -S`: no site packages, no PYTHON* variables, no script or
    working folder on `sys.path`."""
    return subprocess.run(
        [sys.executable, "-I", "-S", *arguments],
        input=stdin,
        capture_output=True,
        text=True,
        cwd=cwd,
        timeout=30,
        check=False,
    )


def test_003_FR_025_answers_initialize_without_site_packages(tmp_path: Path) -> None:
    stdin = "".join(json.dumps(message) + "\n" for message in (INITIALIZE, SHUTDOWN))
    done = isolated([str(SERVICES_DIR / "bare_service.py"), str(PYTHON_DIR)], stdin, tmp_path)
    assert done.returncode == 0, done.stderr
    messages = [parse_message(line) for line in done.stdout.splitlines()]
    assert None not in messages, done.stdout
    responses = {message["id"]: message for message in messages if message and "id" in message}
    result = responses[1]["result"]
    assert result["adapter"]["helper"]["language"] == "python"
    assert result["protocolVersion"] == "1"
    assert responses[2]["result"] is None


def test_003_FR_025_import_loads_only_standard_library_modules(tmp_path: Path) -> None:
    report = tmp_path / "modules.json"
    # The helper sends descriptor 1 to stderr on import, so the list goes to a file.
    code = (
        "import json, sys\n"
        f"sys.path.insert(0, {str(PYTHON_DIR)!r})\n"
        "import model_eval_adapter\n"
        "loaded = {name: getattr(getattr(module, '__spec__', None), 'origin', None)"
        " for name, module in sys.modules.items()}\n"
        f"open({str(report)!r}, 'w').write(json.dumps(loaded))\n"
    )
    done = isolated(["-c", code], "", tmp_path)
    assert done.returncode == 0, done.stderr
    loaded: dict[str, str | None] = json.loads(report.read_text())
    assert "model_eval_adapter" in loaded
    outside = sorted(
        name
        for name, origin in loaded.items()
        if name not in ("model_eval_adapter", "__main__") and not in_standard_library(name, origin)
    )
    assert outside == []


def in_standard_library(name: str, origin: str | None) -> bool:
    """Named in `sys.stdlib_module_names`, or loaded from the standard library's folders outside
    site-packages: the names leave out modules the build generates, such as
    `_missing_stdlib_info` of Python 3.15."""
    if name.split(".")[0] in sys.stdlib_module_names:
        return True
    if origin is None:
        return False
    path = Path(origin).resolve()
    folders = {Path(sysconfig.get_path(key)).resolve() for key in ("stdlib", "platstdlib")}
    return "site-packages" not in path.parts and any(path.is_relative_to(f) for f in folders)


def test_003_FR_025_the_helper_is_one_file() -> None:
    assert HELPER_FILE.is_file()
    assert not (PYTHON_DIR / "model_eval_adapter").exists()
