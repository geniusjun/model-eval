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
