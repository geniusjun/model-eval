# Feature Specification: Adapter Helpers

**Feature Branch**: `003-adapter-helpers`

**Created**: 2026-11-09

**Status**: Draft

**Input**: User description: "Python and TypeScript adapter helpers that run the service's own code, capture its OpenAI and Anthropic API calls at the HTTP layer, and derive each trial's outcome, so a service connects with a short adapter and no code change."

**Builds On**: `001-swap-check` (adapter protocol v1)

## Context

Feature 001 reaches a service through an adapter process. Writing one by hand means, for every service, capturing the raw answer at the model call, telling a discarded answer from an adapter defect, getting the assembled prompt without a model call, and classifying provider errors. Getting any of these wrong silently changes the comparison: a side call graded as the answer, a rate limit counted against the candidate, a fake-storage mismatch hidden in the discard rate.

The helpers do this work once. The adapter author writes a target function that calls the service function and returns its shipped text, plus the exceptions that mean "discarded". The helper watches the HTTP requests the service's SDK already sends, and derives the trial result by fixed rules. Where it cannot see what happened, the adapter declares it instead of the helper guessing.

## User Scenarios & Testing *(mandatory)*

All stories are in scope of this feature; the priority sets the build order.

### User Story 1 - Connect a Python service without changing it (Priority: P1)

An engineer imports the Python helper in an adapter file, wraps the service's existing turn function in a target function, declares the service's discard exception and runs the swap check. Raw answer, shipped text, tokens, finish reason and error kinds are filled in by the helper.

**Why this priority**: Adoption depends on connecting a real service cheaply. Rewriting capture, protocol handling and error classification per service would cost more than the tool is worth.

**Independent Test**: Connect the example Python service (OpenAI SDK, answered by a local mock API server) with the helper and run the same example cases as the Node mock adapter of 001. Both finish without calling a real model.

**Acceptance Scenarios**:

1. **Given** an existing service function that calls the model through the OpenAI SDK, **When** an adapter is written with the helper, **Then** raw answer, shipped text, tokens and finish reason are recorded with an adapter of at most 30 lines and no change to the service code.
2. **Given** a service that discards a model response by raising an exception listed in `discard_on`, **When** the trial runs, **Then** it is recorded as a discard with the captured raw answer and the discard reason.
3. **Given** a service that ends with an exception not listed in `discard_on`, **When** the trial runs, **Then** it is an adapter error and the raw answer is kept for debugging.
4. **Given** service code that prints to stdout, **When** it runs through a helper adapter, **Then** the output goes to stderr and the protocol stays intact.
5. **Given** an empty folder, **When** `init --adapter python` runs, **Then** a config, an adapter skeleton, example rules and cases are created, the helper file is copied, and lint passes.
6. **Given** a provider rate limit that remains after the SDK's retries, **When** the trial runs, **Then** it is `transient` and is retried by the tool.
7. **Given** a provider authentication failure, **When** the trial runs, **Then** the run stops as a configuration error.
8. **Given** an adapter that does not pass the variant model to the service, so every request goes to another model, **When** lint with rendering or a run starts, **Then** the helper reports "No request went to the variant model" as an adapter error and the run stops without comparing two variants on the same model.
9. **Given** an adapter that gives the raw answer and model name itself without rendering, **When** the raw answer appears to come from another model's response, **Then** the trial carries a warning.
10. **Given** a service that calls the same model again after the answer (a memory write) and no `reply_call`, **When** it runs through the helper, **Then** the helper reports that it cannot choose the answer call.
11. **Given** the same service with `reply_call` set, **When** it runs through the helper, **Then** the answer call's output is the raw answer.

---

### User Story 2 - Render the production prompt without a model call (Priority: P1)

Someone who edits a prompt runs `lint --render`. The helper runs the same service function in render mode, captures the answer request and returns its messages, while no captured model request leaves the process.

**Why this priority**: Anchor checks, render fingerprints and input token estimates (001 FR-004, FR-014, FR-015) need the assembled prompt, and services that assemble inside the turn function have no other way to produce it.

