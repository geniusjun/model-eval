/** Exit codes and names of contracts/cli.md §Exit Codes, a public contract. */
export const EXIT_CODES = {
  ok: 0,
  failed: 1,
  undecided: 2,
  'run-failed': 3,
  'config-error': 4,
  'over-budget': 5,
  'internal-error': 6,
} as const;

export type ExitName = keyof typeof EXIT_CODES;
export type ExitCode = (typeof EXIT_CODES)[ExitName];

export const EXIT_NAMES: readonly ExitName[] = [
  'ok',
  'failed',
  'undecided',
  'run-failed',
  'config-error',
  'over-budget',
  'internal-error',
];

/** When several outcomes apply, the first name in this order wins. */
const PRECEDENCE: readonly ExitName[] = [
  'internal-error',
  'config-error',
  'over-budget',
  'run-failed',
  'failed',
  'undecided',
  'ok',
];

export function resolveExit(names: readonly ExitName[]): ExitName {
  return PRECEDENCE.find((name) => names.includes(name)) ?? 'ok';
}

export function exitStatus(name: ExitName): { code: ExitCode; name: ExitName } {
  return { code: EXIT_CODES[name], name };
}
