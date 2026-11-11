// Wichura's AS 241 (PPND16): rational approximations of the standard normal quantile with
// relative error about 1e-16, closed form so the same inputs always give the same z.

const CENTRAL_NUMERATOR = [
  3.3871328727963665, 133.14166789178438, 1971.5909503065513, 13731.69376550946, 45921.95393154987,
  67265.7709270087, 33430.57558358813, 2509.0809287301227,
];
const CENTRAL_DENOMINATOR = [
  1, 42.31333070160091, 687.1870074920579, 5394.196021424751, 21213.794301586597, 39307.89580009271,
  28729.085735721943, 5226.495278852854,
];
const NEAR_NUMERATOR = [
  1.4234371107496835, 4.630337846156546, 5.769497221460691, 3.6478483247632045, 1.2704582524523684,
  0.2417807251774506, 0.022723844989269184, 0.0007745450142783414,
];
const NEAR_DENOMINATOR = [
  1, 2.053191626637759, 1.6763848301838038, 0.6897673349851, 0.14810397642748008,
  0.015198666563616457, 0.0005475938084995345, 1.0507500716444169e-9,
];
const FAR_NUMERATOR = [
  6.657904643501103, 5.463784911164114, 1.7848265399172913, 0.29656057182850487,
  0.026532189526576124, 0.0012426609473880784, 2.7115555687434876e-5, 2.0103343992922881e-7,
];
const FAR_DENOMINATOR = [
  1, 0.599832206555888, 0.1369298809227358, 0.014875361290850615, 0.0007868691311456133,
  1.8463183175100548e-5, 1.421511758316446e-7, 2.0442631033899397e-15,
];

function polynomial(coefficients: readonly number[], x: number): number {
  return coefficients.reduceRight((sum, coefficient) => sum * x + coefficient, 0);
}

function rational(numerator: readonly number[], denominator: readonly number[], x: number): number {
  return polynomial(numerator, x) / polynomial(denominator, x);
}

/** z with Φ(z) = p, for 0 < p < 1. */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) {
    throw new RangeError(`the normal quantile needs 0 < p < 1, not ${String(p)}`);
  }
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    return q * rational(CENTRAL_NUMERATOR, CENTRAL_DENOMINATOR, 0.180625 - q * q);
  }
  const r = Math.sqrt(-Math.log(q < 0 ? p : 1 - p));
  const magnitude =
    r <= 5
      ? rational(NEAR_NUMERATOR, NEAR_DENOMINATOR, r - 1.6)
      : rational(FAR_NUMERATOR, FAR_DENOMINATOR, r - 5);
  return q < 0 ? -magnitude : magnitude;
}

// Lanczos approximation (g = 7, 9 terms) of ln Γ, relative error below 1e-13 for x > 0.
const LANCZOS_CONSTANT = 0.9999999999998099;
const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905,
  -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
];

/** ln Γ(x) for x > 0. */
export function logGamma(x: number): number {
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const shifted = x - 1;
  const sum = LANCZOS.reduce(
    (total, coefficient, index) => total + coefficient / (shifted + index + 1),
    LANCZOS_CONSTANT,
  );
  const t = shifted + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

const TINY = 1e-300;

const awayFromZero = (value: number): number => (Math.abs(value) < TINY ? TINY : value);

/** The continued fraction of I_x(a, b) (DLMF 8.17.22), evaluated with the modified Lentz method. */
function betaFraction(x: number, a: number, b: number): number {
  let c = 1;
  let d = 1 / awayFromZero(1 - ((a + b) * x) / (a + 1));
  let fraction = d;
  for (let m = 1; m <= 10_000; m += 1) {
    const even = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 / awayFromZero(1 + even * d);
    c = awayFromZero(1 + even / c);
    fraction *= d * c;
    const odd = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 / awayFromZero(1 + odd * d);
    c = awayFromZero(1 + odd / c);
    const step = d * c;
    fraction *= step;
    if (Math.abs(step - 1) < 1e-16) {
      return fraction;
    }
  }
  throw new RangeError(`the incomplete beta fraction did not converge at x = ${String(x)}`);
}

/**
 * The regularised incomplete beta function I_x(a, b). `complement` is 1 − x, passed separately
 * when the caller has it without the rounding of a subtraction.
 */
export function regularizedBeta(x: number, a: number, b: number, complement = 1 - x): number {
  if (x <= 0) {
    return 0;
  }
  if (complement <= 0) {
    return 1;
  }
  const logFront =
    a * Math.log(x) + b * Math.log(complement) - (logGamma(a) + logGamma(b) - logGamma(a + b));
  const front = Math.exp(logFront);
  // The fraction converges fast below the mean; above it, I_x(a, b) = 1 − I_{1−x}(b, a).
  return x < (a + 1) / (a + b + 2)
    ? (front * betaFraction(x, a, b)) / a
    : 1 - (front * betaFraction(complement, b, a)) / b;
}

/** P(T > t) for t ≥ 0 with ν degrees of freedom: ½ I_{ν/(ν+t²)}(ν/2, ½). */
function studentTail(t: number, degrees: number): number {
  const square = t * t;
  return (
    0.5 *
    regularizedBeta(degrees / (degrees + square), degrees / 2, 0.5, square / (degrees + square))
  );
}

/** The density of Student's t at t. */
function studentDensity(t: number, degrees: number): number {
  const half = degrees / 2;
  return Math.exp(
    logGamma(half + 0.5) -
      logGamma(half) -
      0.5 * Math.log(degrees * Math.PI) -
      (half + 0.5) * Math.log1p((t * t) / degrees),
  );
}

/**
 * t with P(T ≤ t) = p for Student's t with `degrees` degrees of freedom. Newton steps on the tail
 * probability inside a bracket that only shrinks, with bisection when a step leaves it, so the
 * same inputs always give the same t. A lower tail too small for 1 − p to hold (p = α near 0)
 * keeps its precision: t_{ν, 1−α} is −t_{ν, α}.
 */
export function studentTQuantile(degrees: number, p: number): number {
  if (!(Number.isInteger(degrees) && degrees >= 1)) {
    throw new RangeError(`the t quantile needs a positive integer df, not ${String(degrees)}`);
  }
  if (!(p > 0 && p < 1)) {
    throw new RangeError(`the t quantile needs 0 < p < 1, not ${String(p)}`);
  }
  if (p === 0.5) {
    return 0;
  }
  const tail = Math.min(p, 1 - p);
  let low = 0;
  let high = Number.POSITIVE_INFINITY;
  // t is at least z for the same tail, so z is a start from below.
  let t = -normalQuantile(tail);
  for (let iteration = 0; iteration < 2000; iteration += 1) {
    const error = studentTail(t, degrees) - tail;
    if (error > 0) {
      low = t;
    } else {
      high = t;
    }
    const newton = t + error / studentDensity(t, degrees);
    const next =
      newton > low && newton < high
        ? newton
        : Number.isFinite(high)
          ? (low + high) / 2
          : 2 * Math.max(t, 1);
    if (Math.abs(next - t) <= 1e-15 * next || next === low || next === high) {
      return p < 0.5 ? -next : next;
    }
    t = next;
  }
  return p < 0.5 ? -t : t;
}
