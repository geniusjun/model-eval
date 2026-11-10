import { canonicalJson, compareCodeUnits } from '../adapter/canonical-json.js';
import type { CallRecord, RenderResult, Usage } from '../adapter/protocol.js';
import type { Price } from '../config/schema.js';
import { trialKeyId, type TrialKey } from './ids.js';
import type { CostProfile, Manifest } from './manifest.js';
import type { AttemptLine, CostLine, SendLine, TrialLine } from './records.js';
import { trialState } from './retry.js';
import type { Warning } from './warning.js';

// data-model §Cost: prices, the cost of calls and attempts, the three estimates and costProfile.

const PER_MILLION = 1_000_000;
const TRAILING_DATE = /-(?:\d{4}-\d{2}-\d{2}|\d{8})$/;
/** Characters the length-based input estimate counts as one token each; others count 0.3. */
const ONE_TOKEN_CHARACTER =
  /[\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
/** The render role of a stored-prompt reference, whose body is not in the request. */
const STORED_PROMPT_ROLE = 'prompt';

export type Pricing = Readonly<Record<string, Price>>;
/** Cost profiles of one run per language key. */
export type ProfileMap = Readonly<Record<string, CostProfile>>;

// Prices

/**
 * `unpriced`: the model has no price, so the most expensive configured price per bucket applies.
 * `none`: no price is configured at all, so cost is unknown (`null`), never 0.
 */
export type PriceChoice =
  | { readonly kind: 'priced'; readonly price: Price }
  | { readonly kind: 'unpriced'; readonly price: Price }
  | { readonly kind: 'none' };

function ownPrice(pricing: Pricing, model: string): Price | undefined {
  return Object.hasOwn(pricing, model) ? pricing[model] : undefined;
}

function highest(values: readonly (number | undefined)[]): number | undefined {
  const known = values.filter((value) => value !== undefined);
  return known.length === 0 ? undefined : Math.max(...known);
}

function mostExpensivePrice(pricing: Pricing): Price | undefined {
  const prices = Object.values(pricing);
  const input = highest(prices.map((price) => price.input));
  const output = highest(prices.map((price) => price.output));
  if (input === undefined || output === undefined) {
    return undefined;
  }
  const cachedInput = highest(prices.map((price) => price.cachedInput));
  const cacheWrite = highest(prices.map((price) => price.cacheWrite));
  return {
    input,
    ...(cachedInput === undefined ? {} : { cachedInput }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    output,
  };
}

/** By the model name, then by the name without a trailing `-YYYY-MM-DD` or `-YYYYMMDD`. */
export function priceFor(pricing: Pricing, model: string): PriceChoice {
  const price = ownPrice(pricing, model) ?? ownPrice(pricing, model.replace(TRAILING_DATE, ''));
  if (price !== undefined) {
    return { kind: 'priced', price };
  }
  const fallback = mostExpensivePrice(pricing);
  return fallback === undefined ? { kind: 'none' } : { kind: 'unpriced', price: fallback };
}

/** With a cap, an unpriced variant model ends the run before the start as a configuration error. */
export function refusesUnpricedVariant(
  pricing: Pricing,
  model: string,
  maxCostUsd: number | null,
): boolean {
  return maxCostUsd !== null && priceFor(pricing, model).kind !== 'priced';
}

// Charges

/** A cost with what it depended on, so the run can warn or stop. */
export interface Charge {
  /** `null` when a price was needed and none is configured. */
  readonly costUsd: number | null;
  /** A reservation or a substitute price was used. */
  readonly estimated: boolean;
  readonly unpricedModels: readonly string[];
  readonly cachedInputUnpricedModels: readonly string[];
}

const NO_CHARGE: Charge = {
  costUsd: 0,
  estimated: false,
  unpricedModels: [],
  cachedInputUnpricedModels: [],
};

function sumUsd(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) {
      return null;
    }
    total += value;
  }
  return total;
}

function union(lists: readonly (readonly string[])[]): string[] {
  return [...new Set(lists.flat())];
}

function addCharges(charges: readonly Charge[]): Charge {
  return {
    costUsd: sumUsd(charges.map((charge) => charge.costUsd)),
    estimated: charges.some((charge) => charge.estimated),
    unpricedModels: union(charges.map((charge) => charge.unpricedModels)),
    cachedInputUnpricedModels: union(charges.map((charge) => charge.cachedInputUnpricedModels)),
  };
}

