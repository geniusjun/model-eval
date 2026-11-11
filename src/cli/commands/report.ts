import path from 'node:path';

import { loadConfig } from '../../config/load.js';
import { comparisonIdSchema } from '../../config/identifiers.js';
import { selectLang, type MessageKey, type MessageParams } from '../../messages/index.js';
import { comparisonDir, readSavedComparison } from '../../report/layout.js';
import { createRedactor } from '../../report/redact.js';
import { rewriteReport } from '../../report/write.js';
import type { ExitName } from '../exit-codes.js';
import { reportLines } from '../human/compare.js';
import { diagnosticLines } from '../human/swap.js';
import type { CommandHandler, CommandInvocation } from '../main.js';
import { printAll, refuse } from './run-setup.js';
import { positionalIds, refuseWith } from './saved.js';

// `model-eval report <comparisonId>`: rewrites the outputs of a saved comparison from its
// `comparison.json`, which already holds every rule detail, version and setting (FR-029).

async function report(invocation: CommandInvocation): Promise<ExitName> {
  const ids = positionalIds(invocation, 'report', ['comparisonId']);
  if (!ids.ok) {
    return ids.exit;
  }
  const { common, context, output } = invocation;
  const loaded = await loadConfig(common.config, context.cwd, common.lang ?? 'en');
  if (!loaded.ok) {
    return refuse(invocation, 'report', diagnosticLines(common.lang ?? 'en', loaded.diagnostics));
  }
  const config = loaded.config.data;
  output.setRedactor(createRedactor(config.redact));
  const lang = selectLang(common.lang, config.lang);
  const [comparisonId = ''] = ids.value;
  if (!comparisonIdSchema.safeParse(comparisonId).success) {
    return refuseWith(invocation, 'report', lang, 'cli.invalidComparisonId', {
      value: comparisonId,
    }).exit;
  }
  const { outputDir } = loaded.paths;
  const shown = (file: string) => path.relative(context.cwd, file) || file;
  const saved = await readSavedComparison(outputDir, comparisonId);
  if (!saved.ok) {
    const refused = (key: MessageKey, params: MessageParams) =>
      refuseWith(invocation, 'report', lang, key, params).exit;
    switch (saved.problem) {
      case 'missing':
        return refused('cli.unknownComparison', {
          comparisonId,
          dir: shown(path.dirname(comparisonDir(outputDir, comparisonId))),
        });
      case 'unreadable':
        return refused('cli.unreadableFile', {
          file: shown(saved.file),
          detail: 'not a comparison',
        });
      case 'other-id':
        return refused('cli.otherComparisonId', {
          file: shown(saved.file),
          found: saved.found,
          comparisonId,
        });
    }
  }
  const { comparison } = saved;
  const written = await rewriteReport({ outputDir, comparison, lang });
  output.envelope('report', 'ok', { comparisonId }, []);
  printAll(invocation, reportLines(lang, { comparison, reportPath: shown(written.report) }));
  return 'ok';
}

export const reportCommand: CommandHandler = {
  options: {},
  run: report,
};