**Independent Test**: Run `lint --render` on the example Python service against the mock API server. Lint passes, and the server received no request.

**Acceptance Scenarios**:

1. **Given** a target with `render=True`, **When** `lint --render` runs, **Then** the first request to the variant model is returned as `render` messages with its fingerprint and no captured request reaches the network.
2. **Given** a same-model classification call before the answer and no `reply_call`, **When** lint renders, **Then** it captures the classification request and reports `anchor-missing`.
3. **Given** the same service and no `reply_call`, **When** a run starts, **Then** its trials are adapter errors.
4. **Given** the same service with `reply_call` selecting the answer call, **When** lint renders, **Then** the answer request is rendered.
5. **Given** a case whose path calls no model, **When** it is rendered, **Then** the helper reports "Could not reach the render target request" and lint reports `render-failed`.
6. **Given** a render function that returns part lists, **When** its result is fingerprinted, **Then** it is normalised first and matches the fingerprint of the captured answer request.

---

### User Story 3 - Connect a TypeScript service (Priority: P2)

An engineer connects a Node service with the TypeScript helper, imported from `model-eval/adapter`, using the same options and return values as in Python.

**Why this priority**: Many services are written in TypeScript, and an adapter must be short in either language for the tool to be worth adopting.

**Independent Test**: Run the contract scenarios against the TypeScript helper with the shared fixtures. Results match the Python helper byte for byte.

**Acceptance Scenarios**:

1. **Given** a Node service whose `openai` or `@anthropic-ai/sdk` client is created after the helper import, **When** it runs, **Then** its calls are captured and decided as the Python helper decides them.
2. **Given** an SDK client created before the helper import, **When** the trial runs, **Then** it is an adapter error "No model request was captured" with the guidance on uncaptured transports.
3. **Given** `console.log` in the service, **When** it runs, **Then** the output goes to stderr.
4. **Given** a native module that writes directly to stdout, **When** it runs, **Then** the tool reports it as stdout contamination.
5. **Given** the two-language parity fixtures, **When** both helpers process them, **Then** the values of FR-024 are identical.

---

### User Story 4 - Report what the helper cannot see (Priority: P1)

A service streams its answer, cuts streams, runs checks in parallel, stops waiting under its own time limit, or receives the answer through a transport the helper does not capture. The adapter author reports those facts through `Result`, `ModelCallError`, `reply_call` and `answer_tool`, and helper warnings point at values that look wrong.

**Why this priority**: Without these declarations such services end as adapter errors and cannot be compared at all.

**Independent Test**: Run the raw-given, stream and uncaptured-transport contract scenarios against the mock API servers and compare each trial's outcome with the expected one.

**Acceptance Scenarios**:

1. **Given** a service that streams its answer, **When** the target function returns only the text, **Then** the trial is an adapter error asking for `Result(raw=, finish_reason=)`.
2. **Given** the same service, **When** the target function gives `Result(raw=, finish_reason=)` without `usage=`, **Then** the trial is normal and the stream call is charged its reservation.
3. **Given** a service that cuts a stream for content and ships a fixed message, **When** the adapter gives the received text with `kind="fallback"`, **Then** the trial is a fallback and that text's violations count on raw rules.
4. **Given** a service that stops reading at a configured string, **When** the adapter gives `stopped_early`, **Then** the trial is normal.
5. **Given** the same service, **When** the adapter does not give `stopped_early`, **Then** the trial is a time-out with a warning.
6. **Given** a service that receives the answer through an uncaptured transport, **When** the adapter fills `Result` with raw, final, finish reason, usage and model, **Then** the trial is normal.
7. **Given** the same service, **When** the target function throws `ModelCallError` for a failed call, **Then** the trial counts by that failure's kind.
8. **Given** a service that stops waiting for a request under its own time limit without cutting it and ships a fixed message, **When** the trial ends, **Then** it is a time-out, the same as when the service cancels the request.
9. **Given** an input check sent with the answer that refuses, so the service cuts the answer stream and ships a message, **When** the adapter gives `Result(raw="", kind="fallback", answers=0)`, **Then** the trial is a fallback with zero answers.
10. **Given** a safety check sent with the answer that fails with a rate limit, so the service cuts the answer stream, **When** the target function throws that failure, **Then** the trial is `transient` and no call is counted twice.
11. **Given** a service that receives its final answer as a forced `reply` tool call, **When** the target sets `answer_tool`, **Then** the raw answer is that argument's value and the finish reason is `stop`.

