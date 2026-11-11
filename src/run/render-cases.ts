import type { AdapterClient } from '../adapter/client.js';
import type { RenderParams } from '../adapter/protocol.js';
import type { Case } from '../config/schema.js';
import { inputTokenEstimate, type CasePlan } from './cost.js';
import { renderFingerprint } from './hashes.js';
import { trialSeed } from './ids.js';
import type { RunCaseSpec } from './run-cases.js';

// data-model §Send Order, Start: every case is rendered before the first trial.

export interface RenderedCases {
  /** Render fingerprint per case; empty when the adapter does not render. */
  readonly prompts: Readonly<Record<string, string>>;
  /** Per case, what the estimates and reservations use. */
  readonly plans: ReadonlyMap<string, CasePlan>;
  /** Some case's input tokens came from `estimate.inputTokens` (`estimate-low-accuracy`). */
  readonly lowAccuracy: boolean;
}

/** A failed case: the adapter's message, or `input-tokens` when `estimate.inputTokens` is missing. */
export interface RenderFailure {
  readonly caseId: string;
  readonly cause: 'render' | 'input-tokens';
  readonly message?: string;
}

export type RenderResultSet =
  | { readonly ok: true; readonly rendered: RenderedCases }
  | { readonly ok: false; readonly failures: readonly RenderFailure[] };

/** What a render request needs of a case. */
export type RenderSpec = Pick<RunCaseSpec, 'id' | 'target' | 'requestLang'> & {
  readonly definition: Pick<Case, 'input'>;
};

/** The `render` request of a case: repeat 0's `caseId`, `repeat` and `seed`, as `generate` sends. */
export function renderParams(spec: RenderSpec, seed: number): RenderParams {
  return {
    target: spec.target,
    ...(spec.requestLang === undefined ? {} : { lang: spec.requestLang }),
    input: spec.definition.input,
    caseId: spec.id,
    repeat: 0,
    seed: trialSeed(seed, spec.id, 0),
  };
}

/**
 * Renders every case with repeat 0's `caseId`, `repeat` and `seed` when the adapter declares
 * `render`, and counts input tokens from the render, else from `estimate.inputTokens`.
 */
export async function renderCases(
  client: AdapterClient,
  cases: readonly RunCaseSpec[],
  seed: number,
  configuredInputTokens: number | undefined,
): Promise<RenderResultSet> {
  const renders = client.info.capabilities.render;
  const outcomes = await Promise.all(
    cases.map(async (spec) => {
      if (!renders) {
        return { spec, render: undefined, message: undefined };
      }
      const outcome = await client.render(renderParams(spec, seed));
      return outcome.kind === 'result'
        ? { spec, render: outcome.value, message: undefined }
        : { spec, render: undefined, message: outcome.message };
    }),
  );
  const failures: RenderFailure[] = [];
  const prompts: Record<string, string> = {};
  const plans = new Map<string, CasePlan>();
  let lowAccuracy = false;
  for (const { spec, render, message } of outcomes) {
    if (message !== undefined) {
      failures.push({ caseId: spec.id, cause: 'render', message });
      continue;
    }
    const estimate = inputTokenEstimate(render, configuredInputTokens);
    if (!estimate.ok) {
      failures.push({ caseId: spec.id, cause: 'input-tokens' });
      continue;
    }
    lowAccuracy ||= estimate.lowAccuracy;
    if (render !== undefined) {
      prompts[spec.id] = renderFingerprint(render);
    }
    plans.set(spec.id, {
      lang: spec.lang,
      inputTokens: estimate.tokens,
      ...(render?.maxOutputTokens === undefined ? {} : { maxOutputTokens: render.maxOutputTokens }),
    });
  }
  return failures.length === 0
    ? { ok: true, rendered: { prompts, plans, lowAccuracy } }
    : { ok: false, failures };
}
