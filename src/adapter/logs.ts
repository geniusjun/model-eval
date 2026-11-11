import { open, type FileHandle } from 'node:fs/promises';

import { compareCodeUnits } from './canonical-json.js';
import type { LogParams } from './protocol.js';
import type { Redactor } from '../report/redact.js';

// What the adapter says besides its answers (adapter-protocol §Transport 3, §`log`): the tail of
// its stderr for failure reports, and `log` notifications in the run's `adapter.log` and grouped
// at the end of a run. Free text is redacted where it is written (FR-031).

/** Lines of adapter stderr attached to failure reports. */
export const STDERR_TAIL_LINES = 50;

/** The last lines the adapter wrote to stderr, over every process of one run. */
export class StderrTail {
  private readonly kept: string[] = [];

  constructor(private readonly size = STDERR_TAIL_LINES) {}

  push(line: string): void {
    this.kept.push(line);
    if (this.kept.length > this.size) {
      this.kept.shift();
    }
  }

  lines(): string[] {
    return [...this.kept];
  }
}

/** The levels grouped at the end of a run, in the order they are shown. */
const GROUPED_LEVELS = ['error', 'warn'] as const;

type GroupedLevel = (typeof GROUPED_LEVELS)[number];

function isGrouped(level: string): level is GroupedLevel {
  return GROUPED_LEVELS.some((grouped) => grouped === level);
}

export interface LogGroup {
  readonly level: GroupedLevel;
  /**
   * The group's first message as the adapter wrote it; every message of the group redacts to
   * the same text, so the output redacts it once where it is shown.
   */
  readonly message: string;
  readonly count: number;
}

interface Group {
  readonly level: GroupedLevel;
  readonly message: string;
  readonly redacted: string;
  count: number;
}

/**
 * The `log` notifications of one run. Each becomes one redacted JSON line of `adapter.log`, in
 * arrival order; those received before the file opens (while the cases render) are written
 * when it opens. `warn` and `error` messages are counted per redacted message.
 */
export class AdapterLog {
  private readonly waiting: string[] = [];
  private readonly counts = new Map<string, Group>();
  private handle: FileHandle | undefined;
  private writes: Promise<void> = Promise.resolve();
  private failure: Error | undefined;

  constructor(
    private readonly redactor: Redactor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(params: LogParams): void {
    const redacted = this.redactor.text(params.message);
    const line = `${JSON.stringify({ at: this.now().toISOString(), level: params.level, message: redacted })}\n`;
    if (this.handle === undefined) {
      this.waiting.push(line);
    } else {
      this.write(this.handle, line);
    }
    if (isGrouped(params.level)) {
      const key = JSON.stringify([params.level, redacted]);
      const group = this.counts.get(key) ?? {
        level: params.level,
        message: params.message,
        redacted,
        count: 0,
      };
      group.count += 1;
      this.counts.set(key, group);
    }
  }

  async open(file: string): Promise<void> {
    const handle = await open(file, 'a');
    this.handle = handle;
    for (const line of this.waiting.splice(0)) {
      this.write(handle, line);
    }
  }

  /** Waits for every line; a failed write is reported here. */
  async close(): Promise<void> {
    await this.writes;
    await this.handle?.close();
    this.handle = undefined;
    if (this.failure !== undefined) {
      throw this.failure;
    }
  }

  /** `error` before `warn`, then the most frequent message first, then code-unit order. */
  groups(): LogGroup[] {
    const rank = (level: GroupedLevel): number => GROUPED_LEVELS.indexOf(level);
    return [...this.counts.values()]
      .sort(
        (a, b) =>
          rank(a.level) - rank(b.level) ||
          b.count - a.count ||
          compareCodeUnits(a.redacted, b.redacted),
      )
      .map(({ level, message, count }) => ({ level, message, count }));
  }

  private write(handle: FileHandle, line: string): void {
    this.writes = this.writes.then(() =>
      handle.appendFile(line, 'utf8').catch((error: unknown) => {
        this.failure ??= error instanceof Error ? error : new Error(String(error));
      }),
    );
  }
}
