// SC-003: the design-time simulation of research §Design-time validation, run through the
// shipped statistics code. Prints the tables and exits with 1 when an item misses its target.

import { pathToFileURL } from 'node:url';

import { reportConfigSchema, statsConfigSchema } from '../src/config/schema.js';
import { isLowBaseline } from '../src/report/low-baseline.js';
import type { Verdict } from '../src/report/schema.js';
import {
  caseWeightedRate,
  cellZValues,
  differenceInterval,
  effectiveTrials,
  zValues,
  type Difference,
  type PairedCase,
  type ZValues,
} from '../src/stats/interval.js';
import { decideVerdict, judgeCell, nMin } from '../src/stats/verdict.js';
import {
  betaDraw,
  betaFromMean,
  betaQuantile,
  binomial,
  createRandom,
  seedFrom,
  type BetaDistribution,
  type Random,
} from './random.js';

const { confidence: CONFIDENCE, minCases: MIN_CASES } = statsConfigSchema.parse({});
const { lowBaseline: LOW_BASELINE } = reportConfigSchema.parse({});
/** Rules per comparison, and gated cells for the one-cell items. */
const RULES = 5;
/** Runs per combination for the one-cell items. */
const RUNS = 1000;
/** Comparisons (families) for items (a) and (d). */
const FAMILIES = 1000;
/** Families of the (d) reference, from the same seed: the first 1,000 are those of (d). */
const REFERENCE_FAMILIES = 10_000;
const CASE_COUNTS = [3, 5, 10, 30] as const;
const REPEAT_COUNTS = [3, 5, 10] as const;
const MARGINS = [0.05, 0.1, 0.15] as const;
/** True baselines of item (a). */
const BASELINES = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99] as const;
/** The baseline of the four other rules in item (a)'s mixed comparisons, and of items (b) to (d). */
const HIGH_BASELINE = 0.95;

/** Beta(μκ, (1−μ)κ) per-case compliance; ICC 0.02 and 0.20. */
const HETEROGENEITY = [
  { name: 'low', kappa: 49 },
  { name: 'high', kappa: 4 },
] as const;

type Heterogeneity = (typeof HETEROGENEITY)[number];

/**
 * How a case's candidate compliance follows its baseline compliance:
 * - `identical`: the same probability (null);
 * - `shared-quantile`: both from one uniform draw through each variant's quantile function, which
 *   keeps the order of case difficulty (regression);
 * - `independent`: separate draws with equal means (null sensitivity).
 */
type Linkage = 'identical' | 'shared-quantile' | 'independent';

interface Scenario {
  readonly baseline: number;
  readonly candidate: number;
  readonly linkage: Linkage;
  readonly heterogeneity: Heterogeneity;
  readonly cases: number;
  readonly repeats: number;
  readonly margin: number;
}

/** A scenario's draws do not depend on the margin. */
type Draws = Omit<Scenario, 'margin'>;

interface CellRun {
  readonly verdict: Verdict;
  /** Whether [L, U] of an ungated cell holds the population Δ. */
  readonly covers: boolean;
}

const Z_GATED: ZValues = zValues(CONFIDENCE, RULES);
const Z_UNGATED: ZValues = cellZValues(Z_GATED, false);

const passes = (verdict: Verdict): boolean => verdict === 'non-inferior' || verdict === 'improved';

function drawCell(
  draws: Draws,
  random: Random,
  beta: { readonly baseline: BetaDistribution; readonly candidate: BetaDistribution },
): PairedCase[] {
  const pairs: PairedCase[] = [];
  for (let index = 0; index < draws.cases; index += 1) {
    let baseline: number;
    let candidate: number;
    if (draws.linkage === 'shared-quantile') {
      const draw = random();
      baseline = betaQuantile(beta.baseline, draw);
      candidate = betaQuantile(beta.candidate, draw);
    } else {
      baseline = betaDraw(random, beta.baseline);
      candidate = draws.linkage === 'identical' ? baseline : betaDraw(random, beta.candidate);
    }
    pairs.push({
      baseline: { trials: draws.repeats, passes: binomial(random, draws.repeats, baseline) },
      candidate: { trials: draws.repeats, passes: binomial(random, draws.repeats, candidate) },
    });
  }
  return pairs;
}