---

### Edge Cases

- **What if no model request was captured, or none went to the variant model?** The trial is an adapter error, never an empty raw answer or a comparison of the same model on both sides (FR-012).
- **What if the service raises an exception the adapter did not declare in `discard_on`?** It is an adapter error, so fake-storage mismatches do not hide in the discard rate (FR-011).
- **What if the service calls the same model besides the answer (classification, memory writes, validation)?** The helper does not guess: several variant model branches are an adapter error until `reply_call` selects the answer calls (FR-010).
- **What if the service validates and regenerates, or picks one of several answers?** The raw answer is the first answer and the shipped text decides final rules and `completed`; when the regeneration request fails, the trial counts as what the service shipped unless it raised a non-discard exception, which counts as that failure (FR-009, FR-014).
- **What if the service ships another model's answer instead of the candidate's?** The target function wraps it with `fallback`, so it is a completion failure and is not graded as the candidate's shipped text (FR-018).
- **When is shipping another model's answer not a fallback?** When, with no secured candidate answer, the candidate call failed or another model's parallel answer arrived first and the service cut the candidate call, the trial is that failure or `timeout`; when another call's failure made the service ship it, it is that failure (FR-014).
- **What if the service streams its answer, or receives it through an uncaptured transport such as Bedrock or a child process?** The target function passes what the service received through `Result` and throws `ModelCallError` on failures, and a stream call without usage is charged its reservation (FR-012, FR-018).
- **What if the service cuts an answer stream?** It counts by one cut reason: the helper assumes "late" unless the adapter's values indicate a content cut, a deliberate stop or a parallel check's refusal, and the target function reports a parallel request's failure (FR-019).
- **What if the service cuts a late stream, resends, and ships the re-received answer?** With no secured answer, raw is the re-received answer, and the cut part is neither graded nor counted as a regeneration (FR-019).
- **What if the service fully received an answer and then cut a streamed regeneration?** With an answer count that includes the cut answer, the adapter's result stands and the first answer is graded on raw rules; when the adapter gives raw without the count and without a fallback kind, the trial is `timeout`, or the failure of a request resent after it (FR-018, FR-019).
- **What if, with no secured answer, the service cuts a late stream, resends, the resend ends in a rate limit and the service ships a fixed message?** The trial is `transient`, the last failure that finished; a resend that also hit a time limit makes it a time-out (FR-014).
- **What if a same-model input check sent with the answer refuses and the service cuts the answer?** With no secured answer the trial is a fallback or discard with zero answers; with a secured answer it is a fallback or discard that counts that answer, with the first answer as raw (FR-016).
- **What if that check uses another model?** The case does not test the swap and should be removed; in a case left in, trials that sent the answer request count as fallbacks (FR-016).
- **What if the service stops waiting under its own time limit without cutting the request?** It is a time-out, as if the service had cancelled it, and the late response is used only for cost and configuration-error checks; the target function reports the time-out when that request finishes before the function returns (FR-015, FR-018).
- **What if a side call fails?** When the service swallows it and answers, the outcome stands and it counts as a side-call failure; when it stops the service from answering, the trial is that failure (FR-014).
- **What if any call fails on authentication, permission, quota, billing or the TLS certificate?** The trial is a configuration error whatever else happened, and the run stops (FR-013).
- **What if the service calls a model in background work after returning?** The cost is reported through `calls` notifications and the call is never graded (FR-008).
- **What if the service hands model calls to threads that do not carry the trial context?** With one trial in progress the call joins it; with more, every trial in progress ends as an adapter error (FR-006).
- **What if a tool loop ends in a structured final answer?** The trial completes on the shipped text, and when that answer arrives as a tool call the target names the tool with `answer_tool` (FR-010).

