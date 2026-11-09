/**
 * Numerical primitives for the BlessedBets probability engine.
 * Everything here is pure, deterministic and dependency-free so it can be
 * unit-tested and run identically on the server and in the browser.
 */

// ---------------------------------------------------------------------------
// Normal distribution
// ---------------------------------------------------------------------------

/**
 * Standard normal CDF using Hart's (1968) rational approximation.
 * Accurate to roughly 1e-15 across the whole real line, which matters because
 * we invert it to place Monte-Carlo thresholds in the tails.
 */
export function normalCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0
  const z = Math.abs(x)
  let p: number
  if (z > 37) {
    p = 0
  } else {
    const e = Math.exp(-(z * z) / 2)
    if (z < 7.07106781186547) {
      let n = 3.52624965998911e-2 * z + 0.700383064443688
      n = n * z + 6.37396220353165
      n = n * z + 33.912866078383
      n = n * z + 112.079291497871
      n = n * z + 221.213596169931
      n = n * z + 220.206867912376
      let d = 8.83883476483184e-2 * z + 1.75566716318264
      d = d * z + 16.064177579207
      d = d * z + 86.7807322029461
      d = d * z + 296.564248779674
      d = d * z + 637.333633378831
      d = d * z + 793.826512519948
      d = d * z + 440.413735824752
      p = (e * n) / d
    } else {
      // Continued-fraction expansion for the far tail.
      let f = z + 0.65
      f = z + 4 / f
      f = z + 3 / f
      f = z + 2 / f
      f = z + 1 / f
      p = e / (f * 2.506628274631)
    }
  }
  return x > 0 ? 1 - p : p
}

/** Standard normal PDF. */
export function normalPdf(x: number): number {
  return Math.exp(-(x * x) / 2) / 2.5066282746310002
}

/**
 * Inverse standard normal CDF (Acklam's algorithm) refined by one Halley step,
 * giving essentially full double precision.
 */
export function normalInvCdf(p: number): number {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]

  const pLow = 0.02425
  const pHigh = 1 - pLow
  let x: number

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p))
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  } else if (p <= pHigh) {
    const q = p - 0.5
    const r = q * q
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
        (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }

  // Halley refinement.
  const e = normalCdf(x) - p
  const u = e * 2.5066282746310002 * Math.exp((x * x) / 2)
  x = x - u / (1 + (x * u) / 2)
  return x
}

// ---------------------------------------------------------------------------
// Gamma / combinatorics
// ---------------------------------------------------------------------------

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
]

/** Natural log of the gamma function (Lanczos approximation, g=7, n=9). */
export function logGamma(z: number): number {
  if (z < 0.5) {
    // Reflection formula.
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z)
  }
  z -= 1
  let x = 0.99999999999980993
  for (let i = 0; i < LANCZOS.length; i++) x += LANCZOS[i] / (z + i + 1)
  const t = z + LANCZOS.length - 0.5
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
}

export function logFactorial(n: number): number {
  return logGamma(n + 1)
}

// ---------------------------------------------------------------------------
// Root finding
// ---------------------------------------------------------------------------

/**
 * Bisection on a monotone function. Returns the x where f(x) ~= 0.
 * Callers guarantee f(lo) and f(hi) straddle zero; if they do not we return the
 * endpoint whose value is closest to zero rather than throwing, because every
 * caller here is solving a well-behaved calibration problem and a hard failure
 * would take down a whole slate render.
 */
export function bisect(
  f: (x: number) => number,
  lo: number,
  hi: number,
  tol = 1e-10,
  maxIter = 200,
): number {
  let flo = f(lo)
  let fhi = f(hi)
  if (flo === 0) return lo
  if (fhi === 0) return hi
  if (flo * fhi > 0) return Math.abs(flo) <= Math.abs(fhi) ? lo : hi

  let a = lo
  let b = hi
  for (let i = 0; i < maxIter; i++) {
    const mid = (a + b) / 2
    const fmid = f(mid)
    if (fmid === 0 || (b - a) / 2 < tol) return mid
    if (flo * fmid < 0) {
      b = mid
      fhi = fmid
    } else {
      a = mid
      flo = fmid
    }
  }
  return (a + b) / 2
}

// ---------------------------------------------------------------------------
// Deterministic RNG
// ---------------------------------------------------------------------------

/**
 * Seeded PRNG (mulberry32). Determinism is a feature, not a convenience: the
 * same slate must produce the same recommended slips on every render, otherwise
 * the numbers shift under the user between page loads.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Stable 32-bit string hash, used to derive reproducible simulation seeds. */
export function hashString(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

export function sum(xs: number[]): number {
  let t = 0
  for (const x of xs) t += x
  return t
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : sum(xs) / xs.length
}