/** `count` cells of one scenario from a seed named by its fields in a fixed order. */
function drawCells(draws: Draws, count: number): PairedCase[][] {
  const key = [
    draws.baseline,
    draws.candidate,
    draws.linkage,
    draws.heterogeneity.kappa,
    draws.cases,
    draws.repeats,
  ].join('|');
  const random = createRandom(seedFrom(key));
  const beta = {
    baseline: betaFromMean(draws.baseline, draws.heterogeneity.kappa),
    candidate: betaFromMean(draws.candidate, draws.heterogeneity.kappa),
  };
  return Array.from({ length: count }, () => drawCell(draws, random, beta));
}

/** `count` gated cells of one of 5 gated cells, judged in full. */
function runCells(scenario: Scenario, count: number): CellRun[] {
  const delta = scenario.candidate - scenario.baseline;
  const trials = scenario.cases * scenario.repeats;
  return drawCells(scenario, count).map((pairs) => {
    const { verdict } = judgeCell({
      pairs,
      judgedTrials: { baseline: trials, candidate: trials },
      gated: true,
      margin: scenario.margin,
      minCases: MIN_CASES,
      z: Z_GATED,
    });
    const interval = differenceInterval(pairs, Z_UNGATED);
    const covers = interval !== null && interval.diff.low <= delta && delta <= interval.diff.high;
    return { verdict, covers };
  });
}

const share = <T>(items: readonly T[], predicate: (item: T) => boolean): number =>
  items.filter(predicate).length / items.length;

/** Consecutive groups of `size`. */
function groups<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size));
  }
  return result;
}

interface FamilyShares {
  readonly onePasses: number;
  readonly allPass: number;
}

function runFamilies(scenario: Scenario, families: number): FamilyShares {
  const cells = runCells(scenario, families * RULES);
  return {
    onePasses: share(cells, (cell) => passes(cell.verdict)),
    allPass: share(groups(cells, RULES), (group) => group.every((cell) => passes(cell.verdict))),
  };
}

interface Measured {
  readonly value: number;
  readonly scenario: Scenario;
}

function grid(
  base: Pick<Scenario, 'baseline' | 'candidate' | 'linkage'>,
  heterogeneity: Heterogeneity,
  margins: readonly number[],
): Scenario[] {
  return margins.flatMap((margin) =>
    CASE_COUNTS.flatMap((cases) =>
      REPEAT_COUNTS.map((repeats) => ({ ...base, heterogeneity, cases, repeats, margin })),
    ),
  );
}

function maximum(measured: readonly Measured[]): Measured {
  return measured.reduce((worst, item) => (item.value > worst.value ? item : worst));
}

function minimum(measured: readonly Measured[]): Measured {
  return measured.reduce((worst, item) => (item.value < worst.value ? item : worst));
}

const average = (measured: readonly Measured[]): number =>
  measured.reduce((sum, item) => sum + item.value, 0) / measured.length;

const percent = (value: number): string => (100 * value).toFixed(1);

const where = ({ scenario }: Measured): string =>
  `${String(scenario.cases)} cases × ${String(scenario.repeats)} repeats, m ${scenario.margin.toFixed(2)}, ${scenario.heterogeneity.name}, ${scenario.baseline.toFixed(2)} → ${scenario.candidate.toFixed(2)}`;

interface Row {
  readonly item: string;
  readonly measured: string;
  readonly target: string;
  /** Null for reference rows. */
  readonly met: boolean | null;
  readonly worst?: string;
}

const lowHigh = (values: readonly number[]): string => values.map(percent).join(' / ');

