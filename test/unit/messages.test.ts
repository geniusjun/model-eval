import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { lintCodeSchema, lintFindingSchema } from '../../src/config/diagnostics.js';
import { CATALOGS, type MessageKey } from '../../src/messages/index.js';
import { gateReasonCodeSchema, gateReasonSchema, neededSchema } from '../../src/report/schema.js';
import { warningCodeSchema, warningSchema } from '../../src/run/warning.js';

interface CodeParams {
  readonly code: string;
  readonly keys: readonly string[];
}

/**
 * The code of each union member and the keys its text reads: those of its `params` object, or
 * with `fields`, the member's own fields other than the discriminator.
 */
function codeParams(
  options: readonly z.core.$ZodType[],
  discriminator: string,
  from: 'params' | 'fields' = 'params',
): CodeParams[] {
  return options.map((option) => {
    if (!(option instanceof z.ZodObject)) {
      throw new TypeError('expected an object member');
    }
    const shape: Readonly<Record<string, z.core.$ZodType | undefined>> = option.shape;
    const code = shape[discriminator];
    if (!(code instanceof z.ZodLiteral) || typeof code.value !== 'string') {
      throw new TypeError(`expected a string literal ${discriminator}`);
    }
    if (from === 'fields') {
      return { code: code.value, keys: Object.keys(shape).filter((key) => key !== discriminator) };
    }
    const params = shape.params;
    return {
      code: code.value,
      keys: params instanceof z.ZodObject ? Object.keys(params.shape) : [],
    };
  });
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
}

function isMessageKey(key: string): key is MessageKey {
  return Object.hasOwn(CATALOGS.en, key);
}

function templates(key: string): string[] {
  if (!isMessageKey(key)) {
    throw new Error(`no message ${key}`);
  }
  return [CATALOGS.en[key], CATALOGS.ko[key]];
}

const FAMILIES = [
  {
    prefix: 'warning',
    codes: warningCodeSchema.options,
    union: codeParams(warningSchema.options, 'code'),
  },
  {
    prefix: 'reason',
    codes: gateReasonCodeSchema.options,
    union: codeParams(gateReasonSchema.options, 'code'),
  },
  {
    prefix: 'lint',
    codes: lintCodeSchema.options,
    union: codeParams(lintFindingSchema.options, 'code'),
  },
];

describe('message files', () => {
  it('001 FR-034 types params for every warning, gate reason and lint code', () => {
    for (const { prefix, codes, union } of FAMILIES) {
      expect(union.map((member) => member.code).sort(), prefix).toEqual([...codes].sort());
    }
  });

  it('001 FR-034 has en and ko text for every code that names exactly its params keys', () => {
    for (const { prefix, union } of FAMILIES) {
      for (const { code, keys } of union) {
        for (const template of templates(`${prefix}.${code}`)) {
          expect(placeholders(template), `${prefix}.${code}`).toEqual([...keys].sort());
        }
      }
    }
  });

  it('001 FR-034 leaves the path out of the text of a schema finding about a whole file', () => {
    for (const template of templates('lint.schema-file')) {
      expect(placeholders(template)).toEqual(['detail']);
    }
  });

  it('001 FR-024 has text for every kind of needed', () => {
    const extra: Readonly<Record<string, readonly string[]>> = { repeats: ['currentTrials'] };
    for (const { code, keys } of codeParams(neededSchema.options, 'kind', 'fields')) {
      const expected = [...keys.filter((key) => key !== 'nearMargin'), ...(extra[code] ?? [])];
      for (const template of templates(`needed.${code}`)) {
        expect(placeholders(template), code).toEqual(expected.sort());
      }
    }
    for (const template of templates('needed.nearMargin')) {
      expect(placeholders(template)).toEqual([]);
    }
  });
});
