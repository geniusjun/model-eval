"""`initialize`'s `service`: `version`, `dirty` and `treeHash` of `service_dir`, each test in a
temporary git repository (data-model §Service Version; helper-scenarios S-RV-04 to S-RV-07,
S-RV-09 to S-RV-17)."""

from __future__ import annotations

import hashlib
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from protocol_client import SERVICES_DIR, AdapterProcess, MockApi, api_env

GIT_CONFIG = (
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "init.defaultBranch=main",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "protocol.file.allow=always",
)
L1_GIT = re.compile(r"^Service version not reported: git [a-z-]+: fatal: .+\.$")


def git_env() -> dict[str, str]:
    """This process's environment without the variables that point git at another repository,
    and without the user's global and system configuration."""
    env = {name: value for name, value in os.environ.items() if not name.startswith("GIT_")}
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    return env


def git(folder: Path, *arguments: str, check: bool = True) -> str:
    done = subprocess.run(
        ["git", *GIT_CONFIG, *arguments],
        cwd=folder,
        env=git_env(),
        capture_output=True,
        check=False,
    )
    if check and done.returncode != 0:
        raise AssertionError(f"git {' '.join(arguments)} failed: {done.stderr.decode()}")
    return done.stdout.decode().strip()


def write(folder: Path, files: dict[str, bytes]) -> None:
    for name, content in files.items():
        path = folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)


