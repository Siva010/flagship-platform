import { normalCdf, normalQuantile, studentTTwoSidedPValue } from './distributions.ts';

/**
 * Fixed-horizon tests.
 *
 * These are correct only when the sample size is fixed in advance and the result
 * is inspected once. Checking them repeatedly as data arrives inflates the false
 * positive rate far above the nominal alpha — see ./sequential.ts, and the
 * simulation in scripts/aa-simulation.ts that measures the difference.
 */

export interface ContinuousSample {
  n: number;
  mean: number;
  /** Sample variance, with Bessel's correction (denominator n-1). */
  variance: number;
}

export interface BinarySample {
  n: number;
  conversions: number;
}

export interface TestResult {
  /** Estimated difference, treatment minus control. */
  effect: number;
  /** Relative effect (lift) as a fraction of the control value. NaN if control is 0. */
  relativeEffect: number;
  standardError: number;
  statistic: number;
  pValue: number;
  confidenceInterval: [number, number];
  /** True when the interval excludes zero at the given alpha. */
  significant: boolean;
}

/** Streaming mean and variance (Welford). Avoids a second pass and is numerically stable. */
export class RunningStats {
  #count = 0;
  #mean = 0;
  #m2 = 0;

  push(value: number): void {
    this.#count += 1;
    const delta = value - this.#mean;
    this.#mean += delta / this.#count;
    this.#m2 += delta * (value - this.#mean);
  }

  get sample(): ContinuousSample {
    return {
      n: this.#count,
      mean: this.#mean,
      variance: this.#count > 1 ? this.#m2 / (this.#count - 1) : 0,
    };
  }
}

/**
 * Welch's t-test: two-sample, unequal variances.
 *
 * Student's pooled t-test assumes equal variance in both arms, which an
 * experiment has no reason to guarantee — a treatment can change the spread as
 * well as the mean. Welch is the safer default and costs nothing.
 */
export function welchTTest(
  control: ContinuousSample,
  treatment: ContinuousSample,
  alpha = 0.05,
): TestResult {
  const varOverNControl = control.variance / control.n;
  const varOverNTreatment = treatment.variance / treatment.n;
  const standardError = Math.sqrt(varOverNControl + varOverNTreatment);

  const effect = treatment.mean - control.mean;

  if (standardError === 0 || !Number.isFinite(standardError)) {
    return {
      effect,
      relativeEffect: control.mean === 0 ? Number.NaN : effect / control.mean,
      standardError: 0,
      statistic: 0,
      pValue: 1,
      confidenceInterval: [effect, effect],
      significant: false,
    };
  }

  // Welch-Satterthwaite degrees of freedom.
  const df =
    Math.pow(varOverNControl + varOverNTreatment, 2) /
    (Math.pow(varOverNControl, 2) / (control.n - 1) +
      Math.pow(varOverNTreatment, 2) / (treatment.n - 1));

  const statistic = effect / standardError;
  const pValue = studentTTwoSidedPValue(statistic, df);

  // Normal critical value: at the sample sizes experiments run at, the
  // difference from the exact t quantile is negligible.
  const critical = normalQuantile(1 - alpha / 2);
  const margin = critical * standardError;

  return {
    effect,
    relativeEffect: control.mean === 0 ? Number.NaN : effect / control.mean,
    standardError,
    statistic,
    pValue,
    confidenceInterval: [effect - margin, effect + margin],
    significant: pValue < alpha,
  };
}

/**
 * Two-proportion z-test for binary metrics (conversion rate).
 *
 * The p-value uses the pooled proportion, which is correct under the null. The
 * confidence interval uses the unpooled standard error, because under the
 * alternative the two arms genuinely have different variances. Using the pooled
 * SE for both is a common and subtly wrong shortcut.
 */
export function twoProportionZTest(
  control: BinarySample,
  treatment: BinarySample,
  alpha = 0.05,
): TestResult {
  const pControl = control.conversions / control.n;
  const pTreatment = treatment.conversions / treatment.n;
  const effect = pTreatment - pControl;

  const pooled = (control.conversions + treatment.conversions) / (control.n + treatment.n);
  const pooledSe = Math.sqrt(pooled * (1 - pooled) * (1 / control.n + 1 / treatment.n));

  const unpooledSe = Math.sqrt(
    (pControl * (1 - pControl)) / control.n + (pTreatment * (1 - pTreatment)) / treatment.n,
  );

  if (pooledSe === 0 || !Number.isFinite(pooledSe)) {
    return {
      effect,
      relativeEffect: pControl === 0 ? Number.NaN : effect / pControl,
      standardError: 0,
      statistic: 0,
      pValue: 1,
      confidenceInterval: [effect, effect],
      significant: false,
    };
  }

  const statistic = effect / pooledSe;
  const pValue = 2 * (1 - normalCdf(Math.abs(statistic)));

  const critical = normalQuantile(1 - alpha / 2);
  const margin = critical * unpooledSe;

  return {
    effect,
    relativeEffect: pControl === 0 ? Number.NaN : effect / pControl,
    standardError: unpooledSe,
    statistic,
    pValue,
    confidenceInterval: [effect - margin, effect + margin],
    significant: pValue < alpha,
  };
}

export interface MdeOptions {
  /** Baseline conversion rate, in [0, 1]. */
  baselineRate: number;
  /** Users per arm. */
  perArm: number;
  alpha?: number;
  power?: number;
}

/**
 * Minimum detectable effect: the smallest true difference this sample size can
 * detect at the given alpha and power.
 *
 * Worth surfacing in the console *before* an experiment starts. Most
 * underpowered experiments are launched by people who never computed this.
 */
export function minimumDetectableEffect(options: MdeOptions): {
  absolute: number;
  relative: number;
} {
  const { baselineRate, perArm, alpha = 0.05, power = 0.8 } = options;

  const zAlpha = normalQuantile(1 - alpha / 2);
  const zPower = normalQuantile(power);

  const variance = baselineRate * (1 - baselineRate);
  const absolute = (zAlpha + zPower) * Math.sqrt((2 * variance) / perArm);

  return {
    absolute,
    relative: baselineRate === 0 ? Number.NaN : absolute / baselineRate,
  };
}

/** Users per arm needed to detect `relativeEffect` at the given alpha and power. */
export function requiredSampleSize(options: {
  baselineRate: number;
  relativeEffect: number;
  alpha?: number;
  power?: number;
}): number {
  const { baselineRate, relativeEffect, alpha = 0.05, power = 0.8 } = options;

  const zAlpha = normalQuantile(1 - alpha / 2);
  const zPower = normalQuantile(power);
  const absolute = baselineRate * relativeEffect;

  if (absolute === 0) return Number.POSITIVE_INFINITY;

  const variance = baselineRate * (1 - baselineRate);
  return Math.ceil((2 * variance * Math.pow(zAlpha + zPower, 2)) / Math.pow(absolute, 2));
}
