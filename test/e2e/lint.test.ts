import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { BUNDLED_HELPER_VERSION } from '../../src/lint/helper-version.js';
import { message } from '../../src/messages/index.js';
import { E2E, lintJson, useProjects } from './support/commands.js';
import { greetCases, type CaseInput, type RuleInput } from './support/project.js';
import { ANSWERED, NO_EMOJI, SCRIPT_JA, SCRIPT_JA_QUOTE } from './support/rules.js';

// User Story 2: `model-eval lint` against the mock adapter (contracts/cli.md §`lint` Options,
// data-model §Validation Rules). Scenario lint-render drops anchored sentences from some prompts.

const run = promisify(execFile);
const project = useProjects();

const SCENARIO = 'lint-render';
const RULES_FILE = 'rules/rules.yaml';
const CASES_FILE = 'cases/cases.yaml';

const BANMAL_QUOTE = '반말로 짧게 답한다';

/** Where the anchor of SCRIPT_JA lands when the rules file holds that rule alone. */
const SCRIPT_JA_ANCHOR = { line: 18, column: 9 };

/** Anchored in Korean; the Korean prompt of `next` lacks the sentence. */
const BANMAL: RuleInput = {
  id: 'banmal-ko',
  title: 'Korean answers use the casual speech level',
  severity: 'major',
  scope: 'global',
  languages: ['ko'],
  check: { type: 'pattern', regex: '(요|습니다)[.?!]*$', flags: 'm', mode: 'forbid' },
  anchors: [{ lang: 'ko', quote: BANMAL_QUOTE }],
};

/** The same sentence anchored in both languages; only the Korean prompts contain it. */
const NO_EMOJI_ANCHORED: RuleInput = {
  ...NO_EMOJI,
  anchors: [
    { lang: 'ko', quote: 'Never use emoji' },
    { lang: 'ja', quote: 'Never use emoji' },
  ],
};

const KO_JA = greetCases({ ko: 2, ja: 3 });
const JA_IDS = ['greet-ja-1', 'greet-ja-2', 'greet-ja-3'];
const KO_IDS = ['greet-ko-1', 'greet-ko-2'];

function caseWith(fields: Partial<CaseInput>): CaseInput {
  return {
    id: 'greet-ko-1',
    target: 'chat',
    lang: 'ko',
    provenance: 'synthetic',
    input: { user: 'hello' },
    ...fields,
  };
}

