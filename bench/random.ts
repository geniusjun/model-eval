// A seeded generator and the draws the SC-003 simulation needs. Seeds are fixed so every run
// prints the same tables (constitution VI).

import { logGamma, regularizedBeta } from '../src/stats/quantile.js';

export type Random = () => number;

/** FNV-1a over the UTF-16 code units: a scenario's name gives its seed. */
export function seedFrom(name: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash = Math.imul(hash ^ name.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}

/** A SplitMix-style seeder (golden-ratio step, MurmurHash3 finaliser) that spreads one seed over
 * the four state words. */
function spreadSeed(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/** xoshiro128**: uniform draws in the open interval (0, 1). */
export function createRandom(seed: number): Random {
  const words = spreadSeed(seed);
  let s0 = words();
  let s1 = words();
  let s2 = words();
  let s3 = words();
  return () => {
    const result = Math.imul(rotateLeft(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = s1 << 9;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotateLeft(s3, 11);
    return (result + 0.5) / 2 ** 32;
  };
}

function rotateLeft(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

/** Passes out of `trials` Bernoulli trials with pass probability `p`. */
export function binomial(random: Random, trials: number, p: number): number {
  let passes = 0;
  for (let trial = 0; trial < trials; trial += 1) {
    if (random() < p) {
      passes += 1;
    }
  }
  return passes;
}

/** A standard normal draw by the polar method; the second value of each pair is not kept. */
function normal(random: Random): number {
  for (;;) {
    const u = 2 * random() - 1;
    const v = 2 * random() - 1;
    const square = u * u + v * v;
    if (square > 0 && square < 1) {
      return u * Math.sqrt((-2 * Math.log(square)) / square);
    }
  }
}

/** Gamma(shape, 1) by Marsaglia and Tsang (2000); below shape 1 through Gamma(shape + 1)·U^{1/shape}. */
function gamma(random: Random, shape: number): number {
  if (shape < 1) {
    return gamma(random, shape + 1) * random() ** (1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normal(random);
    const v = (1 + c * x) ** 3;
    if (v > 0 && Math.log(random()) < 0.5 * x * x + d - d * v + d * Math.log(v)) {
      return d * v;
    }
  }
}

/** Beta(a, b) with its log normalising constant for the density. */
export interface BetaDistribution {
  readonly a: number;
  readonly b: number;
  readonly logBeta: number;
}

/** Beta(μκ, (1−μ)κ): mean μ, intra-class correlation 1/(κ+1). */
export function betaFromMean(mean: number, kappa: number): BetaDistribution {
  const a = mean * kappa;
  const b = (1 - mean) * kappa;
  return { a, b, logBeta: logGamma(a) + logGamma(b) - logGamma(a + b) };
}

/** A Beta draw as X/(X + Y) from two Gamma draws; faster than the quantile when no uniform is shared. */
export function betaDraw(random: Random, beta: BetaDistribution): number {
  const x = gamma(random, beta.a);
  const y = gamma(random, beta.b);
  return x / (x + y);
}

function betaDensity(beta: BetaDistribution, x: number): number {
  const { a, b, logBeta } = beta;
  return Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log1p(-x) - logBeta);
}

/**
 * x with I_x(a, b) = u. Newton steps inside a shrinking bracket, falling back to bisection when
 * a step leaves it; Beta(3.96, 0.04) puts most of its mass within 1e-10 of 1, where Newton
 * alone overshoots.
 */
export function betaQuantile(beta: BetaDistribution, u: number): number {
  let low = 0;
  let high = 1;
  let x = beta.a / (beta.a + beta.b);
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const error = regularizedBeta(x, beta.a, beta.b) - u;
    if (error > 0) {
      high = x;
    } else {
      low = x;
    }
    const newton = x - error / betaDensity(beta, x);
    const next =
      Number.isFinite(newton) && newton > low && newton < high ? newton : (low + high) / 2;
    if (Math.abs(next - x) < 1e-12 || high - low < 1e-12) {
      return next;
    }
    x = next;
  }
  return x;
}
