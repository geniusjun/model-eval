import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { documents } from '../../scripts/generate-schemas.js';
import type { z } from 'zod';

import { comparisonSchema, pageDataSchema } from '../../src/report/schema.js';
import { manifestSchema } from '../../src/run/manifest.js';
import { trialLineSchema } from '../../src/run/records.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCHEMAS = path.join(ROOT, 'schemas');
const FIXTURES = path.join(ROOT, 'test/fixtures/contracts');

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function validator(schemaFile: string) {
  // strictRequired would reject `anyOf: [{required: [x]}]` beside the `properties` that declare x,
  // the standard way to say "one of these fields" (data-model §Check).
  const ajv = new Ajv2020({
    strict: true,
    strictRequired: false,
    allErrors: true,
    validateFormats: false,
  });
  return ajv.compile(readJson(path.join(SCHEMAS, schemaFile)) as object);
}

/** The schema each fixture follows; every file of the folder must be listed. */
const FIXTURE_SCHEMAS: Record<string, string | null> = {
  'manifest.json': 'manifest.schema.json',
  'trials.jsonl': 'trial.schema.json',
  'comparison-block.json': 'comparison.schema.json',
  'comparison-undecided-partial.json': 'comparison.schema.json',
  'comparison-no-gate.json': 'comparison.schema.json',
  'page-comparison-block.json': 'page-data.schema.json',
  'page-comparison-undecided-partial.json': 'page-data.schema.json',
  'page-comparison-no-gate.json': 'page-data.schema.json',
  'page-list.json': 'page-data.schema.json',
  'template.html': null,
};

/** The zod schemas the tool writes and reads with, which hold refinements JSON Schema cannot. */
const ZOD_SCHEMAS: Record<string, z.ZodType> = {
  'manifest.schema.json': manifestSchema,
  'trial.schema.json': trialLineSchema,
  'comparison.schema.json': comparisonSchema,
  'page-data.schema.json': pageDataSchema,
};

const OK_LINE = {
  caseId: 'greet-ko',
  repeat: 0,
  attempt: 1,
  segment: 1,
  seed: 235035669,
  costUsd: 0.0001,
  status: 'ok',
  raw: '안녕',
  answers: 1,
  finalKind: 'model',
  final: '안녕',
  latencyMs: 812,
  finishReason: 'stop',
};

describe('JSON Schemas', () => {
  it('001 FR-030 committed schemas/ equal the output of pnpm schemas', () => {
    const generated = documents();
    const committed = readdirSync(SCHEMAS)
      .filter((name) => name.endsWith('.json'))
      .sort();
    expect(committed).toEqual(Object.keys(generated).sort());
    for (const [name, schema] of Object.entries(generated)) {
      expect(readFileSync(path.join(SCHEMAS, name), 'utf8'), name).toBe(
        `${JSON.stringify(schema, null, 2)}\n`,
      );
    }
  });

  it('001 FR-030 every generated schema compiles under JSON Schema 2020-12', () => {
    for (const name of readdirSync(SCHEMAS)) {
      expect(() => validator(name), name).not.toThrow();
    }
  });
});

