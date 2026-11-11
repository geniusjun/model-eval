import { compareServiceCode, sameHelper, type UnverifiedService } from '../adapter/identity.js';
import type { InitializeResult } from '../adapter/protocol.js';
import type { Config } from '../config/schema.js';
import { variantFingerprint } from './hashes.js';
import type { Manifest } from './manifest.js';
import type { RunCaseSpec } from './run-cases.js';
import type { Warning } from './warning.js';

// What a resume refuses and what it warns about (data-model §Resume and Locking, rules 1–7).

/** Command line options that set what the manifest records. */
export type RecordedOption = 'variant' | 'from' | 'to' | 'repeats' | 'cases';

/** A generation condition that differs from the manifest. */
export type ChangedCondition =
  | 'cases'
  | 'service'
  | 'adapter-name'
  | 'adapter-version'
  | 'launch-hash'
  | 'helper-version'
  | 'render-fingerprint';

type UnverifiedCondition = UnverifiedService | 'render-fingerprint';
type IgnoredField = 'variant' | 'seed' | 'repeats' | 'retries' | 'timeoutMs';

/** Every refusal is a configuration error (exit code 4). */
export type ResumeRefusal =
  /** Resume finishes stopped runs; resending trials of a finished one would change its basis. */
  | { readonly kind: 'complete' }
  /** Both runs of a swap share the cap and the interleaving, so only `swap --resume` goes on. */
  | { readonly kind: 'in-swap'; readonly swapId: string }
  | { readonly kind: 'options'; readonly options: readonly RecordedOption[] }
  | { readonly kind: 'cases-missing'; readonly caseIds: readonly string[] }
  | {
      readonly kind: 'conditions';
      readonly conditions: readonly ChangedCondition[];
      /** Cases whose hash or render fingerprint changed. */
      readonly caseIds: readonly string[];
    };

/**
 * With `run`, refuses a `complete` run and a run that belongs to a swap. With `swap`, the swap
 * record decides: a run of an unfinished swap may itself be complete, since a kill can fall
 * between the two runs' ends, and it then sends nothing.
 */
export function statusRefusal(
  manifest: Manifest,
  command: 'run' | 'swap',
): ResumeRefusal | undefined {
  if (command === 'swap') {
    return undefined;
  }
  if (manifest.status === 'complete') {
    return { kind: 'complete' };
  }
  if (manifest.swapId !== undefined) {
    return { kind: 'in-swap', swapId: manifest.swapId };
  }
  return undefined;
}

/** What the command line set that the manifest records; absent options are not compared. */
export interface SetOptions {
  readonly variant?: { readonly option: 'variant' | 'from' | 'to'; readonly id: string };
  readonly repeats?: number;
  readonly cases?: string;
}

/** An option the command line set, and whether it matches the manifest. */
export interface ComparedOption {
  readonly option: RecordedOption;
  readonly matches: boolean;
}

/** What `--variant`, `--from`/`--to`, `--repeats` and `--cases` set, against the manifest. */
export function recordedOptions(manifest: Manifest, set: SetOptions): ComparedOption[] {
  return [
    ...(set.variant === undefined
      ? []
      : [{ option: set.variant.option, matches: set.variant.id === manifest.variant.id }]),
    ...(set.repeats === undefined
      ? []
      : [{ option: 'repeats' as const, matches: set.repeats === manifest.sampling.repeats }]),
    ...(set.cases === undefined
      ? []
      : [{ option: 'cases' as const, matches: set.cases === manifest.sampling.cases }]),
  ];
}

/** Options set differently from the manifest are refused. */
export function optionRefusal(options: readonly ComparedOption[]): ResumeRefusal | undefined {
  const differing = options.filter((option) => !option.matches).map((option) => option.option);
  return differing.length === 0 ? undefined : { kind: 'options', options: differing };
}

/** Config values the manifest wins over: variant, seed, repeats, retries and time limit. */
export function ignoredConfigFields(manifest: Manifest, config: Config): IgnoredField[] {
  const variant = config.variants.find((each) => each.id === manifest.variant.id);
  const fields: [IgnoredField, boolean][] = [
    [
      'variant',
      variant === undefined || variantFingerprint(variant) !== manifest.variant.fingerprint,
    ],
    ['seed', config.sampling.seed !== manifest.sampling.seed],
    ['repeats', config.sampling.repeats !== manifest.sampling.repeats],
    ['retries', config.run.retries !== manifest.limits.retries],
    ['timeoutMs', config.adapter.timeoutMs !== manifest.limits.timeoutMs],
  ];
  return fields.filter(([, differs]) => differs).map(([field]) => field);
}

export interface CaseCheck {
  readonly refusal?: ResumeRefusal;
  /** The manifest's cases as the files define them now, in manifest order. */
  readonly cases: readonly RunCaseSpec[];
  /** Cases the case filter matches in the files that the manifest does not list; left out. */
  readonly leftOut: readonly string[];
}

