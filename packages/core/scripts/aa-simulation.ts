/**
 * A/A simulation: measures the peeking problem instead of asserting it.
 *
 * Runs N experiments in which both arms are drawn from the SAME distribution.
 * There is no true effect, so every "significant" result is a false positive.
 *
 * Three analysis strategies are compared:
 *
 *   1. Fixed horizon, inspected once at the end. Correct usage. Should sit at
 *      the nominal alpha (5%).
 *   2. Fixed horizon, inspected continuously, stopping at the first significant
 *      look. This is what most teams actually do. The false positive rate is
 *      far above 5%.
 *   3. mSPRT, inspected continuously with the same stopping rule. Always-valid,
 *      so it should hold at or below alpha.
 *
 * Deterministic: a seeded PRNG means the reported numbers are reproducible.
 */
import { twoProportionZTest } from '../src/stats/frequentist.ts';
import { sequentialProportionTest } from '../src/stats/sequential.ts';

/** mulberry32 — small, fast, and seedable. */
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

const EXPERIMENTS = 1000;
const USERS_PER_ARM = 20_000;
const BASELINE_RATE = 0.1;
const ALPHA = 0.05;
/** How often a team checks the dashboard, in users per arm. */
const PEEK_INTERVAL = 500;
/** Peeking only begins once there is enough data to be worth looking at. */
const MIN_SAMPLE_BEFORE_PEEKING = 1000;

const random = makeRandom(0xa1a5eed);

interface Counters {
  fixedAtEnd: number;
  fixedPeeking: number;
  sequentialPeeking: number;
}

const falsePositives: Counters = { fixedAtEnd: 0, fixedPeeking: 0, sequentialPeeking: 0 };
/** How many looks it took before a peeking false positive fired. */
const peekStoppingPoints: number[] = [];

for (let experiment = 0; experiment < EXPERIMENTS; experiment++) {
  let controlConversions = 0;
  let treatmentConversions = 0;

  let fixedPeekingFired = false;
  let sequentialPeekingFired = false;
  let looks = 0;

  for (let n = 1; n <= USERS_PER_ARM; n++) {
    // Both arms draw from the same Bernoulli. There is no effect to find.
    if (random() < BASELINE_RATE) controlConversions += 1;
    if (random() < BASELINE_RATE) treatmentConversions += 1;

    const isPeekPoint = n >= MIN_SAMPLE_BEFORE_PEEKING && n % PEEK_INTERVAL === 0;
    if (!isPeekPoint) continue;

    looks += 1;
    const control = { n, conversions: controlConversions };
    const treatment = { n, conversions: treatmentConversions };

    // Strategy 2: stop at the first significant fixed-horizon look.
    if (!fixedPeekingFired) {
      if (twoProportionZTest(control, treatment, ALPHA).significant) {
        fixedPeekingFired = true;
        peekStoppingPoints.push(looks);
      }
    }

    // Strategy 3: same stopping rule, always-valid test.
    if (!sequentialPeekingFired) {
      // tau is set near a plausible effect size, as the docs advise.
      const tau = 0.01;
      if (sequentialProportionTest(control, treatment, { alpha: ALPHA, tau }).significant) {
        sequentialPeekingFired = true;
      }
    }
  }

  // Strategy 1: one look, at the pre-registered horizon.
  const finalControl = { n: USERS_PER_ARM, conversions: controlConversions };
  const finalTreatment = { n: USERS_PER_ARM, conversions: treatmentConversions };
  if (twoProportionZTest(finalControl, finalTreatment, ALPHA).significant) {
    falsePositives.fixedAtEnd += 1;
  }

  if (fixedPeekingFired) falsePositives.fixedPeeking += 1;
  if (sequentialPeekingFired) falsePositives.sequentialPeeking += 1;
}

const rate = (count: number): string => `${((count / EXPERIMENTS) * 100).toFixed(1)}%`;
const looksPerExperiment = Math.floor((USERS_PER_ARM - MIN_SAMPLE_BEFORE_PEEKING) / PEEK_INTERVAL) + 1;

console.log('A/A simulation — both arms drawn from the same distribution');
console.log(`  experiments      ${EXPERIMENTS}`);
console.log(`  users per arm    ${USERS_PER_ARM.toLocaleString()}`);
console.log(`  baseline rate    ${BASELINE_RATE}`);
console.log(`  alpha            ${ALPHA}`);
console.log(`  looks per expt   ${looksPerExperiment} (every ${PEEK_INTERVAL} users)\n`);

console.log('  There is no true effect, so every rejection below is a false positive.\n');

console.log(`  fixed horizon, one look at the end   ${rate(falsePositives.fixedAtEnd).padStart(6)}   (nominal ${ALPHA * 100}%)`);
console.log(`  fixed horizon, peeking continuously  ${rate(falsePositives.fixedPeeking).padStart(6)}   <- the trap`);
console.log(`  mSPRT, peeking continuously          ${rate(falsePositives.sequentialPeeking).padStart(6)}   <- always valid`);

if (peekStoppingPoints.length > 0) {
  const median = peekStoppingPoints.slice().sort((a, b) => a - b)[
    Math.floor(peekStoppingPoints.length / 2)
  ]!;
  console.log(`\n  When naive peeking fired, it did so at look ${median} of ${looksPerExperiment} (median).`);
  console.log('  Stopping there would have shipped a change that does nothing.');
}