function usageUsd(usage: Usage, price: Price): number {
  // Without a write amount in the response, every non-hit input token may have been a write.
  const inputRate =
    price.cacheWrite !== undefined && usage.cacheWrite === undefined
      ? price.cacheWrite
      : price.input;
  const tokens =
    (usage.input ?? 0) * inputRate +
    (usage.cachedInput ?? 0) * (price.cachedInput ?? price.input) +
    (usage.cacheWrite ?? 0) * (price.cacheWrite ?? price.input) +
    (usage.output ?? 0) * price.output;
  return tokens / PER_MILLION;
}

/** The cost of known token buckets of one call to `model`; `reasoning` is inside `output`. */
export function usageCharge(usage: Usage, model: string, pricing: Pricing): Charge {
  const choice = priceFor(pricing, model);
  if (choice.kind === 'none') {
    return { ...NO_CHARGE, costUsd: null };
  }
  const unpriced = choice.kind === 'unpriced';
  const hitsAtInput = (usage.cachedInput ?? 0) > 0 && choice.price.cachedInput === undefined;
  return {
    costUsd: usageUsd(usage, choice.price),
    estimated: unpriced,
    unpricedModels: unpriced ? [model] : [],
    cachedInputUnpricedModels: hitsAtInput ? [model] : [],
  };
}

// Reservations

export interface ReservationTokens {
  readonly input: number;
  readonly output: number;
}

/** Input at max(`input`, `cacheWrite`) price plus output at the `output` price. */
export function callReservationUsd(price: Price, tokens: ReservationTokens): number {
  const inputRate = Math.max(price.input, price.cacheWrite ?? price.input);
  return (tokens.input * inputRate + tokens.output * price.output) / PER_MILLION;
}

function reservationCharge(
  model: string,
  pricing: Pricing,
  tokens: ReservationTokens,
  calls: number,
): Charge {
  const choice = priceFor(pricing, model);
  if (choice.kind === 'none') {
    return { ...NO_CHARGE, costUsd: null, estimated: true };
  }
  return {
    costUsd: callReservationUsd(choice.price, tokens) * calls,
    estimated: true,
    unpricedModels: choice.kind === 'unpriced' ? [model] : [],
    cachedInputUnpricedModels: [],
  };
}

export interface ChargeContext {
  readonly pricing: Pricing;
  readonly variantModel: string;
  /** From `reservationTokens` for the attempt's case. */
  readonly tokens: ReservationTokens;
  /** The largest billed calls per attempt of the case's language (`maxBilledCalls`). */
  readonly billedCalls: number;
}

/** Call reservation at the variant model × the largest billed calls per attempt. */
export function attemptReservation(context: ChargeContext): Charge {
  return reservationCharge(
    context.variantModel,
    context.pricing,
    context.tokens,
    context.billedCalls,
  );
}

function callCharge(call: CallRecord, context: ChargeContext): Charge {
  if (call.outcome === 'failed') {
    return call.usage === undefined
      ? NO_CHARGE
      : usageCharge(call.usage, call.model, context.pricing);
  }
  if (call.outcome === 'ok' && call.usage !== undefined) {
    return usageCharge(call.usage, call.model, context.pricing);
  }
  return reservationCharge(call.model, context.pricing, context.tokens, 1);
}

/**
 * What the adapter reported for one attempt: a result, a failure result or the `data` of a
 * JSON-RPC error (`answered`), or nothing at all (abandoned, `stopped`).
 */
export type AttemptReport =
  | {
      readonly answered: true;
      readonly usage?: Usage | undefined;
      readonly calls?: readonly CallRecord[] | undefined;
    }
  | { readonly answered: false };

/** The cost of one attempt line (data-model §Cost, One Attempt). */
export function attemptCharge(report: AttemptReport, context: ChargeContext): Charge {
  if (!report.answered) {
    return attemptReservation(context);
  }
  if (report.calls !== undefined) {
    return addCharges(report.calls.map((call) => callCharge(call, context)));
  }
  if (report.usage !== undefined) {
    return usageCharge(report.usage, context.variantModel, context.pricing);
  }
  return attemptReservation(context);
}

