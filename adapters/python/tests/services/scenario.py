"""Scenario service: the adapter that runs a case of test/fixtures/helper/scenarios/.

`MODEL_EVAL_SCENARIO` holds the case's `service`, `target` and `adapter` as data, with the API
and backend (tests/protocol_client.py `scenario_env`). The target function is synchronous for
the `sync` backend, so the helper runs it through `asyncio.to_thread`, and asynchronous
otherwise. Behaviours, named the same as in the Node scenario services, come from the
`BEHAVIOURS` dict of every `behaviours_*.py` module here; each takes a `Run`. The SDKs are
imported by the behaviours, after the helper.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import os
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from model_eval_adapter import Adapter

JsonObject = dict[str, Any]
Behaviour = Callable[["Run"], Awaitable[Any]]

SPEC: JsonObject = json.loads(os.environ["MODEL_EVAL_SCENARIO"])
SERVICES_DIR = Path(__file__).resolve().parent


# --- Exceptions named by the fixtures ---------------------------------------------------------

EXCEPTIONS: dict[str, type[Exception]] = {}


def exception_class(name: str) -> type[Exception]:
    """The service exception class of that name, the same class each time it is asked for."""
    if name not in EXCEPTIONS:
        EXCEPTIONS[name] = type(name, (Exception,), {"__module__": __name__})
    return EXCEPTIONS[name]


# --- One trial --------------------------------------------------------------------------------


class Run:
    """What a behaviour sees of one trial: the target function's arguments, the API, the backend
    and `service.params`."""

    def __init__(self, case: Any, variant: Any, calls: Any) -> None:
        self.case = case
        self.variant = variant
        self.calls = calls
        self.api: str = SPEC["api"]
        self.backend: str = SPEC["backend"]
        self.params: JsonObject = SPEC["service"].get("params", {})

    @staticmethod
    def exception(name: str, message: str) -> Exception:
        return exception_class(name)(message)


def load_behaviours() -> dict[str, Behaviour]:
    behaviours: dict[str, Behaviour] = {}
    for path in sorted(SERVICES_DIR.glob("behaviours_*.py")):
        behaviours.update(importlib.import_module(path.stem).BEHAVIOURS)
    return behaviours


BEHAVIOUR = load_behaviours()[SPEC["service"]["behaviour"]]


async def run_trial(case: Any, variant: Any, calls: Any) -> Any:
    return await BEHAVIOUR(Run(case, variant, calls))


# --- Target options as the language's values ----------------------------------------------------


def call_condition(condition: JsonObject) -> Callable[[Any], bool]:
    def holds(call: Any) -> bool:
        if "model" in condition:
            models = condition["model"]
            if call.model not in ([models] if isinstance(models, str) else models):
                return False
        if "systemIncludes" in condition:
            systems = [m["content"] for m in call.messages if m["role"] == "system"]
            if not any(condition["systemIncludes"] in text for text in systems):
                return False
        if "toolName" in condition and condition["toolName"] not in call.tool_names:
            return False
        return not ("not" in condition and call_condition(condition["not"])(call))

    return holds


def exception_condition(condition: JsonObject) -> Callable[[BaseException], bool]:
    def holds(error: BaseException) -> bool:
        if "class" in condition and type(error).__name__ != condition["class"]:
            return False
        return condition.get("messageIncludes", "") in str(error)

    return holds


def target_options(options: JsonObject) -> JsonObject:
    """The keyword arguments of `@adapter.target` for the fixture's `target`."""
    names = {"languages": "languages", "inputSchema": "input_schema", "postprocess": "postprocess"}
    kwargs: JsonObject = {names[key]: options[key] for key in names if key in options}
    render = options.get("render")
    if isinstance(render, bool):
        kwargs["render"] = render
    elif isinstance(render, dict) and render.get("form", "option") == "option":
        kwargs["render"] = lambda case, variant: render["result"]
    if "discardOn" in options:
        discard = options["discardOn"]
        kwargs["discard_on"] = (
            tuple(exception_class(name) for name in discard)
            if isinstance(discard, list)
            else exception_condition(discard["when"])
        )
    if "replyCall" in options:
        reply_call = options["replyCall"]
        kwargs["reply_call"] = (
            (lambda call: reply_call)
            if isinstance(reply_call, bool)
            else call_condition(reply_call)
        )
    if "answerTool" in options:
        kwargs["answer_tool"] = tuple(options["answerTool"])
    return kwargs


def adapter_options(options: JsonObject) -> JsonObject:
    kwargs: JsonObject = {"name": "scenario-service", "version": "0.0.1"}
    if "maxConcurrency" in options:
        kwargs["max_concurrency"] = options["maxConcurrency"]
    if "serviceDir" in options:
        kwargs["service_dir"] = options["serviceDir"]
    return kwargs


adapter = Adapter(**adapter_options(SPEC.get("adapter", {})))
TARGET = SPEC["target"]
NAME = "chat"

if SPEC["backend"] == "sync":

    def chat(case: Any, variant: Any, calls: Any) -> Any:
        # The behaviour is one coroutine for every backend; with the sync client it never
        # awaits I/O, so a loop of its own in the helper's worker thread runs it to the end.
        return asyncio.run(run_trial(case, variant, calls))

    adapter.target(NAME, **target_options(TARGET))(chat)
else:

    async def achat(case: Any, variant: Any, calls: Any) -> Any:
        return await run_trial(case, variant, calls)

    adapter.target(NAME, **target_options(TARGET))(achat)

render_option = TARGET.get("render")
if isinstance(render_option, dict) and render_option.get("form") == "decorator":
    adapter.render(NAME)(lambda case, variant: render_option["result"])

if __name__ == "__main__":
    adapter.run()