describe('contract fixtures', () => {
  it('001 FR-010 lists every fixture with its schema', () => {
    expect(readdirSync(FIXTURES).sort()).toEqual(Object.keys(FIXTURE_SCHEMAS).sort());
  });

  it('001 FR-010 every fixture validates against its schema', () => {
    for (const [fixture, schemaFile] of Object.entries(FIXTURE_SCHEMAS)) {
      if (schemaFile === null) {
        continue;
      }
      const validate = validator(schemaFile);
      const text = readFileSync(path.join(FIXTURES, fixture), 'utf8');
      const values: unknown[] = fixture.endsWith('.jsonl')
        ? text
            .trimEnd()
            .split('\n')
            .map((line) => JSON.parse(line) as unknown)
        : [JSON.parse(text)];
      for (const [index, value] of values.entries()) {
        const valid = validate(value);
        expect(valid, `${fixture} #${String(index)}: ${JSON.stringify(validate.errors)}`).toBe(
          true,
        );
        const parsed = ZOD_SCHEMAS[schemaFile]?.safeParse(value);
        expect(
          parsed?.success,
          `${fixture} #${String(index)}: ${JSON.stringify(parsed?.error?.issues)}`,
        ).toBe(true);
      }
    }
  });

  it('001 FR-010 trials.jsonl covers send, attempt and cost lines and every outcome row', () => {
    const lines = readFileSync(path.join(FIXTURES, 'trials.jsonl'), 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => trialLineSchema.parse(JSON.parse(line)));
    const kinds = new Set(
      lines.map((line) => {
        if ('sending' in line) {
          return 'send';
        }
        if ('costCorrection' in line) {
          return 'caseId' in line ? `cost-${line.source}` : 'cost-unkeyed';
        }
        if (line.status !== 'ok') {
          return line.status === 'error' ? `error-${line.error.kind}` : 'stopped';
        }
        if (line.raw.trim() === '' && line.answers === 1) {
          return 'empty-raw';
        }
        if (line.finalKind !== 'model') {
          return line.finalKind;
        }
        if (line.final === '') {
          return 'empty-final';
        }
        return line.finishReason === 'stop' ? 'normal' : 'cut';
      }),
    );
    expect(kinds).toEqual(
      new Set([
        'send',
        'cost-late',
        'cost-calls',
        'cost-unkeyed',
        'error-config',
        'error-adapter',
        'error-transient',
        'error-permanent',
        'error-timeout',
        'empty-raw',
        'discarded',
        'fallback',
        'empty-final',
        'cut',
        'normal',
        'stopped',
      ]),
    );
  });

  it('001 FR-031 comparison fixtures carry text that could break a page or a report', () => {
    for (const fixture of [
      'comparison-block.json',
      'comparison-undecided-partial.json',
      'comparison-no-gate.json',
    ]) {
      const text = readFileSync(path.join(FIXTURES, fixture), 'utf8');
      for (const marker of ['</script>', '<!--', '$&', '<img', '```']) {
        expect(text, `${fixture} ${marker}`).toContain(marker);
      }
    }
  });

  it('001 FR-024 comparison fixtures show every kind of needed on gated cells', () => {
    for (const kind of ['block', 'undecided-partial']) {
      const comparison = comparisonSchema.parse(
        readJson(path.join(FIXTURES, `comparison-${kind}.json`)),
      );
      const kinds = new Set(
        comparison.cells.flatMap((cell) =>
          cell.gated && cell.needed !== undefined ? [cell.needed.kind] : [],
        ),
      );
      expect(kinds, kind).toEqual(new Set(['repeats', 'cases', 'on-margin']));
    }
  });

  it('001 FR-031 the template has the data block placeholder exactly once', () => {
    const template = readFileSync(path.join(FIXTURES, 'template.html'), 'utf8');
    expect(template.split('__MODEL_EVAL_DATA__')).toHaveLength(2);
    expect(template).toContain(
      '<script type="application/json" id="model-eval-data">__MODEL_EVAL_DATA__</script>',
    );
  });
});

describe('comparison and command results', () => {
  it('001 FR-025 each comparison page payload is its comparison fixture, gate included, and nothing else', () => {
    for (const kind of ['block', 'undecided-partial', 'no-gate']) {
      const comparison = comparisonSchema.parse(
        readJson(path.join(FIXTURES, `comparison-${kind}.json`)),
      );
      const page = readJson(path.join(FIXTURES, `page-comparison-${kind}.json`));
      expect(Object.keys(page as object).sort(), kind).toEqual([
        'comparison',
        'kind',
        'lang',
        'schemaVersion',
      ]);
      expect(page, kind).toMatchObject({ kind: 'comparison', comparison });
      expect(comparison.gate.outcome, kind).toBe(
        { block: 'block', 'undecided-partial': 'undecided', 'no-gate': 'no-gate' }[kind],
      );
    }
  });

  it('001 FR-030 run and swap --dry-run envelopes validate against their schemas', () => {
    const plan = {
      variants: [
        {
          variant: 'current',
          trials: 450,
          calls: 450,
          inputTokens: 1_854_000,
          outputTokens: 270_000,
          basis: { ko: 'structure', ja: 'history' },
          reservationUsd: 0.0016,
        },
      ],
      expectedUsd: 0.26,
      conservativeUsd: 0.85,
      maxCostUsd: 1,
      cells: [{ ruleId: 'script-ja', lang: 'ja', surface: 'raw', plannedTrials: 150, nMin: 35 }],
    };
    for (const command of ['run', 'swap']) {
      const envelope = {
        schemaVersion: '1',
        command,
        exit: { code: 0, name: 'ok' },
        result: { plan },
        warnings: [
          {
            code: 'conservative-over-budget',
            params: { conservativeUsd: 1.2, maxCostUsd: 1 },
          },
        ],
      };
      const validate = validator(`${command}.schema.json`);
      expect(validate(envelope), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({ ...envelope, result: { plan: { ...plan, cells: [{}] } } })).toBe(false);
    }
  });
});

