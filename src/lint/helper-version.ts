import type { Helper } from '../adapter/protocol.js';
import type { LintFinding } from '../config/diagnostics.js';
import type { Place } from './subject.js';

// FR-035: `helper-outdated`, the helper an adapter reports in `initialize` against the helper
// version this release bundles (data-model §Validation Rules, Bundled helper version).

/** The version of the Python and TypeScript helpers shipped with this release. */
export const BUNDLED_HELPER_VERSION = '0.1.0';

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/u;

type VersionParts = readonly [bigint, bigint, bigint];

/** `MAJOR.MINOR.PATCH` of non-negative integers, or `undefined` for any other text. */
function versionParts(version: string): VersionParts | undefined {
  const match = VERSION.exec(version);
  if (match === null) {
    return undefined;
  }
  const [, major = '', minor = '', patch = ''] = match;
  return [BigInt(major), BigInt(minor), BigInt(patch)];
}

/** Whether a reported helper version has the form `MAJOR.MINOR.PATCH` and can be compared. */
export function isComparableVersion(version: string): boolean {
  return versionParts(version) !== undefined;
}

/** Whether `reported` is older than `bundled`, or not a version that can be compared with it. */
export function isHelperOutdated(reported: string, bundled: string): boolean {
  const ours = versionParts(bundled);
  if (ours === undefined) {
    throw new RangeError(`the bundled helper version ${bundled} is not MAJOR.MINOR.PATCH`);
  }
  const theirs = versionParts(reported);
  if (theirs === undefined) {
    return true;
  }
  for (const [index, part] of theirs.entries()) {
    const bundledPart = ours[index] ?? 0n;
    if (part !== bundledPart) {
      return part < bundledPart;
    }
  }
  return false;
}

/** The helper one variant's adapter reported in `initialize`; absent without a helper. */
export interface HelperReport {
  readonly variant: string;
  readonly helper: Helper | undefined;
}

/**
 * One `helper-outdated` finding per outdated reported version, naming the variants whose adapter
 * reported it, at `adapter.command`.
 */
export function helperOutdated(
  reports: readonly HelperReport[],
  place: Place,
  bundled: string = BUNDLED_HELPER_VERSION,
): LintFinding[] {
  const variantsByVersion = new Map<string, string[]>();
  for (const { variant, helper } of reports) {
    if (helper !== undefined && isHelperOutdated(helper.version, bundled)) {
      const variants = variantsByVersion.get(helper.version) ?? [];
      variants.push(variant);
      variantsByVersion.set(helper.version, variants);
    }
  }
  return [...variantsByVersion].map(([version, variants]) => ({
    code: 'helper-outdated',
    params: { version, bundled },
    variants,
    ...place,
  }));
}
