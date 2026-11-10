import { classifyTrial } from '../grade/outcome.js';
import type { GroupCounts } from './cap.js';
import { trialKeyId, type TrialKey } from './ids.js';
import { nextKey, type SendPlan } from './order.js';
import type { AttemptLine } from './records.js';
import { trialState, type RandomSource, type TrialState } from './retry.js';

// Where each trial key of one run stands while it runs (data-model §Send Order, §Stopping).

interface KeyEntry {
  readonly key: TrialKey;
  readonly lang: string;
  readonly attempts: AttemptLine[];
  state: TrialState;
  inFlight: boolean;
  /** When a transient trial may be sent again, in `now()` milliseconds. */
  retryAt: number;
}

export interface FinishedCounts {
  readonly finished: number;
  readonly transient: number;
}

/** Trial keys of one run in send order, with their attempt lines and what is in flight. */
export class TrialBook {
  private readonly entries = new Map<string, KeyEntry>();

  constructor(
    private readonly plan: SendPlan,
    langOf: (caseId: string) => string,
    private readonly retries: number,
    private readonly random: RandomSource,
  ) {
    for (const key of plan.keys) {
      this.entries.set(trialKeyId(key), {
        key,
        lang: langOf(key.caseId),
        attempts: [],
        state: { kind: 'unsent' },
        inFlight: false,
        retryAt: 0,
      });
    }
  }

  /** The next key in send order that may go out at `now`, its previous repeat finished. */
  next(now: number): TrialKey | undefined {
    return nextKey(this.plan.keys, {
      isFinished: (key) => this.entry(key)?.state.kind === 'finished',
      isSendable: (key) => {
        const entry = this.entry(key);
        if (entry === undefined || entry.inFlight) {
          return false;
        }
        return (
          entry.state.kind === 'unsent' || (entry.state.kind === 'retry' && entry.retryAt <= now)
        );
      },
    });
  }

  /** The attempt number the next send of `key` uses. */
  nextAttempt(key: TrialKey): number {
    const state = this.entry(key)?.state;
    return state === undefined || state.kind === 'unsent' || state.kind === 'finished'
      ? 1
      : state.nextAttempt;
  }

  markSent(key: TrialKey): void {
    const entry = this.entry(key);
    if (entry !== undefined) {
      entry.inFlight = true;
    }
  }

  /** Records an attempt line; a transient trial with retries left waits from `now`. */
  record(line: AttemptLine, now: number): TrialState | undefined {
    const entry = this.entry(line);
    if (entry === undefined) {
      return undefined;
    }
    entry.inFlight = false;
    entry.attempts.push(line);
    entry.state = trialState(entry.attempts, this.retries, this.random);
    entry.retryAt = entry.state.kind === 'retry' ? now + entry.state.waitMs : 0;
    return entry.state;
  }

  /** The earliest time a waiting retry may go out; `undefined` when none waits. */
  nextRetryAt(): number | undefined {
    const waits = [...this.entries.values()]
      .filter((entry) => !entry.inFlight && entry.state.kind === 'retry')
      .map((entry) => entry.retryAt);
    return waits.length === 0 ? undefined : Math.min(...waits);
  }

  get size(): number {
    return this.entries.size;
  }

  get finished(): number {
    return this.count((entry) => entry.state.kind === 'finished');
  }

  /** Trials sent at least once. */
  get started(): number {
    return this.count((entry) => entry.inFlight || entry.attempts.length > 0);
  }

  get inFlight(): number {
    return this.count((entry) => entry.inFlight);
  }

  get hasRemaining(): boolean {
    return this.finished < this.size;
  }

  /** The first batch: the first `firstBatch` keys of the plan. */
  firstBatchFinished(): boolean {
    return this.plan.keys
      .slice(0, this.plan.firstBatch)
      .every((key) => this.entry(key)?.state.kind === 'finished');
  }

  /** Every trial of `repeat` has finished. */
  roundFinished(repeat: number): boolean {
    return [...this.entries.values()]
      .filter((entry) => entry.key.repeat === repeat)
      .every((entry) => entry.state.kind === 'finished');
  }

  /** Unfinished trials per language key, repeat 0 and later repeats apart. */
  remaining(): Record<string, GroupCounts> {
    const counts: Record<string, { repeat0: number; repeatN: number }> = {};
    for (const entry of this.entries.values()) {
      const group = (counts[entry.lang] ??= { repeat0: 0, repeatN: 0 });
      if (entry.state.kind !== 'finished') {
        if (entry.key.repeat === 0) {
          group.repeat0 += 1;
        } else {
          group.repeatN += 1;
        }
      }
    }
    return counts;
  }

  /** Finished trials whose effective line `segment` wrote, and how many of them are transient. */
  finishedIn(segment: number): FinishedCounts {
    let finished = 0;
    let transient = 0;
    for (const { state } of this.entries.values()) {
      if (state.kind === 'finished' && state.effective.segment === segment) {
        finished += 1;
        if (classifyTrial(state.effective) === 'transient') {
          transient += 1;
        }
      }
    }
    return { finished, transient };
  }

  private entry(key: TrialKey): KeyEntry | undefined {
    return this.entries.get(trialKeyId(key));
  }

  private count(test: (entry: KeyEntry) => boolean): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      if (test(entry)) {
        total += 1;
      }
    }
    return total;
  }
}