/** One drawn cell of item (a), with its intervals by the number of gated cells. */
interface FamilyCell {
  readonly pairs: PairedCase[];
  readonly lowBaseline: boolean;
  readonly intervals: Map<number, Difference>;
}

const zByGatedCells = new Map<number, ZValues>();

function zFor(gatedCells: number): ZValues {
  const known = zByGatedCells.get(gatedCells);
  if (known !== undefined) {
    return known;
  }
  const z = zValues(CONFIDENCE, gatedCells);
  zByGatedCells.set(gatedCells, z);
  return z;
}

function familyCells(draws: Draws): FamilyCell[] {
  return drawCells(draws, FAMILIES * RULES).map((pairs) => ({
    pairs,
    lowBaseline: isLowBaseline(
      { surface: 'raw', baseline: { rate: caseWeightedRate(pairs.map((pair) => pair.baseline)) } },
      LOW_BASELINE,
    ),
    intervals: new Map(),
  }));
}

/** The interval of a gated cell among `gatedCells`; differenceInterval is null only without cases. */
function intervalOf(cell: FamilyCell, gatedCells: number): Difference {
  const known = cell.intervals.get(gatedCells);
  if (known !== undefined) {
    return known;
  }
  const interval = differenceInterval(cell.pairs, zFor(gatedCells));
  if (interval === null) {
    throw new RangeError('a simulated cell has no common case');
  }
  cell.intervals.set(gatedCells, interval.diff);
  return interval.diff;
}

/** Whether any gated cell of a comparison is `regressed`, per data-model §Statistics. */
function blocks(gated: readonly FamilyCell[], margin: number): boolean {
  return gated.some((cell) => {
    const trials = cell.pairs.reduce((sum, pair) => sum + pair.baseline.trials, 0);
    const verdict = decideVerdict(
      {
        judgedTrials: { baseline: trials, candidate: trials },
        cases: cell.pairs.length,
        diff: intervalOf(cell, gated.length),
        minEffectiveTrials: Math.min(
          effectiveTrials(cell.pairs.map((pair) => pair.baseline)),
          effectiveTrials(cell.pairs.map((pair) => pair.candidate)),
        ),
      },
      { margin, minCases: MIN_CASES, zLower: Z_GATED.zLower },
    );
    return verdict === 'regressed';
  });
}

type Procedure = 'filtered' | 'mixed' | 'fixed';

/**
 * The comparisons of one draw setting, per procedure:
 * - `filtered`: all five rules at μ, gated cells those the default `report.lowBaseline` keeps;
 * - `mixed`: four rules at 0.95 and one at μ, filtered the same way;
 * - `fixed`: all five rules at μ, gated whatever their baseline.
 */
function falseBlocks(
  cells: readonly FamilyCell[],
  high: readonly FamilyCell[],
  procedure: Procedure,
  margin: number,
): number {
  let blocked = 0;
  for (let family = 0; family < FAMILIES; family += 1) {
    const start = family * RULES;
    const own = cells.slice(start, start + RULES);
    const comparison =
      procedure === 'mixed' ? [...own.slice(0, 1), ...high.slice(start + 1, start + RULES)] : own;
    const gated =
      procedure === 'fixed' ? comparison : comparison.filter((cell) => !cell.lowBaseline);
    if (blocks(gated, margin)) {
      blocked += 1;
    }
  }
  return blocked / FAMILIES;
}

const PROCEDURES: readonly { procedure: Procedure; label: string; target: boolean }[] = [
  {
    procedure: 'filtered',
    label: 'all five rules at μ, default `report.lowBaseline`',
    target: true,
  },
  {
    procedure: 'mixed',
    label: 'four rules at 0.95 and one at μ, default `report.lowBaseline`',
    target: true,
  },
  { procedure: 'fixed', label: 'Reference: 5 cells gated whatever their baseline', target: false },
];

const LINKAGES = [
  { linkage: 'identical', label: 'identical probabilities' },
  { linkage: 'independent', label: 'equal means' },
] as const;