## Requirements *(mandatory)*

### Functional Requirements

#### Protocol and Process

- **FR-001**: Helpers MUST answer `initialize`, `render`, `generate`, `cancel` and `shutdown` of adapter protocol v1, run concurrent requests and match responses by `id`, so the adapter author writes only a target function and the service's discard exceptions.
- **FR-002**: Helpers MUST, from the moment they are imported, send the service's standard output to stderr (in Node, output written through `process.stdout` and `console`) and write protocol messages through a channel kept aside; output a Node native module or child process writes directly to descriptor 1 is left to the tool's contamination check.
- **FR-003**: Helpers MUST report the full commit SHA, dirty flag and content hash (`treeHash`) of a given `service_dir`, excluding the tool's files, and report none of the three when any part cannot be computed.
- **FR-004**: Helpers MUST report their language and version in `initialize` and declare support for `stages` and `cancel`.

#### Capture

- **FR-005**: Helpers MUST capture OpenAI Chat Completions, OpenAI Responses and Anthropic Messages requests sent through the default transports of the supported SDK major versions, without changing the service code or what the SDK and the service receive.
- **FR-006**: Helpers MUST keep calls per trial context and, when a request outside any trial context cannot be tied to a single trial in progress, end every trial in progress as an adapter error.
- **FR-007**: Helpers MUST record per call the model, non-overlapping token buckets, the finish reason on the protocol scale, the response model, the HTTP status and the latency, and report a trial's captured calls in send order.
- **FR-008**: Helpers MUST wait for a trial's unfinished calls before sending its result, within the tool's time limit, and report calls sent after the service function returned through `calls` notifications that are never graded.

#### Outcome

- **FR-009**: Helpers MUST take the raw answer from the first answer of the answer candidate calls, identify the variant model by its exact name or the name followed only by a date, and report how many answers the service received.
- **FR-010**: Helpers MUST report an adapter error instead of guessing when variant model calls form several branches or answers come from branches with different system prompts, and MUST let the adapter select answer calls with `reply_call` and name a tool that carries the final answer with `answer_tool`.
- **FR-011**: Helpers MUST record a service exception as a discard only when it matches the target's `discard_on`, and every other exception as an adapter error that keeps a received answer as `capturedRaw`.
- **FR-012**: Helpers MUST report as adapter errors, never as empty answers, a trial with no captured model request, a trial with no request to the variant model, and a trial whose raw answer cannot be determined from captured calls.
- **FR-013**: Helpers MUST derive the trial outcome in the order of the outcome decision, with a `config` failure of any call overriding every other result.
- **FR-014**: Helpers MUST report the failure's kind when a model call failure left the service without an answer, and report what the service shipped when it filtered a secured answer and the regeneration request failed.
- **FR-015**: Helpers MUST count a call that the service stopped waiting for without cutting it the same as a call the service cancelled.
- **FR-016**: Helpers MUST report a fallback or discard with zero answers when a same-model call before the answer refused, the service never requested the answer and it ended in a fallback or discard, or when the adapter reports that a check sent with the answer refused.
- **FR-017**: Helpers MUST classify failures by HTTP status, the error object's type, code and message, and the transport cause, per the helper error table, without relying on SDK exception class names.

#### Values the Adapter Reports

- **FR-018**: Helpers MUST accept the raw answer, shipped text, kind, answer count, finish reason, usage, model and response snapshot from the adapter (`Result`) and failures the helper cannot see (`ModelCallError`), and match them to captured calls so that no call is counted twice.
- **FR-019**: Helpers MUST treat a stream the service cut as cut late unless the adapter's values indicate a content cut, a deliberate stop or a parallel check's refusal, and leave a cut caused by a parallel request's failure to the target function to report.
- **FR-020**: Helpers MUST attach the helper warning sentences to a trial's result when their conditions hold, without changing the outcome.