/**
 * The charge of the `stopped` line that closes a send line without an attempt line: its
 * reservation, `null` when it was reserved without any configured price.
 */
export function closingCharge(send: SendLine): Charge {
  return { ...NO_CHARGE, costUsd: send.reservedUsd, estimated: true };
}

/** The `costUsd` of the cost line for a late response: what it cost above the reservation. */
export function lateCostLineUsd(late: Charge, reservedUsd: number): number | null {
  return late.costUsd === null ? null : Math.max(late.costUsd, reservedUsd) - reservedUsd;
}

// Billed calls and the reservation state

export type KeyedCostLine = Extract<CostLine, { caseId: string }>;
type UnkeyedCostLine = Exclude<CostLine, KeyedCostLine>;

function isBilled(call: CallRecord): boolean {
  return call.outcome !== 'failed' || call.usage !== undefined;
}

function billedCount(calls: readonly CallRecord[] | undefined): number {
  return calls === undefined ? 1 : calls.filter(isBilled).length;
}

function hasAdapterAnswer(attempt: AttemptLine): boolean {
  return !(
    attempt.status === 'stopped' ||
    (attempt.status === 'error' && attempt.error.abandoned !== undefined)
  );
}

/**
 * Billed calls of one attempt, the calls in its cost lines included: `ok` and `unanswered` calls
 * and `failed` calls with usage. Without `calls` an attempt counts as one billed call; one
 * without an adapter answer counts as one, or as the calls of its late response.
 */
export function billedCallsOfAttempt(
  attempt: AttemptLine,
  costLines: readonly KeyedCostLine[],
): number {
  const late = costLines.filter((line) => line.source === 'late');
  const reported = costLines.filter((line) => line.source === 'calls');
  const own = hasAdapterAnswer(attempt)
    ? billedCount(attempt.calls)
    : late.length === 0
      ? 1
      : late.reduce((total, line) => total + billedCount(line.calls), 0);
  return reported.reduce((total, line) => total + billedCount(line.calls ?? []), own);
}

/** What the reservation has seen so far in a run. */
export interface ReservationState {
  readonly maxInputPerCall: number;
  readonly maxOutputPerCall: number;
  /** Largest billed calls per attempt per language key, never below 1. */
  readonly maxBilledCalls: Readonly<Record<string, number>>;
}

/** Billed calls per attempt start from the previous run's `callsPerAttemptMax`, else 1. */
export function initialReservationState(previous: ProfileMap = {}): ReservationState {
  return {
    maxInputPerCall: 0,
    maxOutputPerCall: 0,
    maxBilledCalls: Object.fromEntries(
      Object.entries(previous).map(([lang, profile]) => [
        lang,
        Math.max(1, profile.callsPerAttemptMax),
      ]),
    ),
  };
}

export function maxBilledCalls(state: ReservationState, lang: string): number {
  return state.maxBilledCalls[lang] ?? 1;
}

function inputTokensOf(usage: Usage): number {
  return (usage.input ?? 0) + (usage.cachedInput ?? 0) + (usage.cacheWrite ?? 0);
}

/** A trial line that may carry tokens. */
interface UsageLine {
  readonly usage?: Usage | undefined;
  readonly calls?: readonly CallRecord[] | undefined;
}

/** Usage per call: the calls' own usage, else the line's usage as one call. */
function callUsages(line: UsageLine): Usage[] {
  if (line.calls !== undefined) {
    return line.calls.flatMap((call) => (call.usage === undefined ? [] : [call.usage]));
  }
  return line.usage === undefined ? [] : [line.usage];
}

/** Folds one finished attempt line and its cost lines into the reservation state. */
export function observeAttempt(
  state: ReservationState,
  lang: string,
  attempt: AttemptLine,
  costLines: readonly KeyedCostLine[],
): ReservationState {
  const usages = [attempt, ...costLines].flatMap(callUsages);
  return {
    maxInputPerCall: Math.max(state.maxInputPerCall, ...usages.map(inputTokensOf)),
    maxOutputPerCall: Math.max(state.maxOutputPerCall, ...usages.map((usage) => usage.output ?? 0)),
    maxBilledCalls: {
      ...state.maxBilledCalls,
      [lang]: Math.max(maxBilledCalls(state, lang), billedCallsOfAttempt(attempt, costLines)),
    },
  };
}