/**
 * (a) Equal true compliance at baselines 0.5 to 0.99: comparisons with any `regressed` gated
 * cell, worst over the baselines and the grid.
 */
function itemA(): Row[] {
  const worst = new Map<string, Measured[]>();
  const record = (key: string, measured: Measured): void => {
    const list = worst.get(key) ?? [];
    list.push(measured);
    worst.set(key, list);
  };
  for (const { linkage } of LINKAGES) {
    for (const heterogeneity of HETEROGENEITY) {
      for (const cases of CASE_COUNTS) {
        for (const repeats of REPEAT_COUNTS) {
          const setting = { linkage, heterogeneity, cases, repeats };
          const high = familyCells({
            ...setting,
            baseline: HIGH_BASELINE,
            candidate: HIGH_BASELINE,
          });
          for (const baseline of BASELINES) {
            const cells =
              baseline === HIGH_BASELINE
                ? high
                : familyCells({ ...setting, baseline, candidate: baseline });
            for (const margin of MARGINS) {
              const scenario = { ...setting, baseline, candidate: baseline, margin };
              for (const { procedure } of PROCEDURES) {
                record(`${procedure}|${linkage}|${heterogeneity.name}`, {
                  value: falseBlocks(cells, high, procedure, margin),
                  scenario,
                });
              }
            }
          }
        }
      }
    }
  }
  return PROCEDURES.flatMap(({ procedure, label, target }) =>
    LINKAGES.map((linkage) => {
      const perHeterogeneity = HETEROGENEITY.map((heterogeneity) =>
        maximum(worst.get(`${procedure}|${linkage.linkage}|${heterogeneity.name}`) ?? []),
      );
      const highest = maximum(perHeterogeneity);
      return {
        item: `${target ? '(a) ' : ''}${label} (${linkage.label}), comparisons with any \`regressed\` gated cell, max over μ and the grid`,
        measured: lowHigh(perHeterogeneity.map((item) => item.value)),
        target: target ? '≤ 5' : '—',
        met: target ? highest.value <= 0.05 : null,
        worst: where(highest),
      };
    }),
  );
}

/** (b) True difference −m: one cell wrongly passes; and the reference coverage of Δ. */
function itemB(): Row[] {
  const boundaries = [
    { baseline: 0.95, candidate: 0.9, margin: 0.05 },
    { baseline: 0.95, candidate: 0.85, margin: 0.1 },
  ] as const;
  const pass: Measured[] = [];
  const coverage: Measured[] = [];
  for (const { baseline, candidate, margin } of boundaries) {
    for (const heterogeneity of HETEROGENEITY) {
      for (const scenario of grid(
        { baseline, candidate, linkage: 'shared-quantile' },
        heterogeneity,
        [margin],
      )) {
        const cells = runCells(scenario, RUNS);
        pass.push({ value: share(cells, (cell) => passes(cell.verdict)), scenario });
        coverage.push({ value: share(cells, (cell) => cell.covers), scenario });
      }
    }
  }
  const mean = average(pass);
  const highest = maximum(pass);
  const lowest = minimum(coverage);
  return [
    {
      item: `(b) True difference −m, one cell wrongly passes, mean over ${String(pass.length)} cells`,
      measured: percent(mean),
      target: '≤ 2.5',
      met: mean <= 0.025,
    },
    {
      item: `(b) Same, max over ${String(pass.length)} cells`,
      measured: percent(highest.value),
      target: '≤ 5',
      met: highest.value <= 0.05,
      worst: where(highest),
    },
    {
      item: `Reference: lowest coverage of the population Δ by the ungated interval [L, U] over the ${String(coverage.length)} (b) cells (nominal 95)`,
      measured: percent(lowest.value),
      target: '—',
      met: null,
      worst: where(lowest),
    },
  ];
}

