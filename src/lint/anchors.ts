import { compareCodeUnits } from '../adapter/canonical-json.js';
import type { AdapterClient } from '../adapter/client.js';
import type { LintFinding } from '../config/diagnostics.js';
import type { Anchor, Rule } from '../config/schema.js';
import { applicableRules } from '../grade/grade.js';
import { renderParams } from '../run/render-cases.js';
import { knownLanguageCases, type LintCase, type LintRule, type LintSubject } from './subject.js';

// FR-004: the anchored prompt sentences against each variant's rendered prompts
// (data-model §Anchor), and the rules and languages that have no anchor.

/** What one variant's adapter rendered. */
export interface VariantRender {
  readonly variant: string;
  /** The rendered prompt per case ID, whitespace normalised. */
  readonly prompts: ReadonlyMap<string, string>;
  /** The adapter's message per case ID that failed to render. */
  readonly failures: ReadonlyMap<string, string>;
}

/** A render that broke the protocol, or no `render` capability, is `adapter-failed`. */
export type RenderOutcome =
  | { readonly ok: true; readonly render: VariantRender }
  | { readonly ok: false; readonly detail: string };

/** Runs of whitespace become one space, so line breaks and indentation do not hide a sentence. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * Renders every case a run could send, with the request a run sends. An adapter without
 * `render` cannot have its anchors checked, so it fails.
 */
export async function renderVariant(
  client: AdapterClient,
  subject: LintSubject,
  variant: string,
  seed: number,
): Promise<RenderOutcome> {
  const prompts = new Map<string, string>();
  const failures = new Map<string, string>();
  if (!client.info.capabilities.render) {
    return { ok: false, detail: 'the adapter does not declare the render capability' };
  }
  const outcomes = await Promise.all(
    subject.cases.flatMap(({ render }) =>
      render === undefined
        ? []
        : [
            client
              .render(renderParams(render, seed))
              .then((outcome) => ({ id: render.id, outcome })),
          ],
    ),
  );
  for (const { id, outcome } of outcomes) {
    switch (outcome.kind) {
      case 'result':
        prompts.set(
          id,
          normalizeWhitespace(outcome.value.messages.map((item) => item.content).join('\n')),
        );
        break;
      case 'rpc-error':
        failures.set(id, outcome.message);
        break;
      case 'invalid':
      case 'lost':
        return { ok: false, detail: outcome.message };
    }
  }
  return { ok: true, render: { variant, prompts, failures } };
}

/** One `render-failed` per case and adapter message, with the variants it failed in. */
export function renderFailures(
  subject: LintSubject,
  renders: readonly VariantRender[],
): LintFinding[] {
  return subject.cases.flatMap(({ definition, at }) => {
    const variantsByDetail = new Map<string, string[]>();
    for (const { variant, failures } of renders) {
      const detail = failures.get(definition.id);
      if (detail !== undefined) {
        variantsByDetail.set(detail, [...(variantsByDetail.get(detail) ?? []), variant]);
      }
    }
    return [...variantsByDetail].map(([detail, variants]): LintFinding => ({
      code: 'render-failed',
      params: { detail },
      variants,
      caseIds: [definition.id],
      ...at(),
    }));
  });
}

/** Cases that must contain the anchor: its language, its target (else the rule's) and `cases`. */
function anchorCases(rule: Rule, anchor: Anchor, cases: readonly LintCase[]): LintCase[] {
  return cases.filter(({ definition, lang }) => {
    const targetMatches =
      anchor.target === undefined
        ? rule.targets.length === 0 || rule.targets.includes(definition.target)
        : definition.target === anchor.target;
    return (
      lang === anchor.lang &&
      targetMatches &&
      (anchor.cases === undefined || anchor.cases.includes(definition.id))
    );
  });
}

interface AnchorGroup {
  readonly lang: string;
  readonly quote: string;
  /** Index of the group's first anchor in the rule, where the finding points. */
  readonly index: number;
  readonly cases: LintCase[];
}

/** Anchors of one rule grouped by language and normalised quote. */
function anchorGroups(rule: Rule, cases: readonly LintCase[]): AnchorGroup[] {
  const groups = new Map<string, AnchorGroup>();
  rule.anchors.forEach((anchor, index) => {
    const key = `${anchor.lang}\n${normalizeWhitespace(anchor.quote)}`;
    const group = groups.get(key) ?? { lang: anchor.lang, quote: anchor.quote, index, cases: [] };
    group.cases.push(...anchorCases(rule, anchor, cases));
    groups.set(key, group);
  });
  return [...groups.values()];
}

function missingFinding(
  { rule, at }: LintRule,
  group: AnchorGroup,
  renders: readonly VariantRender[],
  cases: readonly LintCase[],
): LintFinding[] {
  const quote = normalizeWhitespace(group.quote);
  const variants: string[] = [];
  const missing = new Set<LintCase>();
  for (const render of renders) {
    const misses = group.cases.filter((lintCase) => {
      const prompt = render.prompts.get(lintCase.definition.id);
      return prompt !== undefined && !prompt.includes(quote);
    });
    if (misses.length > 0) {
      variants.push(render.variant);
      misses.forEach((lintCase) => missing.add(lintCase));
    }
  }
  if (variants.length === 0) {
    return [];
  }
  return [
    {
      code: 'anchor-missing',
      ruleId: rule.id,
      lang: group.lang,
      params: { quote: group.quote },
      variants,
      caseIds: cases
        .filter((lintCase) => missing.has(lintCase))
        .map(({ definition }) => definition.id),
      ...at(['anchors', group.index]),
    },
  ];
}

/**
 * One `anchor-missing` per active rule, language and quote, with the variants and cases whose
 * rendered prompt lacks it. Cases that did not render are not judged.
 */
export function anchorMissing(
  subject: LintSubject,
  renders: readonly VariantRender[],
): LintFinding[] {
  return subject.rules
    .filter(({ rule }) => rule.status === 'active')
    .flatMap((entry) =>
      anchorGroups(entry.rule, subject.cases).flatMap((group) =>
        missingFinding(entry, group, renders, subject.cases),
      ),
    );
}

/** `unanchored` per active rule and language of the cases it applies to, without an anchor. */
export function unanchored(subject: LintSubject): LintFinding[] {
  return subject.rules
    .filter(({ rule }) => rule.status === 'active')
    .flatMap(({ rule, at }) => {
      const anchored = new Set(rule.anchors.map((anchor) => anchor.lang));
      const languages = new Set(
        knownLanguageCases(subject.cases)
          .filter(({ definition, lang }) => applicableRules([rule], definition, lang).length > 0)
          .map(({ lang }) => lang),
      );
      return [...languages]
        .filter((lang) => !anchored.has(lang))
        .sort(compareCodeUnits)
        .map((lang): LintFinding => ({ code: 'unanchored', ruleId: rule.id, lang, ...at() }));
    });
}