/** One case as the estimates and reservations see it. */
export interface CasePlan {
  /** The language key: the case's language, `*` without one. */
  readonly lang: string;
  /** From `inputTokenEstimate`. */
  readonly inputTokens: number;
  /** The render's `maxOutputTokens`, the output limit the service sets on the request. */
  readonly maxOutputTokens?: number;
}

/**
 * Input: the larger of the case estimate and the largest input per call seen. Output: the
 * request's output limit, else the larger of `estimate.outputTokens` and the largest output seen.
 */
export function reservationTokens(
  state: ReservationState,
  plan: Pick<CasePlan, 'inputTokens' | 'maxOutputTokens'>,
  outputTokens: number,
): ReservationTokens {
  return {
    input: Math.max(plan.inputTokens, state.maxInputPerCall),
    output: plan.maxOutputTokens ?? Math.max(outputTokens, state.maxOutputPerCall),
  };
}

// Input token estimate

export type RenderCount = Pick<RenderResult, 'messages' | 'tools' | 'inputTokens'>;

/** `lowAccuracy` raises `estimate-low-accuracy`; `ok: false` is a configuration error. */
export type InputEstimate =
  | { readonly ok: true; readonly tokens: number; readonly lowAccuracy: boolean }
  | { readonly ok: false };

/** Hangul, kana and Han count 1 token each, every other character 0.3, rounded up. */
function countRenderTokens(render: RenderCount): number {
  const texts = render.messages.map((message) => message.content);
  if (render.tools !== undefined) {
    texts.push(canonicalJson(render.tools));
  }
  let oneToken = 0;
  let other = 0;
  for (const text of texts) {
    for (const character of text) {
      if (ONE_TOKEN_CHARACTER.test(character)) {
        oneToken += 1;
      } else {
        other += 1;
      }
    }
  }
  return Math.ceil((oneToken * 10 + other * 3) / 10);
}

/**
 * `configured` is `estimate.inputTokens`. It replaces a missing render and raises a stored-prompt
 * render to at least its value, since the prompt body is not in the request.
 */
export function inputTokenEstimate(
  render: RenderCount | undefined,
  configured: number | undefined,
): InputEstimate {
  if (render === undefined) {
    return configured === undefined
      ? { ok: false }
      : { ok: true, tokens: configured, lowAccuracy: true };
  }
  const count = render.inputTokens ?? countRenderTokens(render);
  if (!render.messages.some((message) => message.role === STORED_PROMPT_ROLE)) {
    return { ok: true, tokens: count, lowAccuracy: false };
  }
  return configured === undefined
    ? { ok: false }
    : { ok: true, tokens: Math.max(count, configured), lowAccuracy: true };
}

// Estimates

export type EstimateBasis = 'history' | 'structure';

export interface EstimateInput {
  readonly cases: readonly CasePlan[];
  readonly repeats: number;
  /** `estimate.outputTokens`. */
  readonly outputTokens: number;
  /** The variant model's price (`priceFor`); `undefined` when no price is configured. */
  readonly price: Price | undefined;
  /** The `costProfile` of the previous run (`previousRun`). */
  readonly previous?: ProfileMap;
}

/** Expected cost of one trial of repeat 0 and of a later repeat. */
export interface PerTrialUsd {
  readonly repeat0: number | null;
  readonly repeatN: number | null;
}

export interface ExpectedEstimate {
  readonly usd: number | null;
  readonly basis: Readonly<Record<string, EstimateBasis>>;
  /** Per language key: the per-trial values re-estimates use before a first batch finishes. */
  readonly perTrial: Readonly<Record<string, PerTrialUsd>>;
}

function assumedOutput(plan: CasePlan, outputTokens: number): number {
  return Math.min(outputTokens, plan.maxOutputTokens ?? outputTokens);
}

/** Repeat 0 writes the whole prompt to the cache and later repeats hit it; one call per trial. */
function structureTrial(plan: CasePlan, outputTokens: number, price: Price): PerTrialUsd {
  const output = assumedOutput(plan, outputTokens) * price.output;
  return {
    repeat0: (plan.inputTokens * (price.cacheWrite ?? price.input) + output) / PER_MILLION,
    repeatN: (plan.inputTokens * (price.cachedInput ?? price.input) + output) / PER_MILLION,
  };
}