describe('001 lint', () => {
  it(
    '001 FR-004 acceptance 1: a sentence missing from the Japanese prompt is one anchor-missing warning with exit 0',
    async () => {
      const ledger = await project({ scenario: SCENARIO, rules: [SCRIPT_JA], cases: KO_JA });
      const { cli, envelope } = await lintJson(ledger, ['--render']);
      expect(cli.code).toBe(0);
      expect(envelope.exit).toEqual({ code: 0, name: 'ok' });
      expect(envelope.result).toEqual({ errors: [], info: [] });
      expect(envelope.warnings).toEqual([
        {
          code: 'anchor-missing',
          ruleId: 'script-ja',
          lang: 'ja',
          params: { quote: SCRIPT_JA_QUOTE },
          variants: ['current', 'next'],
          caseIds: JA_IDS,
          file: RULES_FILE,
          line: SCRIPT_JA_ANCHOR.line,
          column: SCRIPT_JA_ANCHOR.column,
        },
      ]);
    },
    E2E.timeout,
  );

  it(
    '001 FR-004 acceptance 2: the same warning with --max-warnings 0 exits 1',
    async () => {
      const ledger = await project({ scenario: SCENARIO, rules: [SCRIPT_JA], cases: KO_JA });
      const { cli, envelope } = await lintJson(ledger, ['--render', '--max-warnings', '0']);
      expect(cli.code).toBe(1);
      expect(envelope.exit).toEqual({ code: 1, name: 'failed' });
      expect(envelope.warnings.map((warning) => warning.code)).toEqual(['anchor-missing']);
    },
    E2E.timeout,
  );

  it(
    '001 FR-004 anchors are checked per variant and language, whitespace normalised, and --variant renders one variant',
    async () => {
      const ledger = await project({
        scenario: SCENARIO,
        rules: [BANMAL, NO_EMOJI_ANCHORED],
        cases: KO_JA,
      });
      const { cli, envelope } = await lintJson(ledger, ['--render']);
      expect(cli.code).toBe(0);
      expect(
        envelope.warnings.map(({ code, ruleId, lang, variants, caseIds }) => ({
          code,
          ruleId,
          lang,
          variants,
          caseIds,
        })),
      ).toEqual([
        {
          code: 'anchor-missing',
          ruleId: 'banmal-ko',
          lang: 'ko',
          variants: ['next'],
          caseIds: KO_IDS,
        },
        {
          code: 'anchor-missing',
          ruleId: 'no-emoji',
          lang: 'ja',
          variants: ['current', 'next'],
          caseIds: JA_IDS,
        },
      ]);

      const before = (await ledger.sessions()).length;
      const one = await lintJson(ledger, ['--render', '--variant', 'current']);
      expect(one.envelope.warnings.map(({ ruleId, variants }) => ({ ruleId, variants }))).toEqual([
        { ruleId: 'no-emoji', variants: ['current'] },
      ]);
      const sessions = (await ledger.sessions()).slice(before);
      expect(sessions.map((session) => session.variant)).toEqual(['current']);
    },
    E2E.timeout,
  );

  it(
    '001 FR-001 acceptance 3: a case naming a rule that does not exist is unknown-rule with file and position, exit 1',
    async () => {
      const ledger = await project({
        scenario: SCENARIO,
        rules: [NO_EMOJI],
        cases: [caseWith({ rules: ['no-such'] })],
      });
      const { cli, envelope } = await lintJson(ledger);
      expect(cli.code).toBe(1);
      expect(envelope.exit).toEqual({ code: 1, name: 'failed' });
      expect(envelope.result?.errors).toEqual([
        {
          code: 'unknown-rule',
          ruleId: 'no-such',
          caseIds: ['greet-ko-1'],
          file: CASES_FILE,
          line: 9,
          column: 9,
        },
      ]);
    },
    E2E.timeout,
  );

  it(
    '001 FR-003 acceptance 4: a derived case in a version-controlled path is derived-tracked, exit 1',
    async () => {
      const ledger = await project({
        scenario: SCENARIO,
        rules: [NO_EMOJI],
        cases: [caseWith({ provenance: 'derived' })],
      });
      await run('git', ['-C', ledger.root, 'init', '-q']);
      await run('git', ['-C', ledger.root, 'add', CASES_FILE]);
      const { cli, envelope } = await lintJson(ledger);
      expect(cli.code).toBe(1);
      expect(envelope.result?.errors).toEqual([
        {
          code: 'derived-tracked',
          params: { cause: 'tracked' },
          caseIds: ['greet-ko-1'],
          file: CASES_FILE,
          line: 2,
          column: 5,
        },
      ]);
    },
    E2E.timeout,
  );

  it(
    '001 FR-004 acceptance 5: a retired rule is not anchor-checked and its examples are not run',
    async () => {
      const retired: RuleInput = {
        ...SCRIPT_JA,
        status: 'retired',
        examples: { pass: ['ハングル 한글'], fail: [] },
      };
      const ledger = await project({ scenario: SCENARIO, rules: [retired], cases: KO_JA });
      const { cli, envelope } = await lintJson(ledger, ['--render', '--max-warnings', '0']);
      expect(cli.code).toBe(0);
      expect(envelope.result).toEqual({ errors: [], info: [] });
      expect(envelope.warnings).toEqual([]);
    },
    E2E.timeout,
  );

  it(
    '001 FR-005 acceptance 6: a pass example that fails its own check is example-mismatch, exit 1',
    async () => {
      const ledger = await project({
        scenario: SCENARIO,
        rules: [{ ...NO_EMOJI, examples: { pass: ['great 🙂'], fail: ['🙂'] } }],
        cases: KO_JA,
      });
      const { cli, envelope } = await lintJson(ledger);
      expect(cli.code).toBe(1);
      expect(envelope.result?.errors).toMatchObject([
        { code: 'example-mismatch', ruleId: 'no-emoji', params: { example: 'great 🙂' } },
      ]);
    },
    E2E.timeout,
  );

  it(
    '001 FR-004 unanchored is info under result.info and does not count against --max-warnings',
    async () => {
      const ledger = await project({ scenario: SCENARIO, rules: [NO_EMOJI], cases: KO_JA });
      const { cli, envelope } = await lintJson(ledger, ['--max-warnings', '0']);
      expect(cli.code).toBe(0);
      expect(envelope.warnings).toEqual([]);
      expect(
        envelope.result?.info.map(({ code, ruleId, lang }) => ({ code, ruleId, lang })),
      ).toEqual([
        { code: 'unanchored', ruleId: 'no-emoji', lang: 'ja' },
        { code: 'unanchored', ruleId: 'no-emoji', lang: 'ko' },
      ]);
    },
    E2E.timeout,
  );

  it(
    '001 FR-006 few-cases and margin-unreachable for a gated cell planned too small',
    async () => {
      const ledger = await project({
        scenario: SCENARIO,
        rules: [ANSWERED],
        cases: greetCases({ ko: 3 }),
        config: { gate: { severities: ['blocking'] } },
      });
      const { cli, envelope } = await lintJson(ledger);
      expect(cli.code).toBe(0);
      expect(envelope.warnings).toMatchObject([
        {
          code: 'few-cases',
          ruleId: 'answered',
          lang: 'ko',
          params: { surface: 'trial', cases: 3 },
        },
        {
          code: 'margin-unreachable',
          ruleId: 'answered',
          lang: 'ko',
          params: { surface: 'trial', plannedTrials: 6, nMin: 35, margin: 0.1 },
        },
      ]);
    },
    E2E.timeout,
  );

  it(
    '001 FR-002 --no-adapter starts no adapter and skips input-schema, target and anchor checks',
    async () => {
      const ledger = await project({
        scenario: SCENARIO,
        rules: [SCRIPT_JA],
        cases: [
          ...KO_JA,
          caseWith({ id: 'nameless-ko', input: { name: 'x' } }),
          caseWith({ id: 'diary-ko', target: 'diary' }),
        ],
      });
      const skipped = await lintJson(ledger, ['--no-adapter']);
      expect(skipped.cli.code).toBe(0);
      expect(skipped.envelope.result?.errors).toEqual([]);
      expect(skipped.envelope.warnings).toEqual([]);
      expect(await ledger.sessions()).toEqual([]);

      const checked = await lintJson(ledger);
      expect(checked.cli.code).toBe(1);
      expect(checked.envelope.result?.errors).toMatchObject([
        { code: 'input-schema', caseIds: ['nameless-ko'], params: { target: 'chat' } },
        { code: 'unknown-target', caseIds: ['diary-ko'], params: { target: 'diary' } },
      ]);
    },
    E2E.timeout,
  );

  it(
    '001 FR-030 --render with --no-adapter is a usage error with exit 4, before any adapter starts',
    async () => {
      const ledger = await project({ scenario: SCENARIO, rules: [SCRIPT_JA], cases: KO_JA });
      const { cli, envelope } = await lintJson(ledger, ['--render', '--no-adapter']);
      expect(cli.code).toBe(4);
      expect(envelope.exit).toEqual({ code: 4, name: 'config-error' });
      expect(envelope.result).toBeNull();
      expect(cli.stderr).toContain('--no-adapter');
      expect(await ledger.sessions()).toEqual([]);
    },
    E2E.timeout,
  );

  it(
    '001 FR-004 under --render, an adapter without the render capability is adapter-failed with exit 4',
    async () => {
      const ledger = await project({
        scenario: 'lint-no-render',
        rules: [SCRIPT_JA],
        cases: KO_JA,
      });
      const plain = await lintJson(ledger);
      expect(plain.cli.code).toBe(0);
      const { cli, envelope } = await lintJson(ledger, ['--render']);
      expect(cli.code).toBe(4);
      expect(envelope.result?.errors).toMatchObject([
        { code: 'adapter-failed', variants: ['current'] },
      ]);
      const sessions = await ledger.sessions();
      expect(sessions.map((session) => session.variant)).toEqual(['current', 'current']);
    },
    E2E.timeout,
  );

  it(
    '001 FR-004 an adapter that cannot start is adapter-failed with exit 4; checks without it still run',
    async () => {
      const ledger = await project({
        scenario: 'lint-protocol-2',
        rules: [NO_EMOJI],
        cases: [caseWith({ rules: ['no-such'] })],
      });
      const { cli, envelope } = await lintJson(ledger, ['--render']);
      expect(cli.code).toBe(4);
      expect(envelope.exit).toEqual({ code: 4, name: 'config-error' });
      expect(envelope.result?.errors.map((finding) => finding.code)).toEqual([
        'unknown-rule',
        'adapter-failed',
      ]);
      const failed = envelope.result?.errors.find((finding) => finding.code === 'adapter-failed');
      expect(failed).toMatchObject({ variants: ['current'], file: 'model-eval.config.yaml' });
      expect(failed?.code === 'adapter-failed' ? failed.params.detail : '').toContain('protocol 2');
    },
    E2E.timeout,
  );

  it(
    '001 FR-004 render-failed carries the adapter message, the case and the variants it failed in',
    async () => {
      const ledger = await project({
        scenario: SCENARIO,
        rules: [NO_EMOJI],
        cases: [...KO_JA, caseWith({ id: 'broken-ko' })],
      });
      const { cli, envelope } = await lintJson(ledger, ['--render']);
      expect(cli.code).toBe(1);
      expect(envelope.result?.errors).toMatchObject([
        {
          code: 'render-failed',
          params: { detail: 'mock render failed for broken-ko' },
          caseIds: ['broken-ko'],
          variants: ['current', 'next'],
          file: CASES_FILE,
        },
      ]);
    },
    E2E.timeout,
  );

  it(
    '001 FR-031 anchor quotes pass through the config redact rules in --json and human output',
    async () => {
      const ledger = await project({
        scenario: SCENARIO,
        rules: [SCRIPT_JA],
        cases: KO_JA,
        config: { redact: [{ pattern: '日本語', replace: '<lang>' }] },
      });
      const { envelope } = await lintJson(ledger, ['--render']);
      expect(envelope.warnings).toMatchObject([
        { code: 'anchor-missing', params: { quote: '<lang>だけで話す' } },
      ]);
      const human = await ledger.run(['lint', '--render']);
      expect(human.stdout).toContain('"<lang>だけで話す"');
      expect(human.stdout).not.toContain('日本語');
    },
    E2E.timeout,
  );

  it(
    '001 FR-034 human output lists findings by level with file and position, then the counts',
    async () => {
      const ledger = await project({
        scenario: SCENARIO,
        rules: [SCRIPT_JA],
        cases: [...KO_JA, caseWith({ id: 'odd-ko', rules: ['no-such'] })],
      });
      const cli = await ledger.run(['lint', '--render']);
      expect(cli.code).toBe(1);
      const lines = cli.stdout.trimEnd().split('\n');
      expect(lines).toEqual([
        `error: ${CASES_FILE}:39:9: no-such: The case names a rule that does not exist. (cases: odd-ko)`,
        `warning: ${RULES_FILE}:${String(SCRIPT_JA_ANCHOR.line)}:${String(SCRIPT_JA_ANCHOR.column)}: script-ja (ja): The rendered prompt does not contain "${SCRIPT_JA_QUOTE}". (variants: current, next · cases: greet-ja-1, greet-ja-2, greet-ja-3)`,
        'errors 1 · warnings 1 · info 0',
      ]);

      const korean = await ledger.run(['lint', '--render', '--lang', 'ko', '--max-warnings', '0']);
      expect(korean.stdout).toContain('케이스가 없는 규칙을 가리킵니다.');
      expect(korean.stdout).toContain('--max-warnings 0');
    },
    E2E.timeout,
  );

  it(
    '001 FR-002 without targets a case without lang gets no language guess: no rule-filter-mismatch or language-gap',
    async () => {
      const formal: RuleInput = {
        id: 'formal-ja',
        title: 'Japanese answers are polite',
        severity: 'major',
        languages: ['ja'],
        check: { type: 'emoji' },
      };
      const ledger = await project({
        scenario: 'lint-ja-only',
        rules: [formal],
        cases: [
          {
            id: 'greet',
            target: 'chat',
            provenance: 'synthetic',
            input: { user: 'hi' },
            rules: ['formal-ja'],
          },
        ],
      });
      for (const extra of [['--no-adapter'], []]) {
        const { cli, envelope } = await lintJson(ledger, extra);
        expect(cli.code, extra.join(' ')).toBe(0);
        expect(envelope.warnings, extra.join(' ')).toEqual([]);
      }
    },
    E2E.timeout,
  );

  it(
    '001 FR-004 lint renders a case exactly as run sends it, explicit lang "*" included',
    async () => {
      const ledger = await project({
        scenario: SCENARIO,
        rules: [NO_EMOJI],
        cases: [...KO_JA, caseWith({ id: 'star', lang: '*' })],
      });
      expect((await ledger.run(['lint', '--render', '--variant', 'current'])).code).toBe(0);
      expect((await ledger.run(['run', '--variant', 'current', '--dry-run'])).code).toBe(0);
      const renders = (await ledger.sessions()).map((session) =>
        session.requests.filter((request) => request.method === 'render'),
      );
      expect(renders).toHaveLength(2);
      // One session is lint's and the other run's, in either order.
      const [first, second] = renders;
      expect(first).toHaveLength(KO_JA.length + 1);
      expect(first?.map((request) => request.params)).toEqual(
        second?.map((request) => request.params),
      );
      expect(first?.map((request) => request.params)).toContainEqual(
        expect.objectContaining({ caseId: 'star', lang: '*' }),
      );
    },
    E2E.timeout,
  );

  it(
    '001 FR-004 every adapter lint starts is shut down',
    async () => {
      const ledger = await project({ scenario: SCENARIO, rules: [SCRIPT_JA], cases: KO_JA });
      await lintJson(ledger, ['--render']);
      await lintJson(ledger);
      const sessions = await ledger.sessions();
      expect(sessions.map((session) => session.variant).sort()).toEqual([
        'current',
        'current',
        'next',
      ]);
      for (const session of sessions) {
        expect(session.requests.at(-1)?.method).toBe('shutdown');
      }
    },
    E2E.timeout,
  );

  it(
    '001 FR-004 a render that breaks the protocol or ends the adapter is adapter-failed with exit 4',
    async () => {
      for (const [id, detail] of [
        ['invalid-ko', 'result is invalid'],
        ['exits-ko', 'the adapter exited'],
      ] as const) {
        const ledger = await project({
          scenario: SCENARIO,
          rules: [NO_EMOJI],
          cases: [caseWith({ id })],
        });
        const { cli, envelope } = await lintJson(ledger, ['--render', '--variant', 'current']);
        expect(cli.code, id).toBe(4);
        const failed = envelope.result?.errors.find((finding) => finding.code === 'adapter-failed');
        expect(failed?.code === 'adapter-failed' ? failed.params.detail : '', id).toContain(detail);
      }
    },
    E2E.timeout,
  );

  it(
    '001 FR-004 under --render, an adapter that does not answer shutdown is adapter-failed',
    async () => {
      const ledger = await project({
        scenario: 'lint-shutdown-ignored',
        rules: [NO_EMOJI],
        cases: KO_JA,
        adapterTimeoutMs: 500,
      });
      const { cli, envelope } = await lintJson(ledger, ['--render', '--variant', 'current']);
      expect(cli.code).toBe(4);
      expect(envelope.result?.errors).toMatchObject([
        { code: 'adapter-failed', variants: ['current'] },
      ]);
    },
    E2E.timeout,
  );

  it(
    '001 FR-004 under --render, an adapter that exits without answering shutdown, or answers it with an error, is adapter-failed',
    async () => {
      for (const [scenario, cases] of [
        ['lint-shutdown-exit', KO_JA],
        ['lint-shutdown-error', KO_JA],
        ['lint-render-then-exit', [caseWith({ id: 'last-ko' })]],
      ] as const) {
        const ledger = await project({ scenario, rules: [NO_EMOJI], cases: [...cases] });
        const { cli, envelope } = await lintJson(ledger, ['--render', '--variant', 'current']);
        expect(cli.code, scenario).toBe(4);
        expect(envelope.result?.errors, scenario).toMatchObject([
          { code: 'adapter-failed', variants: ['current'] },
        ]);
      }
    },
    E2E.timeout,
  );

  it(
    '001 FR-004 stdout contamination after the last answer is adapter-failed',
    async () => {
      const ledger = await project({
        scenario: 'lint-shutdown-stray',
        rules: [NO_EMOJI],
        cases: KO_JA,
      });
      for (const extra of [[], ['--render']]) {
        const { cli, envelope } = await lintJson(ledger, extra);
        expect(cli.code, extra.join(' ')).toBe(4);
        const failed = envelope.result?.errors.find((finding) => finding.code === 'adapter-failed');
        expect(failed?.code === 'adapter-failed' ? failed.params.detail : '').toContain(
          'stdout is reserved for the protocol',
        );
      }
    },
    E2E.timeout,
  );

  it(
    '001 FR-004 a render without a response within adapter.timeoutMs is a configuration error in lint and run',
    async () => {
      const ledger = await project({
        scenario: 'lint-render-slow',
        rules: [NO_EMOJI],
        cases: greetCases({ ko: 1 }),
        adapterTimeoutMs: 1000,
      });
      const linted = await lintJson(ledger, ['--render', '--variant', 'current']);
      expect(linted.cli.code).toBe(4);
      const failed = linted.envelope.result?.errors.find(
        (finding) => finding.code === 'adapter-failed',
      );
      expect(failed?.code === 'adapter-failed' ? failed.params.detail : '').toBe(
        'no response to render within 1000 ms',
      );
      const ran = await ledger.run(['run', '--variant', 'current', '--dry-run']);
      expect(ran.code).toBe(4);
      expect(ran.stderr).toContain('no response to render within 1000 ms');
    },
    E2E.timeout,
  );

  it(
    '001 FR-035 reports helper-outdated for an older helper in initialize, once per version, and skips it with --no-adapter',
    async () => {
      const ledger = await project({
        scenario: 'lint-helper-old',
        rules: [NO_EMOJI],
        cases: KO_JA,
      });
      const outdated = (variants: readonly string[]) => ({
        code: 'helper-outdated',
        params: { version: '0.0.9', bundled: BUNDLED_HELPER_VERSION },
        variants,
        file: 'model-eval.config.yaml',
      });
      const helperWarnings = (warnings: readonly { readonly code: string }[]) =>
        warnings.filter((warning) => warning.code === 'helper-outdated');

      const first = await lintJson(ledger);
      expect(first.cli.code).toBe(0);
      expect(helperWarnings(first.envelope.warnings)).toMatchObject([outdated(['current'])]);

      const rendered = await lintJson(ledger, ['--render']);
      expect(helperWarnings(rendered.envelope.warnings)).toMatchObject([
        outdated(['current', 'next']),
      ]);

      const offline = await lintJson(ledger, ['--no-adapter']);
      expect(helperWarnings(offline.envelope.warnings)).toEqual([]);

      const human = await ledger.run(['lint']);
      expect(human.stdout).toContain(
        message('en', 'lint.helper-outdated', {
          version: '0.0.9',
          bundled: BUNDLED_HELPER_VERSION,
        }),
      );
    },
    E2E.timeout,
  );

  it(
    '001 FR-030 usage errors exit 4 before any adapter starts: --variant without --render, an unknown --variant, an invalid --max-warnings',
    async () => {
      const ledger = await project({ scenario: SCENARIO, rules: [NO_EMOJI], cases: KO_JA });
      for (const [args, shown] of [
        [['--variant', 'current'], '--variant'],
        [['--render', '--variant', 'nope'], '"nope"'],
        [['--max-warnings=few'], '"few"'],
      ] as const) {
        const { cli, envelope } = await lintJson(ledger, args);
        expect(cli.code, args.join(' ')).toBe(4);
        expect(envelope.exit).toEqual({ code: 4, name: 'config-error' });
        expect(envelope.result).toBeNull();
        expect(cli.stderr).toContain(shown);
      }
      expect(await ledger.sessions()).toEqual([]);
    },
    E2E.timeout,
  );
});
