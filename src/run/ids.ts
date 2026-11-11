import { createHash, randomBytes } from 'node:crypto';

// data-model §Identifiers and Hashing.

/** A trial is one repeat of one case; both variants share the key and its seed. */
export interface TrialKey {
  readonly caseId: string;
  readonly repeat: number;
}

/** Returns the 4 lowercase hex digits that end a run or swap ID. */
export type SuffixSource = () => string;

const randomSuffix: SuffixSource = () => randomBytes(2).toString('hex');

/** `YYYYMMDD-HHMMSS` of the start time in UTC. */
function stamp(at: Date): string {
  const iso = at.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

export function newRunId(variantId: string, at: Date, suffix: SuffixSource = randomSuffix): string {
  return `${stamp(at)}-${variantId}-${suffix()}`;
}

export function newSwapId(at: Date, suffix: SuffixSource = randomSuffix): string {
  return `${stamp(at)}-swap-${suffix()}`;
}

/** The first 4 bytes of SHA-256("<seed>:<caseId>:<repeat>") as a big-endian unsigned integer. */
export function trialSeed(seed: number, caseId: string, repeat: number): number {
  return createHash('sha256')
    .update(`${String(seed)}:${caseId}:${String(repeat)}`, 'utf8')
    .digest()
    .readUInt32BE(0);
}

/** One string per key, for maps and sets. */
export function trialKeyId(key: TrialKey): string {
  return `${key.caseId}:${String(key.repeat)}`;
}
