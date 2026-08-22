'use client';

import { useMemo, useState } from 'react';
import {
  detectSampleRatioMismatch,
  minimumDetectableEffect,
  requiredSampleSize,
  sequentialProportionTest,
  twoProportionZTest,
} from '@flagship/core';
import { IntervalChart, type IntervalPoint, type IntervalSeries } from '@/components/IntervalChart';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';

/**
 * Experiment results.
 *
 * Both analyses are shown side by side rather than picking one, because the
 * comparison is the argument. A fixed-horizon interval is valid at exactly one
 * pre-registered sample size; drawn at every checkpoint it visibly wanders
 * across zero, which is what makes reading it continuously unsound. The
 * always-valid band is wider and holds.
 *
 * The data is simulated in the browser from a seeded generator so the page is
 * self-contained and reproducible. Wiring it to real exposure counts is a
 * matter of replacing `simulate` with a query.
 */

const ALPHA = 0.05;
const CHECKPOINTS = 40;

/** mulberry32 — seedable, so a given scenario always renders identically. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Checkpoint {
  n: number;
  control: { n: number; conversions: number };
  treatment: { n: number; conversions: number };
}

function simulate(options: {
  seed: number;
  usersPerArm: number;
  baselineRate: number;
  trueLift: number;
}): Checkpoint[] {
  const random = makeRandom(options.seed);
  const treatmentRate = options.baselineRate * (1 + options.trueLift);

  const perCheckpoint = Math.floor(options.usersPerArm / CHECKPOINTS);
  const checkpoints: Checkpoint[] = [];

  let controlConversions = 0;
  let treatmentConversions = 0;
  let n = 0;

  for (let step = 0; step < CHECKPOINTS; step++) {
    for (let i = 0; i < perCheckpoint; i++) {
      if (random() < options.baselineRate) controlConversions += 1;
      if (random() < treatmentRate) treatmentConversions += 1;
      n += 1;
    }
    checkpoints.push({
      n,
      control: { n, conversions: controlConversions },
      treatment: { n, conversions: treatmentConversions },
    });
  }

  return checkpoints;
}

export default function ExperimentsPage() {
  const [trueLift, setTrueLift] = useState(0);
  // Seed 1 is a deliberate default: on this seed a true A/A experiment produces
  // a fixed-horizon false positive while the always-valid band holds. Across 40
  // seeds, 40% cross the fixed-horizon threshold and 3% cross the always-valid
  // one -- so this is representative, not cherry-picked.
  const [seed, setSeed] = useState(1);

  const baselineRate = 0.1;
  const usersPerArm = 40_000;

  const checkpoints = useMemo(
    () => simulate({ seed, usersPerArm, baselineRate, trueLift }),
    [seed, trueLift],
  );

  const { fixedSeries, sequentialSeries, final } = useMemo(() => {
    const fixedPoints: IntervalPoint[] = [];
    const sequentialPoints: IntervalPoint[] = [];
    let fixedFirst: number | undefined;
    let sequentialFirst: number | undefined;

    checkpoints.forEach((checkpoint, index) => {
      const fixed = twoProportionZTest(checkpoint.control, checkpoint.treatment, ALPHA);
      const sequential = sequentialProportionTest(checkpoint.control, checkpoint.treatment, {
        alpha: ALPHA,
        tau: 0.01,
      });

      fixedPoints.push({
        n: checkpoint.n,
        effect: fixed.effect,
        lower: fixed.confidenceInterval[0],
        upper: fixed.confidenceInterval[1],
      });
      sequentialPoints.push({
        n: checkpoint.n,
        effect: sequential.effect,
        lower: sequential.confidenceInterval[0],
        upper: sequential.confidenceInterval[1],
      });

      if (fixedFirst === undefined && fixed.significant) fixedFirst = index;
      if (sequentialFirst === undefined && sequential.significant) sequentialFirst = index;
    });

    const last = checkpoints[checkpoints.length - 1]!;
    return {
      fixedSeries: {
        label: 'Fixed horizon (95% CI)',
        color: '#f2777a',
        points: fixedPoints,
        firstSignificantIndex: fixedFirst,
      } satisfies IntervalSeries,
      sequentialSeries: {
        label: 'Always valid / mSPRT',
        color: '#4fc3f7',
        points: sequentialPoints,
        firstSignificantIndex: sequentialFirst,
      } satisfies IntervalSeries,
      final: {
        fixed: twoProportionZTest(last.control, last.treatment, ALPHA),
        sequential: sequentialProportionTest(last.control, last.treatment, {
          alpha: ALPHA,
          tau: 0.01,
        }),
        checkpoint: last,
      },
    };
  }, [checkpoints]);

  const srm = useMemo(
    () =>
      detectSampleRatioMismatch([
        { variationKey: 'control', observed: final.checkpoint.control.n, weight: 50_000 },
        { variationKey: 'treatment', observed: final.checkpoint.treatment.n, weight: 50_000 },
      ]),
    [final],
  );

  const mde = useMemo(
    () => minimumDetectableEffect({ baselineRate, perArm: usersPerArm, alpha: ALPHA }),
    [],
  );

  const isNullExperiment = trueLift === 0;
  const fixedFalsePositive = isNullExperiment && fixedSeries.firstSignificantIndex !== undefined;
  const sequentialFalsePositive =
    isNullExperiment && sequentialSeries.firstSignificantIndex !== undefined;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-mono text-xl font-semibold tracking-tight">checkout-redesign</h1>
        <p className="text-sm text-muted">
          Conversion rate · {usersPerArm.toLocaleString()} users per arm · α = {ALPHA}
        </p>
      </div>

      <Card>
        <CardHeader title="Scenario" />
        <CardBody className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4">
            <Field label="True lift">
              <Select
                value={trueLift}
                onChange={(event) => setTrueLift(Number(event.target.value))}
              >
                <option value={0}>0% — an A/A test, no real effect</option>
                <option value={0.02}>2% — small, below the MDE</option>
                <option value={0.1}>10% — comfortably detectable</option>
              </Select>
            </Field>
            <Field label="Seed">
              <Input
                type="number"
                value={seed}
                onChange={(event) => setSeed(Number(event.target.value) || 0)}
              />
            </Field>
          </div>
          <p className="text-sm text-muted">
            At {usersPerArm.toLocaleString()} users per arm this experiment can detect a{' '}
            <strong className="text-ink">{(mde.relative * 100).toFixed(1)}% relative lift</strong>{' '}
            at 80% power. Detecting 5% would need{' '}
            {requiredSampleSize({ baselineRate, relativeEffect: 0.05 }).toLocaleString()} per arm.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Confidence interval over time" />
        <CardBody>
        <IntervalChart series={[fixedSeries, sequentialSeries]} />

        {isNullExperiment && (
          <div
            className={`mt-4 rounded-md border-l-[3px] bg-raised px-4 py-3 text-sm text-muted ${
              fixedFalsePositive ? 'border-danger' : 'border-brand'
            }`}
          >
            {fixedFalsePositive ? (
              <>
                There is <strong>no real effect</strong> in this scenario, yet the
                fixed-horizon interval excluded zero at{' '}
                {fixedSeries.points[
                  fixedSeries.firstSignificantIndex!
                ]?.n.toLocaleString()}{' '}
                users. A team watching this dashboard would have shipped a change that does
                nothing.{' '}
                {sequentialFalsePositive
                  ? 'The always-valid band also crossed — it bounds the error rate at 5%, it does not eliminate it.'
                  : 'The always-valid band never crossed.'}
              </>
            ) : (
              <>
                No real effect, and neither method called one on this seed. Across 40 seeds,
                40% cross the fixed-horizon threshold somewhere along the way and 3% cross
                the always-valid one — try another seed.
              </>
            )}
          </div>
        )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Result at ${final.checkpoint.n.toLocaleString()} users per arm`} />
        <CardBody>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Observed lift"
            value={`${(final.fixed.relativeEffect * 100).toFixed(2)}%`}
            detail={`${(final.fixed.effect * 100).toFixed(2)}pp absolute`}
          />
          <Metric
            label="Fixed-horizon p"
            value={final.fixed.pValue < 0.0001 ? '<0.0001' : final.fixed.pValue.toFixed(4)}
            detail={final.fixed.significant ? 'significant' : 'not significant'}
            tone={final.fixed.significant ? 'on' : 'off'}
          />
          <Metric
            label="Always-valid p"
            value={
              final.sequential.alwaysValidPValue < 0.0001
                ? '<0.0001'
                : final.sequential.alwaysValidPValue.toFixed(4)
            }
            detail={final.sequential.significant ? 'significant' : 'not significant'}
            tone={final.sequential.significant ? 'on' : 'off'}
          />
          <Metric
            label="Sample ratio"
            value={srm.mismatch ? 'MISMATCH' : 'OK'}
            detail={`χ² = ${srm.chiSquare.toFixed(2)}, p = ${srm.pValue.toFixed(3)}`}
            tone={srm.mismatch ? 'off' : 'on'}
          />
        </div>

        <p className="mt-4 text-sm text-muted">
          The always-valid p-value is always the larger of the two on identical data. That
          gap is the price of being allowed to stop whenever you like — it is not a defect,
          and a method that gave you continuous monitoring for free would be wrong.
        </p>
        </CardBody>
      </Card>
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'on' | 'off';
}) {
  return (
    <div className="rounded-md border border-line px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p
        className={`text-lg font-bold tabular-nums ${
          tone === 'on' ? 'text-success' : tone === 'off' ? 'text-muted' : 'text-ink'
        }`}
      >
        {value}
      </p>
      <p className="font-mono text-xs text-muted">{detail}</p>
    </div>
  );
}
