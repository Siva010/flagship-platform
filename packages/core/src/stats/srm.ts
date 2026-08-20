import { chiSquarePValue } from './distributions.ts';

/**
 * Sample Ratio Mismatch detection.
 *
 * If a 50/50 experiment delivers 50.4% / 49.6% over a million users, something
 * is broken — a redirect that drops one arm, a bot filter that hits one
 * variation harder, an SDK that fails open. The traffic split is the one thing
 * you control exactly, so a deviation is evidence of a bug upstream of the
 * metric.
 *
 * This matters because SRM invalidates the experiment entirely. Whatever
 * mechanism dropped users was probably not random, so the arms are no longer
 * comparable and no amount of statistical machinery downstream can fix it. The
 * correct response to an SRM alarm is to stop and debug, not to interpret the
 * result.
 *
 * A chi-square goodness-of-fit test against expected counts. Convention is to
 * alarm at p < 0.0005 rather than 0.05: this runs on every experiment
 * continuously, so a 5% threshold would cry wolf constantly.
 */

export const SRM_ALARM_THRESHOLD = 0.0005;

export interface SrmArm {
  variationKey: string;
  observed: number;
  /** Intended share of traffic, in basis points of 100000 — the rollout weight. */
  weight: number;
}

export interface SrmResult {
  chiSquare: number;
  degreesOfFreedom: number;
  pValue: number;
  /** True when the split deviates more than chance explains. The experiment is not trustworthy. */
  mismatch: boolean;
  arms: {
    variationKey: string;
    observed: number;
    expected: number;
    /** Observed minus expected, as a fraction of expected. */
    deviation: number;
  }[];
}

export function detectSampleRatioMismatch(
  arms: readonly SrmArm[],
  threshold = SRM_ALARM_THRESHOLD,
): SrmResult {
  const totalObserved = arms.reduce((sum, arm) => sum + arm.observed, 0);
  const totalWeight = arms.reduce((sum, arm) => sum + arm.weight, 0);

  const detail = arms.map((arm) => {
    const expected = totalWeight === 0 ? 0 : (arm.weight / totalWeight) * totalObserved;
    return {
      variationKey: arm.variationKey,
      observed: arm.observed,
      expected,
      deviation: expected === 0 ? 0 : (arm.observed - expected) / expected,
    };
  });

  // Not enough data, or a degenerate split: no meaningful test.
  if (arms.length < 2 || totalObserved === 0 || totalWeight === 0) {
    return {
      chiSquare: 0,
      degreesOfFreedom: Math.max(arms.length - 1, 0),
      pValue: 1,
      mismatch: false,
      arms: detail,
    };
  }

  let chiSquare = 0;
  for (const arm of detail) {
    if (arm.expected <= 0) continue;
    const difference = arm.observed - arm.expected;
    chiSquare += (difference * difference) / arm.expected;
  }

  const degreesOfFreedom = arms.length - 1;
  const pValue = chiSquarePValue(chiSquare, degreesOfFreedom);

  return {
    chiSquare,
    degreesOfFreedom,
    pValue,
    mismatch: pValue < threshold,
    arms: detail,
  };
}