function historyTrial(profile: CostProfile | undefined, repeats: number): PerTrialUsd | undefined {
  if (profile === undefined || profile.repeat0MeanUsd === null) {
    return undefined;
  }
  if (repeats > 1 && profile.repeatNMeanUsd === null) {
    return undefined;
  }
  return { repeat0: profile.repeat0MeanUsd, repeatN: profile.repeatNMeanUsd };
}

function caseTotal(trial: PerTrialUsd, repeats: number): number | null {
  if (repeats === 1) {
    return trial.repeat0;
  }
  return trial.repeat0 === null || trial.repeatN === null
    ? null
    : trial.repeat0 + (repeats - 1) * trial.repeatN;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function meanUsd(values: readonly (number | null)[]): number | null {
  const total = sumUsd(values);
  return total === null || values.length === 0 ? null : total / values.length;
}

function groupByLang(cases: readonly CasePlan[]): Map<string, CasePlan[]> {
  const groups = new Map<string, CasePlan[]>();
  for (const plan of cases) {
    groups.set(plan.lang, [...(groups.get(plan.lang) ?? []), plan]);
  }
  return groups;
}

/** The start decision and what SC-005 measures. */
export function expectedEstimate(input: EstimateInput): ExpectedEstimate {
  const basis: Record<string, EstimateBasis> = {};
  const perTrial: Record<string, PerTrialUsd> = {};
  const totals: (number | null)[] = [];
  for (const [lang, plans] of groupByLang(input.cases)) {
    const history = historyTrial(input.previous?.[lang], input.repeats);
    if (history !== undefined) {
      basis[lang] = 'history';
      perTrial[lang] = history;
      const total = caseTotal(history, input.repeats);
      totals.push(total === null ? null : total * plans.length);
      continue;
    }
    basis[lang] = 'structure';
    const { price } = input;
    if (price === undefined) {
      perTrial[lang] = { repeat0: null, repeatN: null };
      totals.push(null);
      continue;
    }
    const trials = plans.map((plan) => structureTrial(plan, input.outputTokens, price));
    perTrial[lang] = {
      repeat0: meanUsd(trials.map((trial) => trial.repeat0)),
      repeatN: meanUsd(trials.map((trial) => trial.repeatN)),
    };
    totals.push(sumUsd(trials.map((trial) => caseTotal(trial, input.repeats))));
  }
  return { usd: sumUsd(totals), basis, perTrial };
}

/** Calls and tokens summed over every trial of one variant. */
export interface PlannedUsage {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * What `--dry-run` shows next to the expected estimate, on the same basis per language: with
 * `history`, the previous run's tokens per trial and p95 calls per trial; with `structure`, the
 * case's input estimate, the assumed output and one call per trial.
 */
export function plannedUsage(input: EstimateInput): PlannedUsage {
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const plan of input.cases) {
    const profile = input.previous?.[plan.lang];
    const history = historyTrial(profile, input.repeats) === undefined ? undefined : profile;
    calls += input.repeats * (history?.callsPerTrialP95 ?? 1);
    inputTokens += input.repeats * (history?.inputTokensMean ?? plan.inputTokens);
    outputTokens +=
      input.repeats * (history?.outputTokensMean ?? assumedOutput(plan, input.outputTokens));
  }
  return {
    calls: Math.round(calls),
    inputTokens: Math.round(inputTokens),
    outputTokens: Math.round(outputTokens),
  };
}

/**
 * No cache hits: per trial, calls × input per call × max(`input`, `cacheWrite`) price plus
 * output per trial × `output` price, with the previous run's p95 values when there is one.
 */
export function conservativeEstimate(input: EstimateInput): number | null {
  const { price } = input;
  if (price === undefined) {
    return null;
  }
  const inputRate = Math.max(price.input, price.cacheWrite ?? price.input);
  let total = 0;
  for (const plan of input.cases) {
    const previous = input.previous?.[plan.lang];
    const calls = previous?.callsPerTrialP95 ?? 1;
    const output = previous?.outputTokensP95 ?? assumedOutput(plan, input.outputTokens);
    const perTrial = (calls * plan.inputTokens * inputRate + output * price.output) / PER_MILLION;
    total += perTrial * input.repeats;
  }
  return total;
}

/**
 * The run whose `costProfile` the `history` basis uses: the latest `complete` run with the same
 * variant fingerprint, at least 2 repeats and no case filter.
 */
export function previousRun(
  manifests: readonly Manifest[],
  fingerprint: string,
): Manifest | undefined {
  return manifests
    .filter(
      (manifest) =>
        manifest.status === 'complete' &&
        manifest.variant.fingerprint === fingerprint &&
        manifest.sampling.repeats >= 2 &&
        manifest.sampling.cases === null,
    )
    .reduce<Manifest | undefined>(
      (latest, manifest) =>
        latest === undefined ||
        Date.parse(manifest.tool.startedAt) > Date.parse(latest.tool.startedAt)
          ? manifest
          : latest,
      undefined,
    );
}

// Trial lines by key

export interface KeyLines {
  readonly key: TrialKey;
  readonly sends: readonly SendLine[];
  readonly attempts: readonly AttemptLine[];
  readonly costLines: readonly KeyedCostLine[];
}

export interface TrialIndex {
  /** By `trialKeyId`, in the order keys first appear. */
  readonly keys: ReadonlyMap<string, KeyLines>;
  /** Cost lines of calls that belong to no known trial. */
  readonly unkeyed: readonly UnkeyedCostLine[];
}

interface MutableKeyLines {
  key: TrialKey;
  sends: SendLine[];
  attempts: AttemptLine[];
  costLines: KeyedCostLine[];
}

export function indexTrialLines(lines: readonly TrialLine[]): TrialIndex {
  const keys = new Map<string, MutableKeyLines>();
  const unkeyed: UnkeyedCostLine[] = [];
  const linesOf = (key: TrialKey): MutableKeyLines => {
    const id = trialKeyId(key);
    const existing = keys.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const created = { key, sends: [], attempts: [], costLines: [] };
    keys.set(id, created);
    return created;
  };
  for (const line of lines) {
    if ('sending' in line) {
      linesOf(line).sends.push(line);
    } else if (!('costCorrection' in line)) {
      linesOf(line).attempts.push(line);
    } else if ('caseId' in line) {
      linesOf(line).costLines.push(line);
    } else {
      unkeyed.push(line);
    }
  }
  return { keys, unkeyed };
}

// costProfile

interface TrialMeasure {
  readonly repeat: number;
  readonly costUsd: number | null;
  readonly inputTokens: number;
  readonly cachedInput: number;
  readonly outputTokens: number;
  readonly billedCalls: number;
}

interface TokenTotals {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

function linesUsage(lines: readonly UsageLine[]): TokenTotals {
  const total: TokenTotals = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 };
  for (const { usage } of lines) {
    total.input += usage?.input ?? 0;
    total.cachedInput += usage?.cachedInput ?? 0;
    total.cacheWrite += usage?.cacheWrite ?? 0;
    total.output += usage?.output ?? 0;
  }
  return total;
}

function attemptBilledCalls(lines: KeyLines): number[] {
  return lines.attempts.map((attempt) =>
    billedCallsOfAttempt(
      attempt,
      lines.costLines.filter((line) => line.attempt === attempt.attempt),
    ),
  );
}

function measureTrial(lines: KeyLines): TrialMeasure {
  const all = [...lines.attempts, ...lines.costLines];
  const usage = linesUsage(all);
  return {
    repeat: lines.key.repeat,
    costUsd: sumUsd(all.map((line) => line.costUsd)),
    inputTokens: inputTokensOf(usage),
    cachedInput: usage.cachedInput,
    outputTokens: usage.output,
    billedCalls: attemptBilledCalls(lines).reduce((total, calls) => total + calls, 0),
  };
}

/** The nearest-rank 95th percentile, the p95 of every record; 0 for no values. */
export function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((95 * sorted.length) / 100) - 1] ?? 0;
}