def repository(folder: Path, files: dict[str, bytes], *init: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    git(folder, "init", "-q", *init)
    write(folder, files)
    commit(folder)
    return folder


def commit(folder: Path, message: str = "change") -> None:
    git(folder, "add", "-A")
    git(folder, "commit", "-q", "--allow-empty", "-m", message)


# --- Reading the reported version ---------------------------------------------------------


@dataclass
class Reported:
    service: dict[str, Any]
    warnings: list[str]


def report(
    mock: MockApi,
    service_dir: str | Path | None,
    tool_paths: list[Path] | None = None,
    cwd: Path | None = None,
    extra_env: dict[str, str] | None = None,
) -> Reported:
    """Starts version_service.py and returns `initialize`'s `service` and the `log` warnings."""
    env = {**api_env(mock.url), **(extra_env or {})}
    if service_dir is not None:
        env["MODEL_EVAL_SERVICE_DIR"] = str(service_dir)
    params = {
        "protocolVersion": "1",
        "client": {"name": "model-eval", "version": "0.0.0-test"},
        "variant": {"id": "next", "model": "model-b"},
        "timeoutMs": 30_000,
        "toolPaths": [str(path) for path in tool_paths or []],
    }
    adapter = AdapterProcess("version_service", env, cwd=cwd or SERVICES_DIR)
    try:
        response = adapter.request("initialize", params, timeout=15)
        adapter.request("shutdown")
    finally:
        adapter.close()
    assert "result" in response, f"initialize failed: {response}"
    warnings = [log["message"] for log in adapter.exchange.logs if log.get("level") == "warn"]
    return Reported(response["result"].get("service", {}), warnings)


def full(mock: MockApi, service_dir: Path, tool_paths: list[Path] | None = None) -> Reported:
    """The version, asserting that all three values were reported without a warning."""
    reported = report(mock, service_dir, tool_paths)
    assert set(reported.service) == {"version", "dirty", "treeHash"}, reported
    assert reported.warnings == []
    return reported


def tree_hash(entries: list[tuple[bytes, str, bytes]]) -> str:
    """The treeHash of data-model §`treeHash` step 5, built here from the entries the test
    wrote: (path relative to the folder, kind, content)."""
    data = b"".join(
        path + b"\0" + kind.encode() + b"\0" + str(len(content)).encode() + b"\0" + content
        for path, kind, content in sorted(entries)
    )
    return "sha256:" + hashlib.sha256(data).hexdigest()


def tree_hash_of(entries: dict[str, bytes]) -> str:
    return tree_hash([(name.encode(), "f", content) for name, content in entries.items()])


SERVICE_FILES = {"app.py": b"print('service')\n", "data/store.bin": b"\x00\x01\xff binary\n"}


# --- Reported values ------------------------------------------------------------------------


def test_003_FR_003_reports_full_sha_dirty_and_a_tree_hash_of_the_files(
    mock_api: MockApi, tmp_path: Path
) -> None:
    service = repository(tmp_path / "service", SERVICE_FILES)
    (service / "link").symlink_to("app.py")
    commit(service)
    reported = full(mock_api, service)
    assert reported.service["version"] == git(service, "rev-parse", "HEAD")
    assert re.fullmatch(r"[0-9a-f]{40}", reported.service["version"])
    assert reported.service["dirty"] is False
    entries = [(name.encode(), "f", content) for name, content in SERVICE_FILES.items()]
    assert reported.service["treeHash"] == tree_hash([*entries, (b"link", "l", b"app.py")])


def test_003_FR_003_reports_the_64_character_sha_of_a_sha256_repository(
    mock_api: MockApi, tmp_path: Path
) -> None:
    service = repository(tmp_path / "service", SERVICE_FILES, "--object-format=sha256")
    reported = full(mock_api, service)
    assert re.fullmatch(r"[0-9a-f]{64}", reported.service["version"])
    assert reported.service["version"] == git(service, "rev-parse", "HEAD")
    assert reported.service["treeHash"] == tree_hash_of(SERVICE_FILES)


def test_003_FR_003_dirty_after_an_edit_or_an_untracked_file(
    mock_api: MockApi, tmp_path: Path
) -> None:
    service = repository(tmp_path / "service", SERVICE_FILES)
    write(service, {"app.py": b"print('edited')\n"})
    assert full(mock_api, service).service["dirty"] is True
    git(service, "checkout", "--", "app.py")
    write(service, {"notes.txt": b"untracked\n"})
    reported = full(mock_api, service)
    assert reported.service["dirty"] is True
    assert reported.service["treeHash"] == tree_hash_of(
        {**SERVICE_FILES, "notes.txt": b"untracked\n"}
    )


def test_003_FR_003_a_relative_service_dir_resolves_from_the_adapter_folder(
    mock_api: MockApi, tmp_path: Path
) -> None:
    service = repository(tmp_path / "service", SERVICE_FILES)
    adapter_folder = tmp_path / "eval"
    adapter_folder.mkdir()
    reported = report(mock_api, "../service", cwd=adapter_folder)
    assert reported.service == full(mock_api, service).service


def test_003_FR_003_reports_none_without_service_dir(mock_api: MockApi) -> None:
    reported = report(mock_api, None)
    assert reported.service == {}
    assert reported.warnings == []


# --- S-RV-04, S-RV-05: what changes the tree hash ---------------------------------------------


def test_003_FR_003_S_RV_04_tool_files_and_commits_leave_the_tree_hash_unchanged(
    mock_api: MockApi, tmp_path: Path
) -> None:
    service = repository(tmp_path / "service", {**SERVICE_FILES, "eval/rules/base.yaml": b"a\n"})
    rule = service / "eval" / "rules" / "base.yaml"
    config = service / "eval" / "model-eval.config.yaml"
    output = service / "eval" / ".model-eval"
    tool_paths = [config, rule, output]
    before = full(mock_api, service, tool_paths).service
    assert before["treeHash"] == tree_hash_of(SERVICE_FILES)

    write(service, {"eval/rules/base.yaml": b"b\n", "eval/model-eval.config.yaml": b"c\n"})
    output.mkdir()
    write(service, {"eval/.model-eval/run.jsonl": b"{}\n"})
    edited = full(mock_api, service, tool_paths).service
    assert edited["treeHash"] == before["treeHash"]
    assert edited["dirty"] is False

    commit(service, "rule edit")
    assert full(mock_api, service, tool_paths).service["treeHash"] == before["treeHash"]

    write(service, {"app.py": b"print('edited')\n"})
    changed = full(mock_api, service, tool_paths).service["treeHash"]
    git(service, "add", "app.py")
    assert full(mock_api, service, tool_paths).service["treeHash"] == changed
    commit(service, "service edit")
    assert full(mock_api, service, tool_paths).service["treeHash"] == changed


def test_003_FR_003_S_RV_05_content_changes_change_the_tree_hash(
    mock_api: MockApi, tmp_path: Path
) -> None:
    service = repository(tmp_path / "service", {**SERVICE_FILES, ".gitignore": b"*.log\n"})
    hashes = [full(mock_api, service).service["treeHash"]]

    write(service, {"data/store.bin": b"\x00\x02\xff binary\n"})
    hashes.append(full(mock_api, service).service["treeHash"])
    write(service, {"extra.py": b"x = 1\n"})
    hashes.append(full(mock_api, service).service["treeHash"])
    assert len(set(hashes)) == 3

    write(service, {"debug.log": b"ignored\n"})
    assert full(mock_api, service).service["treeHash"] == hashes[-1]


def test_003_FR_003_S_RV_05_nested_repositories_count_by_content(
    mock_api: MockApi, tmp_path: Path
) -> None:
    origin = repository(tmp_path / "origin", {"lib.py": b"VALUE = 1\n"})
    service = repository(tmp_path / "service", SERVICE_FILES)
    git(service, "submodule", "add", "-q", str(origin), "sub")
    commit(service, "add submodule")
    nested = repository(service / "nested", {"notes.md": b"nested\n"})
    first = full(mock_api, service).service["treeHash"]

    write(service / "sub", {"lib.py": b"VALUE = 2\n"})
    in_submodule = full(mock_api, service).service["treeHash"]
    assert in_submodule != first

    write(nested, {"notes.md": b"edited\n"})
    assert full(mock_api, service).service["treeHash"] not in (first, in_submodule)


def test_003_FR_003_nested_repository_content_is_its_tree_hash(
    mock_api: MockApi, tmp_path: Path
) -> None:
    service = repository(tmp_path / "service", SERVICE_FILES)
    nested_files = {"notes.md": b"nested\n"}
    repository(service / "nested", nested_files)
    nested_hash = tree_hash_of(nested_files).encode()
    entries = [(name.encode(), "f", content) for name, content in SERVICE_FILES.items()]
    expected = tree_hash([*entries, (b"nested", "s", nested_hash)])
    assert full(mock_api, service).service["treeHash"] == expected


# --- S-RV-06, S-RV-07: unusual states ---------------------------------------------------------


def test_003_FR_003_S_RV_06_S_RV_10_uninitialised_submodules(
    mock_api: MockApi, tmp_path: Path
) -> None:
    origin = repository(tmp_path / "origin", {"lib.py": b"VALUE = 1\n"})
    service = repository(tmp_path / "service", SERVICE_FILES)
    git(service, "submodule", "add", "-q", str(origin), "sub")
    commit(service, "add submodule")
    git(service, "submodule", "deinit", "-q", "-f", "sub")

    # The computation ends. The empty folder is not a repository top, so it is excluded.
    reported = full(mock_api, service)
    gitmodules = (service / ".gitmodules").read_bytes()
    assert reported.service["treeHash"] == tree_hash_of(
        {**SERVICE_FILES, ".gitmodules": gitmodules}
    )

    # service_dir at the place of an uninitialised submodule: none of the three.
    at_submodule = report(mock_api, service / "sub")
    assert at_submodule.service == {}
    assert at_submodule.warnings == []


def test_003_FR_003_S_RV_07_replaced_files_do_not_fail(mock_api: MockApi, tmp_path: Path) -> None:
    service = repository(tmp_path / "service", SERVICE_FILES)
    (service / "link").symlink_to("app.py")
    commit(service)
    (service / "app.py").unlink()
    write(service, {"app.py/inner.py": b"inner\n"})
    (service / "link").unlink()
    write(service, {"link": b"now a file\n"})

    reported = full(mock_api, service)
    assert reported.service["dirty"] is True
    # app.py is a folder that is not a repository top: excluded, with the files placed in it.
    expected = {"data/store.bin": SERVICE_FILES["data/store.bin"], "link": b"now a file\n"}
    assert reported.service["treeHash"] == tree_hash_of(expected)


def test_003_FR_003_S_RV_07_a_merge_conflict_does_not_fail(
    mock_api: MockApi, tmp_path: Path
) -> None:
    service = repository(tmp_path / "service", SERVICE_FILES)
    git(service, "checkout", "-q", "-b", "other")
    write(service, {"app.py": b"other\n"})
    commit(service, "other")
    git(service, "checkout", "-q", "main")
    write(service, {"app.py": b"main\n"})
    commit(service, "main")
    git(service, "merge", "-q", "other", check=False)
    assert git(service, "diff", "--name-only", "--diff-filter=U") == "app.py"

    reported = full(mock_api, service)
    assert reported.service["dirty"] is True
    # The conflict's stage entries list app.py three times; it is kept once.
    conflicted = {**SERVICE_FILES, "app.py": (service / "app.py").read_bytes()}
    assert reported.service["treeHash"] == tree_hash_of(conflicted)


# --- S-RV-09 to S-RV-17: which files are left out, and when nothing is reported --------------


def test_003_FR_003_S_RV_09_tool_files_reached_through_a_symbolic_link(
    mock_api: MockApi, tmp_path: Path
) -> None:
    real = tmp_path / "real"
    service = repository(real / "service", {**SERVICE_FILES, "eval/rules/base.yaml": b"a\n"})
    alias = tmp_path / "alias"
    alias.symlink_to(real)
    rule_through_alias = alias / "service" / "eval" / "rules" / "base.yaml"
    expected = tree_hash_of(SERVICE_FILES)

    assert (
        full(mock_api, alias / "service", [service / "eval/rules/base.yaml"]).service["treeHash"]
        == expected
    )
    assert full(mock_api, service, [rule_through_alias]).service["treeHash"] == expected


def test_003_FR_003_S_RV_09_a_tool_path_written_with_different_case(
    mock_api: MockApi, tmp_path: Path
) -> None:
    service = repository(tmp_path / "service", {**SERVICE_FILES, "eval/config.yaml": b"a\n"})
    written = service / "EVAL" / "CONFIG.YAML"
    if not written.exists():
        # A case-sensitive file system: the path names no file, so nothing is left out.
        assert full(mock_api, service, [written]).service["treeHash"] == tree_hash_of(
            {**SERVICE_FILES, "eval/config.yaml": b"a\n"}
        )
        return
    assert full(mock_api, service, [written]).service["treeHash"] == tree_hash_of(SERVICE_FILES)


def test_003_FR_003_S_RV_10_reports_none_outside_a_work_tree_or_when_ignored(
    mock_api: MockApi, tmp_path: Path
) -> None:
    plain = tmp_path / "plain"
    write(plain, SERVICE_FILES)
    repo = repository(tmp_path / "repo", {".gitignore": b"ignored/\n", **SERVICE_FILES})
    write(repo, {"ignored/app.py": b"ignored\n"})
    for service_dir in (plain, repo / "ignored"):
        reported = report(mock_api, service_dir)
        assert reported.service == {}, service_dir
        assert reported.warnings == []


def test_003_FR_003_S_RV_11_git_dir_in_the_environment_changes_nothing(
    mock_api: MockApi, tmp_path: Path
) -> None:
    service = repository(tmp_path / "service", SERVICE_FILES)
    other = repository(tmp_path / "other", {"other.py": b"other\n"})
    expected = full(mock_api, service).service
    hook_env = {"GIT_DIR": str(other / ".git"), "GIT_WORK_TREE": str(other)}
    reported = report(mock_api, service, extra_env=hook_env)
    assert reported.service == expected
    assert reported.warnings == []


def test_003_FR_003_S_RV_12_untracked_files_count_with_show_untracked_files_no(
    mock_api: MockApi, tmp_path: Path
) -> None:
    service = repository(tmp_path / "service", SERVICE_FILES)
    git(service, "config", "status.showUntrackedFiles", "no")
    write(service, {"new.py": b"new\n"})
    assert full(mock_api, service).service["dirty"] is True


def test_003_FR_003_S_RV_13_file_names_are_bytes_sorted_by_bytes(
    mock_api: MockApi, tmp_path: Path
) -> None:
    named = {"\U0001f600.txt": b"grin\n", "！.txt": b"bang\n", "a.txt": b"a\n"}
    service = repository(tmp_path / "service", named)
    entries = [(name.encode(), "f", content) for name, content in named.items()]
    if sys.platform == "linux":
        # macOS file systems refuse names that are not UTF-8.
        raw_name = b"\xff\xfe.bin"
        with open(os.path.join(os.fsencode(service), raw_name), "wb") as file:
            file.write(b"raw\n")
        commit(service)
        entries.append((raw_name, "f", b"raw\n"))
    assert full(mock_api, service).service["treeHash"] == tree_hash(entries)


def test_003_FR_003_S_RV_14_a_tool_path_not_created_yet(mock_api: MockApi, tmp_path: Path) -> None:
    service = repository(tmp_path / "service", SERVICE_FILES)
    reported = full(mock_api, service, [service / "eval" / ".model-eval"])
    assert reported.service["treeHash"] == tree_hash_of(SERVICE_FILES)


def test_003_FR_003_S_RV_15_a_deleted_file_is_left_out(mock_api: MockApi, tmp_path: Path) -> None:
    service = repository(tmp_path / "service", SERVICE_FILES)
    (service / "app.py").unlink()
    reported = full(mock_api, service)
    assert reported.service["dirty"] is True
    assert reported.service["treeHash"] == tree_hash_of(
        {"data/store.bin": SERVICE_FILES["data/store.bin"]}
    )


def test_003_FR_003_S_RV_16_changes_outside_a_monorepo_service_folder(
    mock_api: MockApi, tmp_path: Path
) -> None:
    repo = repository(tmp_path / "repo", {"svc/app.py": b"service\n", "web/page.ts": b"page\n"})
    before = full(mock_api, repo / "svc").service
    assert before["treeHash"] == tree_hash_of({"app.py": b"service\n"})
    write(repo, {"web/page.ts": b"edited\n", "web/new.ts": b"new\n"})
    after = full(mock_api, repo / "svc").service
    assert after == before
    assert after["dirty"] is False


def test_003_FR_003_S_RV_17_the_target_of_a_linked_case_file_is_left_out(
    mock_api: MockApi, tmp_path: Path
) -> None:
    service = repository(tmp_path / "service", {**SERVICE_FILES, "fixtures/case.yaml": b"a\n"})
    case_link = tmp_path / "eval" / "cases" / "case.yaml"
    case_link.parent.mkdir(parents=True)
    case_link.symlink_to(service / "fixtures" / "case.yaml")
    before = full(mock_api, service, [case_link]).service
    assert before["treeHash"] == tree_hash_of(SERVICE_FILES)
    write(service, {"fixtures/case.yaml": b"b\n"})
    after = full(mock_api, service, [case_link]).service
    assert after["treeHash"] == before["treeHash"]
    assert after["dirty"] is False


# --- Log warning L1 -----------------------------------------------------------------------


def test_003_FR_003_an_unreadable_file_reports_none_with_l1(
    mock_api: MockApi, tmp_path: Path
) -> None:
    service = repository(tmp_path / "service", {**SERVICE_FILES, "secret.txt": b"secret\n"})
    secret = service / "secret.txt"
    secret.chmod(0)
    try:
        reported = report(mock_api, service)
    finally:
        secret.chmod(0o644)
    assert reported.service == {}
    assert reported.warnings == ["Service version not reported: read secret.txt: EACCES."]


def test_003_FR_003_a_failing_git_command_reports_none_with_l1(
    mock_api: MockApi, tmp_path: Path
) -> None:
    service = repository(tmp_path / "service", SERVICE_FILES)
    (service / ".git" / "index").write_bytes(b"not an index")
    reported = report(mock_api, service)
    assert reported.service == {}
    assert len(reported.warnings) == 1
    assert L1_GIT.match(reported.warnings[0]), reported.warnings