/**
 * The run's cases come from the manifest: one missing from the files is refused, one whose hash
 * changed is a changed generation condition, and cases only in the files are left out.
 */
export function checkCases(manifest: Manifest, current: readonly RunCaseSpec[]): CaseCheck {
  const byId = new Map(current.map((spec) => [spec.id, spec]));
  const recorded = new Set(manifest.cases.map((each) => each.id));
  const missing = manifest.cases.filter((each) => !byId.has(each.id)).map((each) => each.id);
  const changed = manifest.cases
    .filter((each) => {
      const spec = byId.get(each.id);
      return spec !== undefined && spec.hash !== each.hash;
    })
    .map((each) => each.id);
  const cases = manifest.cases.flatMap((each) => {
    const spec = byId.get(each.id);
    return spec === undefined ? [] : [spec];
  });
  const leftOut = current.filter((spec) => !recorded.has(spec.id)).map((spec) => spec.id);
  if (missing.length > 0) {
    return { refusal: { kind: 'cases-missing', caseIds: missing }, cases, leftOut };
  }
  if (changed.length > 0) {
    return {
      refusal: { kind: 'conditions', conditions: ['cases'], caseIds: changed },
      cases,
      leftOut,
    };
  }
  return { cases, leftOut };
}

/** What the adapter declares now, for the generation conditions of rule 4. */
export interface CurrentGeneration {
  readonly info: InitializeResult;
  /** Compared with the recorded `adapter.launchHash` as written. */
  readonly launchHash: string;
  /** Render fingerprints per case; `undefined` when the adapter does not render. */
  readonly prompts: Readonly<Record<string, string>> | undefined;
}

export interface GenerationCheck {
  readonly refusal?: ResumeRefusal;
  readonly unverified: readonly UnverifiedCondition[];
}

function checkPrompts(
  manifest: Manifest,
  current: Readonly<Record<string, string>> | undefined,
): { readonly changed: readonly string[]; readonly unverified: boolean } {
  const recorded = manifest.prompts;
  if (recorded === undefined || current === undefined) {
    return { changed: [], unverified: true };
  }
  const changed: string[] = [];
  let unverified = false;
  for (const { id } of manifest.cases) {
    const before = recorded[id];
    const now = current[id];
    if (before === undefined || now === undefined) {
      unverified = true;
    } else if (before !== now) {
      changed.push(id);
    }
  }
  return { changed, unverified };
}

/**
 * Rule 4: service code, adapter name, version and `launchHash`, helper version and render
 * fingerprints; rule 6: what cannot be verified. The rules hash and commit SHA are not compared.
 */
export function checkGeneration(manifest: Manifest, current: CurrentGeneration): GenerationCheck {
  const { adapter } = current.info;
  const service = compareServiceCode(manifest.service, current.info.service);
  const prompts = checkPrompts(manifest, current.prompts);
  const changes: [ChangedCondition, boolean][] = [
    ['service', service.changed],
    ['adapter-name', adapter.name !== manifest.adapter.name],
    ['adapter-version', adapter.version !== manifest.adapter.version],
    ['launch-hash', current.launchHash !== manifest.adapter.launchHash],
    ['helper-version', !sameHelper(manifest.adapter.helper, adapter.helper)],
    ['render-fingerprint', prompts.changed.length > 0],
  ];
  const conditions = changes.filter(([, changed]) => changed).map(([condition]) => condition);
  const unverified: UnverifiedCondition[] = [
    ...(service.unverified === undefined ? [] : [service.unverified]),
    ...(prompts.unverified ? ['render-fingerprint' as const] : []),
  ];
  return conditions.length === 0
    ? { unverified }
    : {
        refusal: { kind: 'conditions', conditions, caseIds: [...prompts.changed] },
        unverified,
      };
}

/** `resume-unverified` and `resume-config-ignored` of one run's new segment. */
export function resumeWarnings(
  variantId: string,
  unverified: readonly UnverifiedCondition[],
  ignored: readonly IgnoredField[],
  leftOut: readonly string[],
): Warning[] {
  const variants = [variantId];
  return [
    ...(unverified.length === 0
      ? []
      : [
          {
            code: 'resume-unverified' as const,
            params: { conditions: [...unverified] },
            variants,
          },
        ]),
    ...(ignored.length === 0 && leftOut.length === 0
      ? []
      : [
          {
            code: 'resume-config-ignored' as const,
            params: { fields: [...ignored] },
            variants,
            ...(leftOut.length === 0 ? {} : { caseIds: [...leftOut] }),
          },
        ]),
  ];
}

/**
 * Rule 5: the paths the config's globs match now and every path this run sent before, so new
 * rule files do not count as service code and old ones that left the glob still do.
 */
export function joinedToolPaths(
  segments: Manifest['segments'],
  matched: readonly string[],
): string[] {
  return [...new Set([...segments.flatMap((segment) => segment.toolPaths), ...matched])];
}