/** The per-trial share of calls that belong to no known trial, spread over the finished keys. */
function unkeyedShare(unkeyed: readonly UnkeyedCostLine[], finishedKeys: number) {
  const usage = linesUsage(unkeyed);
  const share = (value: number): number => (finishedKeys === 0 ? 0 : value / finishedKeys);
  const costUsd = sumUsd(unkeyed.map((line) => line.costUsd));
  return {
    costUsd: costUsd === null ? null : share(costUsd),
    inputTokens: share(inputTokensOf(usage)),
    outputTokens: share(usage.output),
    billedCalls: share(unkeyed.reduce((total, line) => total + billedCount(line.calls), 0)),
  };
}

function profileOf(
  trials: readonly TrialMeasure[],
  share: ReturnType<typeof unkeyedShare>,
  attemptCalls: readonly number[],
): CostProfile {
  const cost = (trial: TrialMeasure): number | null =>
    trial.costUsd === null || share.costUsd === null ? null : trial.costUsd + share.costUsd;
  const repeat0 = trials.filter((trial) => trial.repeat === 0);
  const repeatN = trials.filter((trial) => trial.repeat > 0);
  const outputs = trials.map((trial) => trial.outputTokens + share.outputTokens);
  const inputTotal = trials.reduce((total, trial) => total + trial.inputTokens, 0);
  const cachedTotal = trials.reduce((total, trial) => total + trial.cachedInput, 0);
  return {
    repeat0MeanUsd: meanUsd(repeat0.map(cost)),
    repeatNMeanUsd: meanUsd(repeatN.map(cost)),
    inputTokensMean: mean(trials.map((trial) => trial.inputTokens + share.inputTokens)) ?? 0,
    outputTokensMean: mean(outputs) ?? 0,
    outputTokensP95: p95(outputs),
    cacheHitRatio: inputTotal === 0 ? null : cachedTotal / inputTotal,
    callsPerTrialP95: Math.max(
      1,
      p95(trials.map((trial) => trial.billedCalls + share.billedCalls)),
    ),
    callsPerAttemptMax: Math.max(1, ...attemptCalls),
  };
}