function regressedShare(
  scenario: Omit<Scenario, 'heterogeneity' | 'linkage'>,
  heterogeneity: Heterogeneity,
): number {
  const cells = runCells({ ...scenario, linkage: 'shared-quantile', heterogeneity }, RUNS);
  return share(cells, (cell) => cell.verdict === 'regressed');
}

/** (c) A drop from 0.95 to 0.65 is `regressed`. */
function itemC(): Row[] {
  const settings = [
    { cases: 30, repeats: 5, margin: 0.1 },
    { cases: 10, repeats: 10, margin: 0.05 },
  ] as const;
  return settings.map(({ cases, repeats, margin }) => {
    const values = HETEROGENEITY.map((heterogeneity) =>
      regressedShare({ baseline: 0.95, candidate: 0.65, cases, repeats, margin }, heterogeneity),
    );
    return {
      item: `(c) 0.95 → 0.65 detected, ${String(cases)} cases, ${String(repeats)} repeats, m ${margin.toFixed(2)}`,
      measured: lowHigh(values),
      target: '≥ 80',
      met: values.every((value) => value >= 0.8),
    };
  });
}

function unchanged(
  rate: number,
  margin: number,
  heterogeneity: Heterogeneity,
  repeats = 5,
  families = FAMILIES,
): FamilyShares {
  return runFamilies(
    {
      baseline: rate,
      candidate: rate,
      linkage: 'identical',
      heterogeneity,
      cases: 30,
      repeats,
      margin,
    },
    families,
  );
}

/** (d) An unchanged candidate at a 0.95 baseline passes. */
function itemD(): Row[] {
  const shares = HETEROGENEITY.map((heterogeneity) => unchanged(0.95, 0.1, heterogeneity));
  const one = shares.map((item) => item.onePasses);
  const all = shares.map((item) => item.allPass);
  const reference = HETEROGENEITY.map((heterogeneity) =>
    unchanged(0.95, 0.1, heterogeneity, 5, REFERENCE_FAMILIES),
  );
  return [
    {
      item: `(d) Unchanged candidate (baseline 0.95), 30 cases, 5 repeats, m 0.10, one cell passes`,
      measured: lowHigh(one),
      target: '≥ 90',
      met: one.every((value) => value >= 0.9),
    },
    {
      item: `(d) Same, all 5 cells pass (${String(FAMILIES)} families)`,
      measured: lowHigh(all),
      target: '≥ 70',
      met: all.every((value) => value >= 0.7),
    },
    {
      item: `Reference: (d) over ${String(REFERENCE_FAMILIES)} families from the same seed, one cell · all 5 cells; standard error of the ${String(FAMILIES)}-family all-5 figure ${lowHigh(reference.map((item) => Math.sqrt((item.allPass * (1 - item.allPass)) / FAMILIES)))} pp`,
      measured: `${lowHigh(reference.map((item) => item.onePasses))} · ${lowHigh(reference.map((item) => item.allPass))}`,
      target: '—',
      met: null,
    },
  ];
}

function passShare(baseline: number, candidate: number, margin: number): number[] {
  return HETEROGENEITY.map((heterogeneity) => {
    const cells = runCells(
      {
        baseline,
        candidate,
        linkage: 'shared-quantile',
        heterogeneity,
        cases: 30,
        repeats: 5,
        margin,
      },
      RUNS,
    );
    return share(cells, (cell) => passes(cell.verdict));
  });
}

const familyShares = (shares: readonly FamilyShares[]): string =>
  `${lowHigh(shares.map((item) => item.onePasses))} · ${lowHigh(shares.map((item) => item.allPass))}`;

