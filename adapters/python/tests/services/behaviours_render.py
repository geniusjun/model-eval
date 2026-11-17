"""The render behaviours of the scenario service (services/scenario.py), for the render-mode
tests (helper-api §Render Mode). The Node scenario services read the same parameters.

- `bodies`: sends each request of `service.params.requests` in order through the case API's
  SDK. A request is the JSON body as the create method's keyword arguments, with `model` set to
  the variant model when absent. The function returns the last response's text, or
  `service.params.result` when given. With `onError` `swallow` a request that raises is passed
  over; otherwise its exception ends the function.
- `render-probe`: sends each probe of `service.params.probes`, `{"model": m, "context": "trial"
  | "none"}`, as a one-line request to model m (`none`: from a new thread that runs in an empty
  context, so it carries no trial context), with the SDK's `max_retries` set to
  `service.params.maxRetries`. It notes how each ended: `{"model", "status", "type",
  "shouldRetry"}` from an error response (the error object's type and the `x-should-retry`
  header, null when absent), or `{"model", "status": 200}`. Then it sends the variant model a
  request with the system `Report.`, `maxTokens` 64 and, as the user message, the JSON of
  `{"calls": the models of the calls the target function's third argument holds at that point,
  "case": the case's fields, "probes": the notes}` with keys sorted and no spaces, and returns
  its text. Every value of that JSON is ASCII, so the text is the same in both languages.
- `rendering-fake`: the `flow` behaviour (services/behaviours_flow.py), except that a call with
  `fakeInRender` is not sent when `case.rendering` is true: the service takes that text as the
  call's answer instead, as a service that replaces a call before the answer with a fake in
  render mode does.
"""

from __future__ import annotations

import contextvars
import json
import threading
from collections.abc import Awaitable, Callable
from typing import Any

from behaviours_flow import CallSpec, Flow, Received
from behaviours_steps import create_method, make_client, request_arguments, response_text

JsonObject = dict[str, Any]

PROBE_USER = "Probe."
PROBE_MAX_TOKENS = 16
REPORT_SYSTEM = "Report."
REPORT_MAX_TOKENS = 64
CASE_FIELDS = ("id", "lang", "input", "repeat", "seed", "rendering")


# --- bodies -----------------------------------------------------------------------------------


async def send(run: Any, client: Any, body: JsonObject) -> Any:
    create = create_method(client, run.api)
    if run.backend == "sync":
        return create(**body)
    return await create(**body)


async def close(run: Any, client: Any) -> None:
    if run.backend == "sync":
        client.close()
    else:
        await client.close()


async def bodies(run: Any) -> Any:
    client = make_client(run.api, run.backend, run.params)
    text = ""
    try:
        for request in run.params["requests"]:
            body = {"model": run.variant.model, **request}
            try:
                text = response_text(run.api, await send(run, client, body))
            except Exception:
                if run.params.get("onError") != "swallow":
                    raise
    finally:
        await close(run, client)
    return run.params.get("result", text)


# --- render-probe -----------------------------------------------------------------------------


def error_note(model: str, error: Exception) -> JsonObject:
    """What the service sees of a failed request: status, error type and retry header."""
    body = getattr(error, "body", None)
    inner = body.get("error") if isinstance(body, dict) else None
    source = inner if isinstance(inner, dict) else body
    response = getattr(error, "response", None)
    return {
        "model": model,
        "status": getattr(error, "status_code", None),
        "type": source.get("type") if isinstance(source, dict) else None,
        "shouldRetry": None if response is None else response.headers.get("x-should-retry"),
    }


def probe_without_context(run: Any, model: str) -> JsonObject:
    """One probe from a new thread that runs in an empty context."""
    client = make_client(run.api, "sync", run.params)
    arguments = request_arguments(
        run.api, {"model": model, "maxTokens": PROBE_MAX_TOKENS}, model, PROBE_USER
    )
    notes: list[JsonObject] = []

    def work() -> None:
        try:
            create_method(client, run.api)(**arguments)
            notes.append({"model": model, "status": 200})
        except Exception as error:
            notes.append(error_note(model, error))

    thread = threading.Thread(target=contextvars.Context().run, args=(work,))
    thread.start()
    thread.join()
    client.close()
    return notes[0]


async def probe_in_trial(run: Any, client: Any, model: str) -> JsonObject:
    arguments = request_arguments(
        run.api, {"model": model, "maxTokens": PROBE_MAX_TOKENS}, model, PROBE_USER
    )
    try:
        await send(run, client, arguments)
    except Exception as error:
        return error_note(model, error)
    return {"model": model, "status": 200}


async def render_probe(run: Any) -> Any:
    client = make_client(run.api, run.backend, run.params)
    try:
        notes = []
        for probe in run.params.get("probes", []):
            model = str(probe["model"])
            if probe.get("context") == "none":
                notes.append(probe_without_context(run, model))
            else:
                notes.append(await probe_in_trial(run, client, model))
        report = {
            "calls": [call.model for call in run.calls],
            "case": {name: getattr(run.case, name) for name in CASE_FIELDS},
            "probes": notes,
        }
        user = json.dumps(report, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        request = {"system": REPORT_SYSTEM, "maxTokens": REPORT_MAX_TOKENS}
        arguments = request_arguments(run.api, request, run.variant.model, user)
        return response_text(run.api, await send(run, client, arguments))
    finally:
        await close(run, client)


# --- rendering-fake ---------------------------------------------------------------------------


class RenderingFakeFlow(Flow):
    """A flow whose calls with `fakeInRender` are replaced by that text in render mode."""

    async def call(self, spec: CallSpec) -> Received:
        fake = spec.get("fakeInRender")
        if fake is None or not self.run.case.rendering:
            return await super().call(spec)
        kwargs, conversation = self.prepare(spec)
        return self.finish(spec, Received(kwargs, conversation, text=str(fake)))


async def rendering_fake(run: Any) -> Any:
    runner = RenderingFakeFlow(run)
    for step in run.params.get("steps", []):
        await runner.step(step)
    return runner.result(run.params.get("result"))


BEHAVIOURS: dict[str, Callable[[Any], Awaitable[Any]]] = {
    "bodies": bodies,
    "render-probe": render_probe,
    "rendering-fake": rendering_fake,
}
