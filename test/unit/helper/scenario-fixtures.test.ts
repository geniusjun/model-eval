import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const HELPER_FIXTURES = fileURLToPath(new URL('../../fixtures/helper/', import.meta.url));
const SCENARIOS = path.join(HELPER_FIXTURES, 'scenarios');

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const schema = z
  .object({})
  .loose()
  .parse(readJson(path.join(HELPER_FIXTURES, 'scenario.schema.json')));

// strictRequired would reject `required` in the `oneOf` branches that pick a script entry's
// content, which the enclosing `properties` declare. Union types such as `["string", "null"]` are
// how the schema says a field may be absent from the result.
const ajv = new Ajv2020({
  strict: true,
  strictRequired: false,
  allowUnionTypes: true,
  allErrors: true,
});
const validate = ajv.compile(schema);

function errorsOf(fixture: unknown): string[] {
  return validate(fixture)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ''}`);
}

const fixtureFiles = readdirSync(SCENARIOS)
  .filter((name) => name.endsWith('.json'))
  .sort();

/** The parts of a fixture that name messages of messages.json. */
const messageRef = z.object({
  message: z.string(),
  placeholders: z.record(z.string(), z.string()).optional(),
});
const namingCases = z.record(
  z.string(),
  z.array(
    z.object({
      apis: z.array(z.string()).optional(),
      expect: z.object({
        adapterError: messageRef.optional(),
        warnings: z.array(messageRef).optional(),
        log: z.array(messageRef).optional(),
      }),
    }),
  ),
);
const messagesFile = z.object({
  messages: z.record(z.string(), z.object({ text: z.string(), placeholders: z.array(z.string()) })),
});

function readFixture(name: string): z.infer<typeof namingCases> {
  return namingCases.parse(readJson(path.join(SCENARIOS, name)));
}

/** A valid case to vary in the tests that check what the schema rejects. */
const CASE = {
  name: 'one answer',
  service: { behaviour: 'reply' },
  script: [{ reply: { text: 'Hi.' } }],
  expect: { status: 'ok', raw: 'Hi.' },
};

describe('scenario fixtures', () => {
  it('003 SC-002 has fixture files to check', () => {
    expect(fixtureFiles).toContain('example.json');
  });

  it.each(fixtureFiles)('003 SC-002 %s follows scenario.schema.json', (name) => {
    expect(errorsOf(readJson(path.join(SCENARIOS, name)))).toEqual([]);
  });

  it('003 SC-002 every message a fixture names is in messages.json with the placeholders it fills', () => {
    const { messages } = messagesFile.parse(readJson(path.join(HELPER_FIXTURES, 'messages.json')));
    const refs = fixtureFiles
      .flatMap((name) => Object.values(readFixture(name)).flat())
      .flatMap(({ expect: expected }) => [
        ...(expected.adapterError === undefined ? [] : [expected.adapterError]),
        ...(expected.warnings ?? []),
        ...(expected.log ?? []),
      ]);
    for (const ref of refs) {
      const known = messages[ref.message];
      expect(known, ref.message).toBeDefined();
      expect(Object.keys(ref.placeholders ?? {}).sort()).toEqual(
        [...(known?.placeholders ?? [])].sort(),
      );
    }
  });

  it('003 SC-002 the example fixture has a case for each API', () => {
    const apis = Object.values(readFixture('example.json'))
      .flat()
      .flatMap((scenarioCase) => scenarioCase.apis ?? []);
    expect(new Set(apis)).toEqual(new Set(['chat-completions', 'responses', 'messages']));
  });

  it('003 SC-002 accepts the script forms the mock server answers with', () => {
    const script = [
      { times: 3, error: { status: 429 }, headers: { 'retry-after-ms': '20' } },
      { connection: 'close-before-headers', delayMs: 100 },
      { connection: 'close-unread' },
      { match: { model: 'model-a', stream: true }, reply: { text: 'Hi.' }, drop: { chunks: 2 } },
      {
        reply: { text: 'Hi there.', finishReason: 'length', usage: null },
        stream: { deltas: 3, eventsPerChunk: 2, chunkDelaysMs: [0, 500], lastLine: 'none' },
        encoding: 'br',
        compressed: { br: 'aGk=', zstd: ['aA==', 'aQ=='] },
      },
      { reply: { failure: { type: 'overloaded_error' } }, stream: { ending: 'failure' } },
      { text: '{"a": 1e400}' },
      { status: 200, body: { id: 'x' } },
      {
        sse: {
          chunks: [
            { events: [{ comment: 'keep-alive' }, { event: 'error', data: { message: 'x' } }] },
            { text: 'data: [DONE]', delayMs: 10 },
          ],
          lastLine: 'line-end',
        },
      },
    ];
    expect(errorsOf({ 'S-CONN-01': [{ ...CASE, script }] })).toEqual([]);
  });

  it('003 SC-002 rejects a script entry with no content or with two', () => {
    const noContent = { ...CASE, script: [{ status: 200 }] };
    const twoContents = { ...CASE, script: [{ reply: { text: 'a' }, body: {} }] };
    const closedWithContent = {
      ...CASE,
      script: [{ connection: 'close-before-headers', reply: { text: 'a' } }],
    };
    expect(errorsOf({ 'S-RESP-01': [noContent] })).not.toEqual([]);
    expect(errorsOf({ 'S-RESP-01': [twoContents] })).not.toEqual([]);
    expect(errorsOf({ 'S-RESP-01': [closedWithContent] })).not.toEqual([]);
  });

  it('003 SC-002 rejects unknown fields, unknown scenario IDs and unknown expected fields', () => {
    expect(errorsOf({ 'S-RESP-01': [{ ...CASE, extra: true }] })).not.toEqual([]);
    expect(errorsOf({ 'RESP-1': [CASE] })).not.toEqual([]);
    expect(errorsOf({ 'S-RESP-01': [{ ...CASE, expect: { rawText: 'Hi.' } }] })).not.toEqual([]);
  });

  it('003 SC-002 rejects a message reference that is not a message ID', () => {
    const warning = { message: 'Warning one' };
    expect(errorsOf({ 'S-RESP-01': [{ ...CASE, expect: { warnings: [warning] } }] })).not.toEqual(
      [],
    );
  });
});
