import { classifyTrial } from '../grade/outcome.js';
import { trialKeyId } from './ids.js';
import type { AttemptLine, CostLine, SendLine, TrialLine } from './records.js';
import { trialState } from './retry.js';
import type { WarningCode } from './warning.js';

// Which trial-based codes and `budget-overrun` a running run raises, kept line by line, so the
// manifest is rewritten on a new code without recounting every line at each line (data-model
// §Warnings). The warnings written are still counted from all lines; this only says which codes
// hold now, with the same conditions as `trialWarnings` and `overrunUsd`.

export interface LiveWarningSettings {
  /** The run's recorded `run.retries`, which decides when a trial is finished. */
  readonly retries: number;
  /** The run's cases; trial-based codes count only their trials. */
  readonly caseIds: ReadonlySet<string>;
  /** The render fingerprints of the manifest. */
  readonly prompts: Readonly<Record<string, string>>;
  /** `report.warn.transientRate`. */
  readonly transientRate: number;
}

interface AttemptCost {
  send: SendLine | undefined;
  /** `costUsd` of the attempt's attempt lines in file order. */
  readonly costs: (number | null)[];
  /** `costUsd` of the attempt's cost lines in file order. */
  readonly costLineCosts: (number | null)[];
}

/** One attempt's share of `overrunUsd`: its cost above the reservation at send. */
function overruns({ send, costs, costLineCosts }: AttemptCost): boolean {
  const reserved = send === undefined ? 0 : send.reservedUsd;
  const all = [...costs, ...costLineCosts];
  if (reserved === null || all.length === 0 || all.some((cost) => cost === null)) {
    return false;
  }
  return all.reduce<number>((sum, cost) => sum + (cost ?? 0), 0) - reserved > 0;
}

function isAttempt(line: TrialLine): line is AttemptLine {
  return 'status' in line;
}

function isSend(line: TrialLine): line is SendLine {
  return 'sending' in line;
}

export class LiveWarningCodes {
  private readonly attempts = new Map<string, AttemptLine[]>();
  private readonly effective = new Map<string, AttemptLine>();
  private readonly finishedByCase = new Map<string, Map<number, AttemptLine>>();
  private transient = 0;
  private readonly snapshots = new Map<string, number>();
  private mismatched = 0;
  private readonly identicalCases = new Set<string>();
  private abandoned = 0;
  /** Finished trial keys with an attempt the adapter attached warnings to. */
  private readonly warnedKeys = new Set<string>();
  private readonly costs = new Map<string, AttemptCost>();
  private readonly overrunning = new Set<string>();
  private unkeyedCost = false;

  constructor(private readonly settings: LiveWarningSettings) {}

  /** Takes the next line of `trials.jsonl`, in file order. */
  add(line: TrialLine): void {
    if (isSend(line)) {
      const cost = this.cost(line);
      cost.send ??= line;
      this.noteOverrun(line, cost);
    } else if (isAttempt(line)) {
      const cost = this.cost(line);
      cost.costs.push(line.costUsd);
      this.noteOverrun(line, cost);
      this.attemptLine(line);
    } else {
      this.costLine(line);
    }
  }

  /** The codes that hold for the lines taken so far. */
  codes(): Set<WarningCode> {
    const codes = new Set<WarningCode>();
    const finished = this.effective.size;
    const rate = finished === 0 ? 0 : this.transient / finished;
    if (rate > this.settings.transientRate) {
      codes.add('transient-rate');
    }
    if (this.identicalCases.size > 0) {
      codes.add('identical-repeats');
    }
    if (this.snapshots.size > 1) {
      codes.add('response-model-changed');
    }
    if (this.mismatched > 0) {
      codes.add('render-mismatch');
    }
    if (this.overrunning.size > 0 || this.unkeyedCost) {
      codes.add('budget-overrun');
    }
    if (this.abandoned > 0) {
      codes.add('abandoned-trials');
    }
    if (this.warnedKeys.size > 0) {
      codes.add('adapter-warnings');
    }
    return codes;
  }