describe('cli.md examples', () => {
  it('001 FR-030 the --json example of contracts/cli.md validates against its command schema', () => {
    const cli = readFileSync(path.join(ROOT, 'specs/001-swap-check/contracts/cli.md'), 'utf8');
    const examples = [...cli.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
      (match) => JSON.parse(match[1] ?? '') as unknown,
    );
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      const { command } = example as { command: string };
      const validate = validator(`${command}.schema.json`);
      expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
  });
});

describe('trial schema', () => {
  it('001 FR-010 accepts a complete ok attempt line', () => {
    expect(trialLineSchema.safeParse(OK_LINE).success).toBe(true);
    expect(validator('trial.schema.json')(OK_LINE)).toBe(true);
  });

  it('001 FR-010 rejects an ok attempt line without raw or finalKind (constitution I)', () => {
    const validate = validator('trial.schema.json');
    for (const field of ['raw', 'finalKind'] as const) {
      const { [field]: _removed, ...line } = OK_LINE;
      expect(trialLineSchema.safeParse(line).success, field).toBe(false);
      expect(validate(line), field).toBe(false);
    }
  });

  it('001 FR-010 keeps discardReason to discarded lines and answers 0 off model lines', () => {
    const validate = validator('trial.schema.json');
    expect(validate({ ...OK_LINE, discardReason: 'x' })).toBe(false);
    expect(validate({ ...OK_LINE, answers: 0 })).toBe(false);
    expect(trialLineSchema.safeParse({ ...OK_LINE, answers: 0 }).success).toBe(false);
    const { final: _final, ...discarded } = OK_LINE;
    expect(validate({ ...discarded, finalKind: 'discarded', discardReason: 'x', answers: 0 })).toBe(
      true,
    );
  });

  it('001 FR-010 rejects a cost line that has only part of a trial key', () => {
    const unkeyed = {
      segment: 1,
      source: 'calls',
      costUsd: 0,
      calls: [{ model: 'm', outcome: 'ok' }],
      costCorrection: true,
    };
    expect(trialLineSchema.safeParse(unkeyed).success).toBe(true);
    expect(trialLineSchema.safeParse({ ...unkeyed, caseId: 'greet-ko' }).success).toBe(false);
    expect(validator('trial.schema.json')({ ...unkeyed, caseId: 'greet-ko' })).toBe(false);
  });

  it('001 FR-010 requires final unless the answer was discarded', () => {
    const { final: _final, ...withoutFinal } = OK_LINE;
    expect(trialLineSchema.safeParse(withoutFinal).success).toBe(false);
    expect(trialLineSchema.safeParse({ ...withoutFinal, finalKind: 'discarded' }).success).toBe(
      true,
    );
  });
});

describe('report schema module', () => {
  it('001 FR-030 src/report/schema.ts imports no node: module, directly or through its imports', () => {
    const seen = new Set<string>();
    const nodeImports: string[] = [];
    const visit = (file: string): void => {
      if (seen.has(file)) {
        return;
      }
      seen.add(file);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:import|export)[^'"]*from\s+'([^']+)'/g)) {
        const specifier = match[1] ?? '';
        if (specifier.startsWith('node:')) {
          nodeImports.push(`${path.relative(ROOT, file)} -> ${specifier}`);
        } else if (specifier.startsWith('.')) {
          visit(path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts')));
        }
      }
    };
    visit(path.join(ROOT, 'src/report/schema.ts'));
    expect(seen.size).toBeGreaterThan(1);
    expect(nodeImports).toEqual([]);
  });
});
