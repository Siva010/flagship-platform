import type { BinarySample, ContinuousSample } from './frequentist.ts';

/**
 * Always-valid sequential testing (mSPRT).
 *
 * The problem this solves. A fixed-horizon p-value is only valid if you look
 * once, at a sample size chosen in advance. Teams instead watch a dashboard and
 * stop when it turns green — which is an optional stopping rule the maths never
 * accounted for. Each additional peek is another chance to cross the threshold
 * by luck, so the real false positive rate climbs far above the nominal 5%.
 * With continuous monitoring it approaches 100% as the horizon grows.
 *
 * The fix. The mixture Sequential Probability Ratio Test uses a likelihood
 * ratio that is a martingale under the null. Ville's inequality then bounds
 * P(sup_n Lambda_n >= 1/alpha) <= alpha — over the *entire sequence*, not at one
 * point. So the guarantee holds at any stopping time, including one chosen by a
 * human staring at a dashboard.
 *
 * Testing H0: effect = 0 against a normal mixing distribution N(0, tau^2), the
 * mixture likelihood ratio has the closed form
 *
 *   Lambda = sqrt(V / (V + tau^2)) * exp( tau^2 * d^2 / (2 * V * (V + tau^2)) )
 *
 * where d is the observed difference and V its variance. The always-valid
 * p-value is min(1, 1/Lambda), taken as a running minimum over time.
 *
 * The cost is real: mSPRT needs more samples than a correctly-run fixed-horizon
 * test to reach the same power. You are buying the right to stop whenever you
 * like, and it is not free.
 */

export interface SequentialResult {
  effect: number;
  standardError: number;
  /** The mixture likelihood ratio. Larger means more evidence against the null. */
  likelihoodRatio: number;
  /** Valid at any stopping time, unlike a fixed-horizon p-value. */
  alwaysValidPValue: number;
  /** Always-valid confidence interval; also valid at any stopping time. */
  confidenceInterval: [number, number];
  significant: boolean;
}

/**
 * `tau` is the mixing standard deviation — roughly the effect size you consider
 * plausible. It trades sensitivity across the effect range: too small and large
 * true effects are detected slowly, too large and small ones are. Setting it
 * near your MDE is the usual advice.
 */
export interface SequentialOptions {
  alpha?: number;
  tau?: number;
}

function mixtureLikelihoodRatio(effect: number, variance: number, tau: number): number {
  if (variance <= 0 || !Number.isFinite(variance)) return 0;
  const tauSquared = tau * tau;
  const scale = Math.sqrt(variance / (variance + tauSquared));
  const exponent = (tauSquared * effect * effect) / (2 * variance * (variance + tauSquared));
  return scale * Math.exp(exponent);
}

/**
 * Always-valid confidence interval: the set of null values that would not be
 * rejected. Inverting the mSPRT threshold gives a closed form.
 */
function alwaysValidInterval(
  effect: number,
  variance: number,
  tau: number,
  alpha: number,
): [number, number] {
  const tauSquared = tau * tau;
  if (variance <= 0 || tauSquared <= 0) return [effect, effect];

  const ratio = (variance + tauSquared) / variance;
  const inner = (2 * variance * (variance + tauSquared) * Math.log(Math.sqrt(ratio) / alpha)) / tauSquared;

  if (inner <= 0) return [effect, effect];
  const halfWidth = Math.sqrt(inner);
  return [effect - halfWidth, effect + halfWidth];
}

function build(
  effect: number,
  variance: number,
  options: SequentialOptions,
): SequentialResult {
  const alpha = options.alpha ?? 0.05;
  const tau = options.tau ?? Math.sqrt(Math.max(variance, Number.EPSILON));

  const likelihoodRatio = mixtureLikelihoodRatio(effect, variance, tau);
  const alwaysValidPValue = Math.min(1, likelihoodRatio > 0 ? 1 / likelihoodRatio : 1);

  return {
    effect,
    standardError: Math.sqrt(Math.max(variance, 0)),
    likelihoodRatio,
    alwaysValidPValue,
    confidenceInterval: alwaysValidInterval(effect, variance, tau, alpha),
    significant: likelihoodRatio >= 1 / alpha,
  };
}

/** Sequential test for a continuous metric. */
export function sequentialTTest(
  control: ContinuousSample,
  treatment: ContinuousSample,
  options: SequentialOptions = {},
): SequentialResult {
  const variance = control.variance / control.n + treatment.variance / treatment.n;
  return build(treatment.mean - control.mean, variance, options);
}

/** Sequential test for a binary metric (conversion rate). */
export function sequentialProportionTest(
  control: BinarySample,
  treatment: BinarySample,
  options: SequentialOptions = {},
): SequentialResult {
  const pControl = control.conversions / control.n;
  const pTreatment = treatment.conversions / treatment.n;

  const variance =
    (pControl * (1 - pControl)) / control.n + (pTreatment * (1 - pTreatment)) / treatment.n;

  return build(pTreatment - pControl, variance, options);
}

/**
 * Tracks the running minimum of the always-valid p-value.
 *
 * The guarantee applies to the sequence, so the reported p-value should be the
 * smallest seen so far — otherwise a result that crossed the threshold earlier
 * would silently un-cross it as more data arrives.
 */
export class SequentialMonitor {
  #minimum = 1;

  update(result: SequentialResult): number {
    this.#minimum = Math.min(this.#minimum, result.alwaysValidPValue);
    return this.#minimum;
  }

  get pValue(): number {
    return this.#minimum;
  }

  hasCrossed(alpha = 0.05): boolean {
    return this.#minimum < alpha;
  }
}
