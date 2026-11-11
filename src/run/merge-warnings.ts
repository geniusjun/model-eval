import { compareCodeUnits } from '../adapter/canonical-json.js';
import type { Warning } from './warning.js';

// One warning per code for the run warnings whose params are one list (data-model §Warnings,
// Grouping): another segment or another start adds to the list, the variants and the cases
// instead of adding a second warning of the same code.

function unite<T>(...lists: readonly (readonly T[] | undefined)[]): T[] {
  return [...new Set(lists.flatMap((list) => list ?? []))];
}

function sorted(models: readonly string[]): string[] {
  return [...models].sort(compareCodeUnits);
}

/** Variants and cases of both, without the fields when neither has any. */
function joinedIds(a: Warning, b: Warning) {
  const variants = unite(a.variants, b.variants);
  const caseIds = unite(a.caseIds, b.caseIds);
  return {
    ...(variants.length === 0 ? {} : { variants }),
    ...(caseIds.length === 0 ? {} : { caseIds }),
  };
}

function mergedPair(a: Warning, b: Warning): Warning | undefined {
  const ids = joinedIds(a, b);
  if (a.code === 'resume-unverified' && b.code === 'resume-unverified') {
    return {
      code: a.code,
      params: { conditions: unite(a.params.conditions, b.params.conditions) },
      ...ids,
    };
  }
  if (a.code === 'resume-config-ignored' && b.code === 'resume-config-ignored') {
    return { code: a.code, params: { fields: unite(a.params.fields, b.params.fields) }, ...ids };
  }
  if (a.code === 'unpriced-model' && b.code === 'unpriced-model') {
    return {
      code: a.code,
      params: { models: sorted(unite(a.params.models, b.params.models)) },
      ...ids,
    };
  }
  if (a.code === 'cached-input-unpriced' && b.code === 'cached-input-unpriced') {
    return {
      code: a.code,
      params: { models: sorted(unite(a.params.models, b.params.models)) },
      ...ids,
    };
  }
  return undefined;
}

/** Merges each list warning into the first one of its code, in the order they come. */
export function mergeListWarnings(warnings: readonly Warning[]): Warning[] {
  const merged: Warning[] = [];
  for (const warning of warnings) {
    const index = merged.findIndex((each) => mergedPair(each, warning) !== undefined);
    const existing = merged[index];
    const joined = existing === undefined ? undefined : mergedPair(existing, warning);
    if (joined === undefined) {
      merged.push(warning);
    } else {
      merged[index] = joined;
    }
  }
  return merged;
}
