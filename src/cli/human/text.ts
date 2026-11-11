import type { LintFinding } from '../../config/diagnostics.js';
import { isComparableVersion } from '../../lint/helper-version.js';
import type { Lang } from '../../config/schema.js';
import {
  countedKey,
  message,
  type CountedKey,
  type MessageKey,
  type MessageParams,
} from '../../messages/index.js';
import type { Quote } from '../../report/code-text.js';
import { marginPoints } from '../../report/format.js';

// Text helpers the human output of every command shares: messages in the `--lang` language,
// finding text and where a finding points.

export interface Text {
  readonly lang: Lang;
  (key: MessageKey, params?: MessageParams): string;
}

export function textOf(lang: Lang): Text {
  return Object.assign((key: MessageKey, params?: MessageParams) => message(lang, key, params), {
    lang,
  });
}

/** A message that counts something, in its form for `count`; `{count}` holds the number. */
export function counted(
  t: Text,
  key: CountedKey,
  count: number,
  params: MessageParams = {},
): string {
  return t(countedKey(key, count), { count, ...params });
}

/** Adapter, model and service text is shown as a JSON string, so control characters stay inert. */
export const quote: Quote = (text) => JSON.stringify(text);

export function placeLabel(place: {
  readonly ruleId?: string | undefined;
  readonly lang?: string | undefined;
  readonly surface?: string | undefined;
}): string | undefined {
  const where = [place.lang, place.surface].filter((part) => part !== undefined).join(', ');
  if (place.ruleId === undefined) {
    return where === '' ? undefined : where;
  }
  return where === '' ? place.ruleId : `${place.ruleId} (${where})`;
}

export function withPlace(label: string | undefined, text: string): string {
  return label === undefined ? text : `${label}: ${text}`;
}

function lintParam(name: string, value: unknown): string {
  if (typeof value === 'number') {
    return name === 'margin' ? marginPoints(value) : String(value);
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** A lint finding's text; `localDetail` replaces `params.detail`, which stays English data. */
export function lintText(t: Text, finding: LintFinding, localDetail?: string): string {
  const params: Record<string, string> =
    'params' in finding
      ? Object.fromEntries(
          Object.entries(finding.params).map(([name, value]) => [name, lintParam(name, value)]),
        )
      : {};
  if (localDetail !== undefined) {
    params.detail = localDetail;
  }
  if (finding.code === 'schema' && finding.params.path === '') {
    return t('lint.schema-file', params);
  }
  if (finding.code === 'few-cases' && finding.params.cases === 1) {
    return t('lint.few-cases.one', params);
  }
  if (finding.code === 'margin-unreachable' && finding.params.plannedTrials === 1) {
    return t('lint.margin-unreachable.one', params);
  }
  if (finding.code === 'helper-outdated' && !isComparableVersion(finding.params.version)) {
    return t('lint.helper-outdated.unknown', params);
  }
  return t(`lint.${finding.code}`, params);
}

/** `file:line:column` of a finding, or nothing when it has no file. */
export function positionLabel(finding: {
  readonly file?: string | undefined;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
}): string | undefined {
  return finding.file === undefined
    ? undefined
    : [finding.file, finding.line, finding.column].filter((part) => part !== undefined).join(':');
}
