import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  chiSquarePValue,
  logGamma,
  normalCdf,
  normalQuantile,
  studentTTwoSidedPValue,
} from './distributions.ts';
import {
  RunningStats,
  minimumDetectableEffect,
  requiredSampleSize,
  twoProportionZTest,
  welchTTest,
} from './frequentist.ts';
import { SequentialMonitor, sequentialProportionTest } from './sequential.ts';
import { detectSampleRatioMismatch } from './srm.ts';

/** Assert approximate equality, since these are numerical approximations. */
function close(actual: number, expected: number, tolerance: number, label = ''): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label} expected ${expected} +/- ${tolerance}, got ${actual}`,
  );
}

describe('distributions', () => {
  it('computes logGamma against known values', () => {
    close(logGamma(1), 0, 1e-9, 'logGamma(1)=log(0!)=0');
    close(logGamma(5), Math.log(24), 1e-9, 'logGamma(5)=log(4!)');
    close(logGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-9, 'logGamma(1/2)=log(sqrt(pi))');
  });

  it('computes the normal CDF against published values', () => {
    close(normalCdf(0), 0.5, 1e-9);
    close(normalCdf(1.96), 0.975, 1e-4, 'the canonical 1.96');
    close(normalCdf(-1.96), 0.025, 1e-4);
    close(normalCdf(1), 0.8413447, 1e-5);
    close(normalCdf(2.5758), 0.995, 1e-4);
  });

  it('inverts the normal CDF', () => {
    close(normalQuantile(0.975), 1.959964, 1e-4);
    close(normalQuantile(0.8), 0.8416212, 1e-4);
    close(normalQuantile(0.5), 0, 1e-9);
    // Round-trips.
    for (const p of [0.001, 0.01, 0.25, 0.5, 0.75, 0.99, 0.999]) {
      close(normalCdf(normalQuantile(p)), p, 1e-4, `round-trip p=${p}`);
    }
  });

  it('computes Student t p-values against published values', () => {
    // t=2.228 at df=10 is the two-sided 5% critical value.
    close(studentTTwoSidedPValue(2.228, 10), 0.05, 1e-3);
    // t=1.96 at large df approaches the normal.
    close(studentTTwoSidedPValue(1.959964, 100000), 0.05, 1e-3);
    close(studentTTwoSidedPValue(0, 10), 1, 1e-9);
  });

  it('computes chi-square p-values against published values', () => {
    // 3.841 at df=1 is the 5% critical value; 5.991 at df=2.
    close(chiSquarePValue(3.841459, 1), 0.05, 1e-4);
    close(chiSquarePValue(5.991465, 2), 0.05, 1e-4);
    close(chiSquarePValue(0, 1), 1, 1e-9);
  });
});

describe('RunningStats', () => {
  it('matches a direct two-pass computation', () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    const running = new RunningStats();
    for (const value of values) running.push(value);

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
      values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);

    const sample = running.sample;
    assert.equal(sample.n, values.length);
    close(sample.mean, mean, 1e-12);
    close(sample.variance, variance, 1e-12);
  });
});

describe('welchTTest', () => {
  it('finds no effect when the arms are identical', () => {
    const arm = { n: 1000, mean: 10, variance: 4 };
    const result = welchTTest(arm, arm);
    close(result.effect, 0, 1e-12);
    close(result.pValue, 1, 1e-9);
    assert.equal(result.significant, false);
  });

  it('detects a large, well-separated effect', () => {
    const control = { n: 1000, mean: 10, variance: 4 };
    const treatment = { n: 1000, mean: 11, variance: 4 };
    const result = welchTTest(control, treatment);

    close(result.effect, 1, 1e-12);
    assert.ok(result.pValue < 1e-10, `expected a tiny p-value, got ${result.pValue}`);
    assert.equal(result.significant, true);
    // The interval must exclude zero when the result is significant.
    assert.ok(result.confidenceInterval[0] > 0);
  });

  it('handles unequal variances, which is the point of Welch', () => {
    const control = { n: 100, mean: 10, variance: 1 };
    const treatment = { n: 1000, mean: 10.5, variance: 100 };
    const result = welchTTest(control, treatment);
    assert.ok(Number.isFinite(result.pValue));
    assert.ok(result.pValue > 0 && result.pValue <= 1);
  });

  it('degrades safely on zero variance', () => {
    const arm = { n: 10, mean: 5, variance: 0 };
    const result = welchTTest(arm, arm);
    assert.equal(result.pValue, 1);
    assert.equal(result.significant, false);
  });
});

describe('twoProportionZTest', () => {
  it('detects a clear conversion-rate difference', () => {
    const control = { n: 10_000, conversions: 1000 }; // 10%
    const treatment = { n: 10_000, conversions: 1200 }; // 12%
    const result = twoProportionZTest(control, treatment);

    close(result.effect, 0.02, 1e-12);
    close(result.relativeEffect, 0.2, 1e-9, '20% relative lift');
    assert.ok(result.pValue < 0.001);
    assert.equal(result.significant, true);
  });

  it('finds nothing when the rates match', () => {
    const control = { n: 10_000, conversions: 1000 };
    const treatment = { n: 10_000, conversions: 1000 };
    const result = twoProportionZTest(control, treatment);
    // Tolerance tracks the erf approximation's documented ~1.5e-7 max error.
    close(result.pValue, 1, 1e-6);
    assert.equal(result.significant, false);
    // Interval must straddle zero.
    assert.ok(result.confidenceInterval[0] < 0 && result.confidenceInterval[1] > 0);
  });

  it('is underpowered at small n, and says so', () => {
    const control = { n: 100, conversions: 10 };
    const treatment = { n: 100, conversions: 12 };
    const result = twoProportionZTest(control, treatment);
    assert.equal(result.significant, false, 'a 2pp difference at n=100 is not detectable');
  });
});

describe('minimumDetectableEffect', () => {
  it('shrinks as the square root of sample size', () => {
    const small = minimumDetectableEffect({ baselineRate: 0.1, perArm: 1000 });
    const large = minimumDetectableEffect({ baselineRate: 0.1, perArm: 4000 });
    // 4x the sample halves the MDE.
    close(large.absolute, small.absolute / 2, small.absolute * 0.01);
  });

  it('round-trips with requiredSampleSize', () => {
    const perArm = requiredSampleSize({ baselineRate: 0.1, relativeEffect: 0.05 });
    const mde = minimumDetectableEffect({ baselineRate: 0.1, perArm });
    close(mde.relative, 0.05, 0.001, 'sample size and MDE must agree');
  });

  it('matches a textbook figure', () => {
    // 10% baseline, detect a 10% relative lift at 80% power / 5% alpha:
    // roughly 14,750 users per arm.
    const n = requiredSampleSize({ baselineRate: 0.1, relativeEffect: 0.1 });
    assert.ok(n > 13_000 && n < 16_000, `expected ~14.7k per arm, got ${n}`);
  });
});

describe('detectSampleRatioMismatch', () => {
  it('accepts a healthy 50/50 split', () => {
    const result = detectSampleRatioMismatch([
      { variationKey: 'control', observed: 50_012, weight: 50_000 },
      { variationKey: 'treatment', observed: 49_988, weight: 50_000 },
    ]);
    assert.equal(result.mismatch, false);
    assert.ok(result.pValue > 0.05);
  });

  it('flags a split that is off by half a percent at scale', () => {
    // The motivating case: 50.4/49.6 over a million users looks fine to a human
    // and is overwhelming evidence of a bug.
    const result = detectSampleRatioMismatch([
      { variationKey: 'control', observed: 504_000, weight: 50_000 },
      { variationKey: 'treatment', observed: 496_000, weight: 50_000 },
    ]);
    assert.equal(result.mismatch, true);
    assert.ok(result.pValue < 1e-10, `expected overwhelming evidence, got p=${result.pValue}`);
  });

  it('respects uneven intended weights', () => {
    const result = detectSampleRatioMismatch([
      { variationKey: 'control', observed: 90_000, weight: 90_000 },
      { variationKey: 'treatment', observed: 10_000, weight: 10_000 },
    ]);
    assert.equal(result.mismatch, false);
    close(result.arms[0]!.deviation, 0, 1e-9);
  });

  it('handles more than two arms', () => {
    const result = detectSampleRatioMismatch([
      { variationKey: 'a', observed: 33_300, weight: 33_333 },
      { variationKey: 'b', observed: 33_400, weight: 33_333 },
      { variationKey: 'c', observed: 33_300, weight: 33_334 },
    ]);
    assert.equal(result.degreesOfFreedom, 2);
    assert.equal(result.mismatch, false);
  });

  it('does not alarm on no data', () => {
    const result = detectSampleRatioMismatch([
      { variationKey: 'a', observed: 0, weight: 50_000 },
      { variationKey: 'b', observed: 0, weight: 50_000 },
    ]);
    assert.equal(result.mismatch, false);
  });
});

describe('sequential testing', () => {
  it('is more conservative than the fixed-horizon test on the same data', () => {
    // The core trade-off: you pay for the right to peek.
    const control = { n: 5000, conversions: 500 };
    const treatment = { n: 5000, conversions: 545 };

    const fixed = twoProportionZTest(control, treatment);
    const sequential = sequentialProportionTest(control, treatment);

    assert.ok(
      sequential.alwaysValidPValue > fixed.pValue,
      `sequential p (${sequential.alwaysValidPValue}) should exceed fixed p (${fixed.pValue})`,
    );
  });

  it('still detects a large true effect', () => {
    const control = { n: 20_000, conversions: 2000 };
    const treatment = { n: 20_000, conversions: 2600 };
    const result = sequentialProportionTest(control, treatment);
    assert.equal(result.significant, true);
    assert.ok(result.confidenceInterval[0] > 0, 'interval excludes zero');
  });

  it('produces a wider interval than the fixed-horizon one', () => {
    const control = { n: 10_000, conversions: 1000 };
    const treatment = { n: 10_000, conversions: 1100 };

    const fixed = twoProportionZTest(control, treatment);
    const sequential = sequentialProportionTest(control, treatment);

    const fixedWidth = fixed.confidenceInterval[1] - fixed.confidenceInterval[0];
    const sequentialWidth = sequential.confidenceInterval[1] - sequential.confidenceInterval[0];
    assert.ok(sequentialWidth > fixedWidth, 'always-valid intervals are wider by construction');
  });

  it('tracks a running minimum, so a crossing does not un-cross', () => {
    const monitor = new SequentialMonitor();
    monitor.update({
      effect: 0.1,
      standardError: 0.01,
      likelihoodRatio: 100,
      alwaysValidPValue: 0.01,
      confidenceInterval: [0.05, 0.15],
      significant: true,
    });
    assert.equal(monitor.hasCrossed(0.05), true);

    monitor.update({
      effect: 0.001,
      standardError: 0.01,
      likelihoodRatio: 1,
      alwaysValidPValue: 0.9,
      confidenceInterval: [-0.02, 0.02],
      significant: false,
    });
    assert.equal(monitor.pValue, 0.01, 'the minimum is retained');
    assert.equal(monitor.hasCrossed(0.05), true);
  });
});
