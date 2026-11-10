import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  classifyTrial,
  completedGrade,
  effectiveAttempts,
  finalSurfaceText,
  isEmptyText,
  mayBeSystematic,
  rawSurfaceText,
  type TrialOutcome,
} from '../../../src/grade/outcome.js';
import { trialLineSchema, type AttemptLine } from '../../../src/run/records.js';
import { errorLine, okLine, stoppedLine } from './lines.js';

interface Row {
  readonly name: string;
  readonly line: AttemptLine;
  readonly outcome: TrialOutcome;
  readonly completed: 'pass' | 'fail' | 'skip';
  readonly raw: string | undefined;
  readonly final: string | undefined;
}

// data-model §Trial Outcomes, one entry per row in table order.
const ROWS: readonly Row[] = [
  {
    name: '1 config error',
    line: errorLine('config'),
    outcome: 'config',
    completed: 'skip',
    raw: undefined,
    final: undefined,
  },
  {
    name: '2 adapter error',
    line: errorLine('adapter', { error: { kind: 'adapter', message: 'x', abandoned: 'timeout' } }),
    outcome: 'adapter',
    completed: 'skip',
    raw: undefined,
    final: undefined,
  },
  {
    name: '3 transient error',
    line: errorLine('transient'),
    outcome: 'transient',
    completed: 'skip',
    raw: undefined,
    final: undefined,
  },
  {
    name: '4 permanent error',
    line: errorLine('permanent'),
    outcome: 'permanent',
    completed: 'fail',
    raw: undefined,
    final: undefined,
  },
  {
    name: '5 service time-out',
    line: errorLine('timeout'),
    outcome: 'timeout',
    completed: 'fail',
    raw: undefined,
    final: undefined,
  },
  {
    name: '6 empty raw with one answer',
    line: okLine({ raw: '', final: '', finishReason: 'length' }),
    outcome: 'empty-raw',
    completed: 'fail',
    raw: undefined,
    final: undefined,
  },
  {
    name: '7 discarded',
    line: okLine({ raw: '이건 잘린 답', finalKind: 'discarded', discardReason: 'AnswerCut' }),
    outcome: 'discarded',
    completed: 'fail',
    raw: '이건 잘린 답',
    final: undefined,
  },
  {
    name: '8 fallback',
    line: okLine({ raw: '좋습니다.', finalKind: 'fallback', final: '잠시 후 다시 말해줘' }),
    outcome: 'fallback',
    completed: 'fail',
    raw: '좋습니다.',
    final: undefined,
  },
  {
    name: '9 model answer shipped empty',
    line: okLine({ raw: 'Hello 😀', final: ' \n' }),
    outcome: 'empty-final',
    completed: 'fail',
    raw: 'Hello 😀',
    final: undefined,
  },
  {
    name: '10 model answer cut',
    line: okLine({ raw: 'Hello there, how', final: 'Hello there, how', finishReason: 'length' }),
    outcome: 'cut',
    completed: 'fail',
    raw: 'Hello there, how',
    final: 'Hello there, how',
  },
  {
    name: '10 model answer filtered',
    line: okLine({ raw: 'Hello', final: 'Hello', finishReason: 'content_filter' }),
    outcome: 'cut',
    completed: 'fail',
    raw: 'Hello',
    final: 'Hello',
  },
  {
    name: '11 normal answer',
    line: okLine(),
    outcome: 'complete',
    completed: 'pass',
    raw: '안녕! 오늘 어땠어?',
    final: '안녕! 오늘 어땠어?',
  },
];

