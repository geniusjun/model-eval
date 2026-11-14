import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  discardReason,
  exceptionText,
  message,
  type MessageId,
  modelList,
} from '../../../src/helper/messages.js';

const MESSAGES = fileURLToPath(new URL('../../fixtures/helper/messages.json', import.meta.url));

const messages = z
  .object({ messages: z.record(z.string(), z.object({ text: z.string() })) })
  .parse(JSON.parse(readFileSync(MESSAGES, 'utf8'))).messages;

describe('helper messages', () => {
  it.each(Object.entries(messages))(
    '003 FR-020 %s is the sentence of messages.json',
    (id, entry) => {
      expect(message(id as MessageId)).toBe(entry.text);
    },
  );

  it('003 FR-020 a period after a placeholder whose value ends a sentence is left out', () => {
    expect(message('L1', { reason: 'git rev-parse: fatal.' })).toBe(
      'Service version not reported: git rev-parse: fatal.',
    );
    expect(message('L1', { reason: 'lstat .: ENOENT' })).toBe(
      'Service version not reported: lstat .: ENOENT.',
    );
  });

  it('003 FR-020 <exception> and <models>', () => {
    class EmptyReply extends Error {}
    expect(exceptionText(new EmptyReply('　 no text \n'))).toBe('EmptyReply: no text');
    expect(exceptionText(new EmptyReply(''))).toBe('EmptyReply');
    expect(exceptionText(' plain ')).toBe('plain');
    expect(modelList(['b', 'a', 'b'])).toBe('`b`, `a`');
    expect(modelList([])).toBe('none');
  });

  it('003 FR-020 placeholder values are inserted as written, `$` patterns included', () => {
    const exception = "Error: a $' b $` c $& d $$ e $1";
    expect(message('A17', { exception })).toBe(`The render function raised ${exception}.`);
    expect(message('L2', { exception: 'Error: $&.' })).toBe(
      'Unhandled exception in background work: Error: $&.',
    );
  });

  it('003 FR-020 <exception> of a value whose String() throws', () => {
    expect(exceptionText(Object.create(null))).toBe('[object Object]');
    const loud = {
      toString(): string {
        throw new Error('no text');
      },
    };
    expect(exceptionText(loud)).toBe('[object Object]');
  });

  it('003 FR-024 discard reasons are cut to 200 code points', () => {
    const reason = discardReason(new Error('\u{1F600}'.repeat(300)));
    expect(Array.from(reason)).toHaveLength(200);
    expect(reason.startsWith('Error: \u{1F600}')).toBe(true);
  });
});