/** The margin trade-offs at 30 cases × 5 repeats; no targets. */
function marginTable(): string[] {
  const header = [
    '| Margin | n_min | 0.95 → 0.65 detected | Unchanged at 0.95: one cell · 5 cells | Unchanged at 0.99: one cell · 5 cells | 0.99 → 0.95 passes |',
    '|---|---|---|---|---|---|',
  ];
  const rows = MARGINS.map((margin) => {
    const detected = HETEROGENEITY.map((heterogeneity) =>
      regressedShare(
        { baseline: 0.95, candidate: 0.65, cases: 30, repeats: 5, margin },
        heterogeneity,
      ),
    );
    const families = (rate: number): string =>
      familyShares(HETEROGENEITY.map((heterogeneity) => unchanged(rate, margin, heterogeneity)));
    return `| ${margin.toFixed(2)} | ${String(nMin(margin, Z_GATED.zLower))} | ${lowHigh(detected)} | ${families(0.95)} | ${families(0.99)} | ${lowHigh(passShare(0.99, 0.95, margin))} |`;
  });
  const tenRepeats = familyShares(
    HETEROGENEITY.map((heterogeneity) => unchanged(0.99, 0.05, heterogeneity, 10)),
  );
  return [
    ...header,
    ...rows,
    '',
    `Unchanged at 0.99, 30 cases × 10 repeats, m 0.05: one cell · 5 cells ${tenRepeats}.`,
  ];
}

/** Collapses detected by cells with few cases; no targets. */
function fewCasesTable(): string[] {
  const drops = [0.2, 0.5, 0.65] as const;
  const header = [
    `| Cases × repeats | Margin | ${drops.map((drop) => `0.95 → ${drop.toFixed(2)} detected`).join(' | ')} |`,
    `|---|---|${drops.map(() => '---|').join('')}`,
  ];
  const settings = [
    { cases: 3, repeats: 5 },
    { cases: 5, repeats: 5 },
    { cases: 10, repeats: 5 },
  ] as const;
  const rows = settings.flatMap(({ cases, repeats }) =>
    [0.1, 0.05].map((margin) => {
      const detected = drops.map((drop) =>
        lowHigh(
          HETEROGENEITY.map((heterogeneity) =>
            regressedShare(
              { baseline: 0.95, candidate: drop, cases, repeats, margin },
              heterogeneity,
            ),
          ),
        ),
      );
      return `| ${String(cases)} × ${String(repeats)} | ${margin.toFixed(2)} | ${detected.join(' | ')} |`;
    }),
  );
  return [...header, ...rows];
}

function itemTable(rows: readonly Row[]): string[] {
  return [
    '| SC-003 item | Measured | Target | Result | Worst case |',
    '|---|---|---|---|---|',
    ...rows.map(
      (row) =>
        `| ${row.item} | ${row.measured} | ${row.target} | ${row.met === null ? '—' : row.met ? 'met' : 'missed'} | ${row.worst ?? ''} |`,
    ),
  ];
}

export function main(): number {
  const rows = [...itemA(), ...itemB(), ...itemC(), ...itemD()];
  const missed = rows.filter((row) => row.met === false);
  const lines = [
    `SC-003 at confidence ${String(CONFIDENCE)}, minCases ${String(MIN_CASES)}, ${String(RULES)} rules per comparison; percentages, low / high heterogeneity (κ ${HETEROGENEITY.map((item) => String(item.kappa)).join(' / ')}).`,
    `Item (a) runs ${String(FAMILIES)} comparisons per combination at true baselines ${BASELINES.join(', ')}; the default report.lowBaseline (${String(LOW_BASELINE)}) removes cells by their observed baseline rate and G is the number of cells left. One-cell items are one of ${String(RULES)} gated cells, ${String(RUNS)} runs per combination; item (d) uses ${String(FAMILIES)} families.`,
    '',
    ...itemTable(rows),
    '',
    'Margin trade-offs at 30 cases × 5 repeats (reference, no target):',
    '',
    ...marginTable(),
    '',
    'Collapses detected with few cases, one of 5 gated cells (reference, no target):',
    '',
    ...fewCasesTable(),
    '',
    missed.length === 0
      ? 'SC-003: every item met its target.'
      : `SC-003: ${String(missed.length)} item(s) missed: ${missed.map((row) => row.item).join('; ')}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  return missed.length === 0 ? 0 : 1;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = main();
}