/**
 * `costProfile` of one run per language key, over its finished keys: each trial sums every line
 * of its key, and calls that belong to no known trial are spread evenly over the finished keys.
 * `langOf` gives a case's language key; `retries` is the run's recorded `run.retries`.
 */
export function costProfiles(
  lines: readonly TrialLine[],
  langOf: (caseId: string) => string,
  retries: number,
): Record<string, CostProfile> {
  const index = indexTrialLines(lines);
  const all = [...index.keys.values()];
  const finished = all.filter((key) => trialState(key.attempts, retries).kind === 'finished');
  const share = unkeyedShare(index.unkeyed, finished.length);
  const langs = [...new Set(finished.map((key) => langOf(key.key.caseId)))];
  return Object.fromEntries(
    langs.map((lang) => {
      const inLang = (key: KeyLines): boolean => langOf(key.key.caseId) === lang;
      return [
        lang,
        profileOf(
          finished.filter(inLang).map(measureTrial),
          share,
          all.filter(inLang).flatMap(attemptBilledCalls),
        ),
      ];
    }),
  );
}

// Warnings

export interface PricingFacts {
  readonly variantId: string;
  readonly maxCostUsd: number | null;
  /** From the run's charges. */
  readonly unpricedModels: readonly string[];
  readonly cachedInputUnpricedModels: readonly string[];
}

/**
 * `unpriced-model` only without a cap: with one, an unpriced call stops the run with
 * `config-error` instead.
 */
export function pricingWarnings(facts: PricingFacts): Warning[] {
  const variants = [facts.variantId];
  const sorted = (models: readonly string[]): string[] =>
    [...new Set(models)].sort(compareCodeUnits);
  const warnings: Warning[] = [];
  if (facts.maxCostUsd === null && facts.unpricedModels.length > 0) {
    warnings.push({
      code: 'unpriced-model',
      params: { models: sorted(facts.unpricedModels) },
      variants,
    });
  }
  if (facts.cachedInputUnpricedModels.length > 0) {
    warnings.push({
      code: 'cached-input-unpriced',
      params: { models: sorted(facts.cachedInputUnpricedModels) },
      variants,
    });
  }
  return warnings;
}

/** `inputTokens` is the `estimate.inputTokens` the estimate used. */
export function estimateLowAccuracyWarning(variantId: string, inputTokens: number): Warning {
  return { code: 'estimate-low-accuracy', params: { inputTokens }, variants: [variantId] };
}