  private costLine(line: CostLine): void {
    if (!('caseId' in line)) {
      this.unkeyedCost ||= (line.costUsd ?? 0) > 0;
      return;
    }
    const cost = this.cost(line);
    cost.costLineCosts.push(line.costUsd);
    this.noteOverrun(line, cost);
  }

  private cost(line: { caseId: string; repeat: number; attempt: number }): AttemptCost {
    const id = this.attemptId(line);
    let cost = this.costs.get(id);
    if (cost === undefined) {
      cost = { send: undefined, costs: [], costLineCosts: [] };
      this.costs.set(id, cost);
    }
    return cost;
  }

  private noteOverrun(
    line: { caseId: string; repeat: number; attempt: number },
    cost: AttemptCost,
  ): void {
    const id = this.attemptId(line);
    if (overruns(cost)) {
      this.overrunning.add(id);
    } else {
      this.overrunning.delete(id);
    }
  }

  private attemptId(line: { caseId: string; repeat: number; attempt: number }): string {
    return `${trialKeyId(line)}:${String(line.attempt)}`;
  }

  private attemptLine(line: AttemptLine): void {
    if (!this.settings.caseIds.has(line.caseId)) {
      return;
    }
    const id = trialKeyId(line);
    const attempts = this.attempts.get(id) ?? [];
    attempts.push(line);
    this.attempts.set(id, attempts);
    const state = trialState(attempts, this.settings.retries, () => 0);
    const before = this.effective.get(id);
    const after = state.kind === 'finished' ? state.effective : undefined;
    if (before !== undefined) {
      this.count(before, -1);
    }
    if (after === undefined) {
      this.effective.delete(id);
    } else {
      this.effective.set(id, after);
      this.count(after, 1);
    }
    const warned = attempts.some((attempt) => (attempt.warnings ?? []).length > 0);
    if (after !== undefined && warned) {
      this.warnedKeys.add(id);
    } else {
      this.warnedKeys.delete(id);
    }
    this.updateCase(line.caseId, line.repeat, after);
  }

  /** Adds (`sign` 1) or removes (`sign` -1) one finished effective line from the counts. */
  private count(line: AttemptLine, sign: 1 | -1): void {
    if (classifyTrial(line) === 'transient') {
      this.transient += sign;
    }
    if (line.status === 'error' && line.error.abandoned !== undefined) {
      this.abandoned += sign;
    }
    if (line.status !== 'ok') {
      return;
    }
    if (line.modelSnapshot !== undefined) {
      const seen = (this.snapshots.get(line.modelSnapshot) ?? 0) + sign;
      if (seen === 0) {
        this.snapshots.delete(line.modelSnapshot);
      } else {
        this.snapshots.set(line.modelSnapshot, seen);
      }
    }
    const { prompts } = this.settings;
    const rendered = Object.hasOwn(prompts, line.caseId) ? prompts[line.caseId] : undefined;
    if (line.fingerprint !== undefined && rendered !== undefined && line.fingerprint !== rendered) {
      this.mismatched += sign;
    }
  }

  /** A case with two or more finished repeats, all `ok` with one raw answer. */
  private updateCase(caseId: string, repeat: number, effective: AttemptLine | undefined): void {
    const repeats = this.finishedByCase.get(caseId) ?? new Map<number, AttemptLine>();
    if (effective === undefined) {
      repeats.delete(repeat);
    } else {
      repeats.set(repeat, effective);
    }
    this.finishedByCase.set(caseId, repeats);
    const lines = [...repeats.values()];
    const [first] = lines;
    const identical =
      lines.length >= 2 &&
      first?.status === 'ok' &&
      lines.every((line) => line.status === 'ok' && line.raw === first.raw);
    if (identical) {
      this.identicalCases.add(caseId);
    } else {
      this.identicalCases.delete(caseId);
    }
  }
}