#### Render and Cancel

- **FR-021**: In render mode, helpers MUST run the target function, send no captured model request to the network, and return the first answer-candidate request in the protocol `render` shape with its fingerprint, normalising adapter-supplied render results the same way.
- **FR-022**: Helpers MUST compute each trial's `fingerprint` from the first request of the branch that produced the first answer, in the render shape, so it compares directly with the render fingerprint.
- **FR-023**: On `cancel`, helpers MUST stop the trial's work, record the calls they cut as `unanswered` without classifying them, and fail that trial's later captured requests before they are sent.

#### Languages and Distribution

- **FR-024**: The Python and TypeScript helpers MUST produce byte-identical raw answers, shipped texts, fingerprints, `treeHash`, discard reasons and `retryAfterMs` for the same service behaviour.
- **FR-025**: The Python helper MUST be one file that needs only the Python standard library, for the copy that `init` makes (001 FR-033), and the TypeScript helper MUST ship as the `model-eval/adapter` subpath of the tool package.

### Key Entities *(include if feature involves data)*

- **Captured call**: One request to a captured API path and its response, with its model, usage, finish reason, status and when it ended.
- **Branch**: A call together with the calls that resend it or continue its tool loop.
- **Answer candidate call**: A variant model call that may carry the reply; selected by `reply_call` when set.
- **Answer**: A successful response of an answer candidate call that did not end in a tool call, or a call of the `answer_tool`.
- **Cut stream**: A stream the service stopped reading before the model finished.
- **Secured answer**: A fully received answer, or non-empty text the service received before cutting a stream for content (001 adapter-protocol §Answers).
- **Target function**: The adapter's function that calls the service and returns its shipped text, `fallback()`, a `Result`, or throws `ModelCallError`.
- **Service version**: Commit SHA, dirty flag and content hash of `service_dir`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An adapter that connects the example Python service, which calls the model through the OpenAI SDK, is at most 30 lines and needs no change to the service code.
- **SC-002**: The contract tests pass for every combination of helper language, supported SDK major version, API, and in Python sync, async and aiohttp clients, against local mock API servers and without calling a real model.
- **SC-003**: In the two-language parity scenarios, both helpers produce the values of FR-024 byte for byte.
- **SC-004**: The example Python service, run through its helper adapter against the local mock API server, completes `lint --render` and the swap check on the same example cases as the 001 Node mock adapter, without calling a real model.
- **SC-005**: In every load-order and uncaptured-transport scenario, the trial ends in the listed adapter error or carries the listed warning, and no trial records an empty raw answer for a call the helper did not capture.

## Assumptions

- Adapter authors can import the service code into the adapter process and run its turn function against fake storage (001 plan D2).
- The service calls the three APIs through the official OpenAI or Anthropic SDKs or plain HTTP on the default transports; other ways are reported by the adapter through `Result` and `ModelCallError`.
- The service's own time limits and retry policies stay as in production; the helper never changes them.
- Out of scope: parsing streaming content (the helper reads only end markers, and the adapter passes what the service received) and prompt assembly, which the service code does (constitution I). Responses background mode works the same way: the helper does not parse it, and the adapter passes the final output the service received (data-model §Raw Cannot Be Determined row 3).
- Out of scope: content stored outside the request body, namely Responses stored prompt bodies, earlier turns linked through `conversation` or `previous_response_id`, and conversations kept on the server with Anthropic beta `thread`. Render, anchor checks and fingerprints see only the request body, and branch rules cannot link a request continued through beta `thread` to the earlier call.
- Out of scope: paid calls outside the three captured APIs, such as embeddings. They are not captured and are missing from the cost total.
- Out of scope: equal `treeHash` for the same service code on another machine (research R11). Resuming on another machine is not supported (001 data-model §Resume and Locking), and comparing runs from different machines can raise `versions-differ`.
- Out of scope: helpers for other languages; they use the protocol directly (001 adapter-protocol §Minimal Adapter).
