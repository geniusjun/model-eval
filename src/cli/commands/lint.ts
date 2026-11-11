import { toFinding, type Diagnostic } from '../../config/diagnostics.js';
import { loadProject } from '../../config/load.js';
import type { Lang, Variant } from '../../config/schema.js';
import { lintProject, type AdapterUse } from '../../lint/index.js';
import { message, selectLang, type MessageKey, type MessageParams } from '../../messages/index.js';
import { createRedactor } from '../../report/redact.js';
import type { ExitName } from '../exit-codes.js';
import { lintLines } from '../human/lint.js';
import type { CommandHandler, CommandInvocation } from '../main.js';
import type { EnvelopeWarning } from '../results.js';
import { adapterRelay, printAll, TOOL_NAME } from './run-setup.js';

// `model-eval lint` (contracts/cli.md §`lint` Options): findings, never a model call.

const COUNT = /^\d+$/;

/**
 * `adapter-failed` exits 4 like every adapter problem; other errors, and warnings above
 * `--max-warnings`, exit 1. Info never counts.
 */
export function lintExit(findings: readonly Diagnostic[], maxWarnings: number | null): ExitName {
  if (findings.some((finding) => finding.code === 'adapter-failed')) {
    return 'config-error';
  }
  const warnings = findings.filter((finding) => finding.level === 'warning').length;
  if (
    findings.some((finding) => finding.level === 'error') ||
    (maxWarnings !== null && warnings > maxWarnings)
  ) {
    return 'failed';
  }
  return 'ok';
}

function report(
  invocation: CommandInvocation,
  lang: Lang,
  findings: readonly Diagnostic[],
  maxWarnings: number | null,
): ExitName {
  const exit = lintExit(findings, maxWarnings);
  const of = (level: Diagnostic['level']) =>
    findings.filter((finding) => finding.level === level).map(toFinding);
  const warnings: EnvelopeWarning[] = of('warning');
  printAll(invocation, lintLines(lang, findings, maxWarnings));
  invocation.output.envelope('lint', exit, { errors: of('error'), info: of('info') }, warnings);
  return exit;
}

function refuse(invocation: CommandInvocation, lang: Lang, key: MessageKey, params: MessageParams) {
  invocation.output.progress(message(lang, key, params));
  invocation.output.envelope('lint', 'config-error', null, []);
  return 'config-error' as const;
}

function stringValue(invocation: CommandInvocation, name: string): string | undefined {
  const value = invocation.values[name];
  return typeof value === 'string' ? value : undefined;
}

async function lint(invocation: CommandInvocation): Promise<ExitName> {
  const { common, context, output } = invocation;
  const startLang = common.lang ?? 'en';
  const adapter = adapterUse(invocation);
  if (adapter === null) {
    return refuse(invocation, startLang, 'cli.renderWithoutAdapter', {});
  }
  const chosen = stringValue(invocation, 'variant');
  if (chosen !== undefined && adapter !== 'render') {
    return refuse(invocation, startLang, 'cli.variantWithoutRender', {});
  }
  const limit = stringValue(invocation, 'max-warnings');
  if (limit !== undefined && !COUNT.test(limit)) {
    return refuse(invocation, startLang, 'cli.invalidMaxWarnings', { value: limit });
  }
  const maxWarnings = limit === undefined ? null : Number(limit);
  const loaded = await loadProject(common.config, context.cwd, startLang);
  if (!loaded.ok) {
    // File errors are lint findings: they exit 1, not 4 (contracts/cli.md §Exit Codes).
    return report(invocation, startLang, loaded.diagnostics, maxWarnings);
  }
  const { project } = loaded;
  const config = project.config.data;
  output.setRedactor(createRedactor(config.redact));
  const lang = selectLang(common.lang, config.lang);
  let variants: Variant[] | undefined;
  if (chosen !== undefined) {
    const variant = config.variants.find((item) => item.id === chosen);
    if (variant === undefined) {
      return refuse(invocation, lang, 'cli.unknownVariant', {
        variant: chosen,
        variants: config.variants.map((item) => item.id).join(', '),
      });
    }
    variants = [variant];
  }
  const findings = await lintProject(project, {
    cwd: context.cwd,
    adapter,
    variants,
    tool: { name: TOOL_NAME, version: context.version },
    ...adapterRelay(invocation),
  });
  return report(invocation, lang, findings, maxWarnings);
}

/** `null` for `--render` with `--no-adapter`: rendering needs the adapter (contracts/cli.md). */
function adapterUse(invocation: CommandInvocation): AdapterUse | null {
  const render = invocation.values.render === true;
  if (invocation.values['no-adapter'] === true) {
    return render ? null : 'none';
  }
  return render ? 'render' : 'targets';
}

export const lintCommand: CommandHandler = {
  options: {
    render: { type: 'boolean', default: false },
    variant: { type: 'string' },
    'max-warnings': { type: 'string' },
    'no-adapter': { type: 'boolean', default: false },
  },
  run: lint,
};
