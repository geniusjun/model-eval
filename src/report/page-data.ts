import { compareCodeUnits } from '../adapter/canonical-json.js';
import type { Lang } from '../config/schema.js';
import { COMPARISONS_DIR, REPORT_PAGE_FILE, savedComparisons } from './layout.js';
import {
  comparisonSchema,
  SCHEMA_VERSION,
  type Comparison,
  type ComparisonPage,
  type ListPage,
  type PageData,
} from './schema.js';

/** The template's data block holds this placeholder once (002 page-data §Embedded Block). */
export const DATA_PLACEHOLDER = '__MODEL_EVAL_DATA__';

/** The payload of `report.html`; the Comparison is the redacted one the writer saved. */
export function comparisonPage(comparison: Comparison, lang: Lang): ComparisonPage {
  return { schemaVersion: SCHEMA_VERSION, kind: 'comparison', lang, comparison };
}

type ListEntry = ListPage['comparisons'][number];

/** The entry's `comparisonId` is the folder name (002 page-data §Payloads). */
function listEntry(folder: string, comparison: Comparison): ListEntry {
  return {
    comparisonId: folder,
    href: [COMPARISONS_DIR, folder, REPORT_PAGE_FILE].join('/'),
    baseline: comparison.baseline.variant.id,
    candidate: comparison.candidate.variant.id,
    createdAt: comparison.createdAt,
    gate: comparison.gate.outcome,
  };
}

function newestFirst(a: ListEntry, b: ListEntry): number {
  const byTime = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  return byTime === 0 ? compareCodeUnits(a.comparisonId, b.comparisonId) : byTime;
}

/** The payload of the output root's `index.html`: every saved comparison, newest first. */
export async function listPage(outputDir: string, lang: Lang): Promise<ListPage> {
  const saved = await savedComparisons(outputDir, comparisonSchema);
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'list',
    lang,
    comparisons: saved
      .map(({ folder, comparison }) => listEntry(folder, comparison))
      .sort(newestFirst),
  };
}

/** JSON with every `<` written as `<`, so `</script>` or `<!--` cannot end the block. */
export function serializePageData(page: PageData): string {
  return JSON.stringify(page).replaceAll('<', '\\u003c');
}

/**
 * Puts the payload into the page template. The replacer function inserts the data verbatim,
 * where a replacement string would expand `$&` and `$1` found in model output. Nothing else
 * in the template changes, so the script hash in its CSP still holds.
 */
export function fillTemplate(template: string, page: PageData): string {
  if (template.split(DATA_PLACEHOLDER).length !== 2) {
    throw new Error(`the page template must hold ${DATA_PLACEHOLDER} exactly once`);
  }
  const data = serializePageData(page);
  return template.replace(DATA_PLACEHOLDER, () => data);
}