describe('trial outcomes', () => {
  for (const row of ROWS) {
    it(`001 FR-009 FR-018 row ${row.name}: completed, raw and final columns`, () => {
      const outcome = classifyTrial(row.line);
      expect(outcome).toBe(row.outcome);
      expect(completedGrade(outcome)).toBe(row.completed);
      expect(rawSurfaceText(row.line)).toBe(row.raw);
      expect(finalSurfaceText(row.line)).toBe(row.final);
    });
  }

  it('001 FR-009 a call that failed with kind config makes row 1, whatever the adapter reported', () => {
    const configCall = { model: 'model-b', outcome: 'failed', errorKind: 'config', branch: 'side' };
    for (const line of [
      okLine({ calls: [{ model: 'model-b', outcome: 'ok' }, configCall] }),
      errorLine('transient', { calls: [configCall] }),
      errorLine('timeout', { calls: [{ ...configCall, outcome: 'unanswered' }] }),
    ]) {
      expect(classifyTrial(line)).toBe('config');
      expect(completedGrade(classifyTrial(line))).toBe('skip');
      expect(rawSurfaceText(line)).toBeUndefined();
      expect(finalSurfaceText(line)).toBeUndefined();
    }
    const okConfigKind = okLine({
      calls: [{ model: 'model-b', outcome: 'ok', errorKind: 'config' }],
    });
    expect(classifyTrial(okConfigKind)).toBe('complete');
  });

  it('001 FR-018 stopped attempts leave every rule', () => {
    const line = stoppedLine();
    expect(classifyTrial(line)).toBe('stopped');
    expect(completedGrade('stopped')).toBe('skip');
    expect(rawSurfaceText(line)).toBeUndefined();
    expect(finalSurfaceText(line)).toBeUndefined();
  });

  it('001 FR-018 with answers 0 an empty raw answer goes to rows 7 and 8', () => {
    const discarded = okLine({ raw: '', answers: 0, finalKind: 'discarded' });
    expect(classifyTrial(discarded)).toBe('discarded');
    expect(rawSurfaceText(discarded)).toBeUndefined();
    const fallback = okLine({ raw: '', answers: 0, finalKind: 'fallback', final: '잠시만' });
    expect(classifyTrial(fallback)).toBe('fallback');
    expect(rawSurfaceText(fallback)).toBeUndefined();
  });

  it('001 FR-018 with answers 2 or more an empty first answer does not make row 6', () => {
    const regenerated = okLine({ raw: '', answers: 2, final: '안녕!' });
    expect(classifyTrial(regenerated)).toBe('complete');
    expect(rawSurfaceText(regenerated)).toBeUndefined();
    expect(finalSurfaceText(regenerated)).toBe('안녕!');
    expect(classifyTrial(okLine({ raw: ' ', answers: 3, final: '' }))).toBe('empty-final');
    const picked = okLine({ raw: '안녕 😀', answers: 2, final: '안녕' });
    expect(rawSurfaceText(picked)).toBe('안녕 😀');
    expect(finalSurfaceText(picked)).toBe('안녕');
  });

  it('001 FR-018 empty means only the 25 White_Space code points remain', () => {
    const whiteSpace = [
      ...['\u0009', '\u000A', '\u000B', '\u000C', '\u000D', ' ', '\u0085', ' '],
      ...[' ', ' ', ' ', ' ', ' ', ' ', ' ', ' '],
      ...[' ', ' ', ' ', ' ', ' ', ' ', ' ', ' '],
      '　',
    ];
    expect(whiteSpace).toHaveLength(25);
    expect(isEmptyText('')).toBe(true);
    expect(isEmptyText(whiteSpace.join(''))).toBe(true);
    for (const codePoint of whiteSpace) {
      expect(isEmptyText(codePoint)).toBe(true);
    }
    for (const text of ['​', '﻿', '᠎', ' a ', '.']) {
      expect(isEmptyText(text)).toBe(false);
    }
    expect(classifyTrial(okLine({ raw: '\u0085', final: '\u0085' }))).toBe('empty-raw');
    expect(classifyTrial(okLine({ raw: '﻿', final: '﻿' }))).toBe('complete');
  });

  it('001 FR-009 only transient and adapter errors can become systematic failures', () => {
    const outcomes: readonly TrialOutcome[] = [
      'stopped',
      'config',
      'adapter',
      'transient',
      'permanent',
      'timeout',
      'empty-raw',
      'discarded',
      'fallback',
      'empty-final',
      'cut',
      'complete',
    ];
    expect(outcomes.filter(mayBeSystematic)).toEqual(['adapter', 'transient']);
  });

  it('001 FR-009 the last attempt line of a key decides, as the contract fixture records it', () => {
    const text = readFileSync(
      new URL('../../fixtures/contracts/trials.jsonl', import.meta.url),
      'utf8',
    );
    const lines = text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => trialLineSchema.parse(JSON.parse(line)));
    const effective = effectiveAttempts(lines);
    expect(effective.map((line) => [line.caseId, line.repeat, line.attempt])).toEqual([
      ['greet-en', 0, 1],
      ['greet-en', 1, 1],
      ['greet-en', 2, 1],
      ['greet-ja', 0, 1],
      ['greet-ja', 1, 1],
      ['greet-ja', 2, 1],
      ['greet-ko', 0, 1],
      ['greet-ko', 1, 2],
      ['long-ko', 0, 1],
      ['long-ko', 1, 1],
      ['mood-vague-ko', 0, 1],
      ['mood-vague-ko', 1, 1],
    ]);
    expect(effective.map(classifyTrial)).toEqual([
      'empty-final',
      'cut',
      'stopped',
      'adapter',
      'permanent',
      'complete',
      'config',
      'complete',
      'discarded',
      'fallback',
      'timeout',
      'empty-raw',
    ]);
  });
});
