/**
 * Evaluation benchmark.
 *
 * Produces the ns/eval figure with its test conditions attached. A magnitude
 * without conditions is not a measurement — always report both.
 */
import { FlagshipClient } from '../src/client.ts';
import type { EvaluationContext, Flag, RulesetSnapshot } from '@flagship/core';

function makeFlag(index: number, ruleCount: number): Flag {
  return {
    key: `flag-${index}`,
    enabled: true,
    salt: `salt-${index}`,
    variations: [
      { key: 'control', value: false },
      { key: 'treatment', value: true },
      { key: 'off', value: false },
    ],
    defaultVariationKey: 'control',
    offVariationKey: 'off',
    prerequisites: [],
    bucketBy: 'key',
    rules: Array.from({ length: ruleCount }, (_, r) => ({
      id: `flag-${index}-rule-${r}`,
      description: '',
      when: {
        kind: 'and' as const,
        children: [
          {
            kind: 'condition' as const,
            attribute: 'plan',
            operator: 'eq' as const,
            values: [`plan-${r}`],
            visibility: 'client' as const,
          },
          {
            kind: 'or' as const,
            children: [
              {
                kind: 'condition' as const,
                attribute: 'region',
                operator: 'in' as const,
                values: ['us', 'eu', 'apac'],
                visibility: 'client' as const,
              },
              {
                kind: 'condition' as const,
                attribute: 'version',
                operator: 'semverGt' as const,
                values: ['2.0.0'],
                visibility: 'client' as const,
              },
            ],
          },
        ],
      },
      serve: {
        rollout: [
          { variationKey: 'control', weight: 50_000 },
          { variationKey: 'treatment', weight: 50_000 },
        ],
      },
    })),
  };
}

const FLAG_COUNT = 200;
const RULES_PER_FLAG = 5;

const bootstrap: RulesetSnapshot = {
  environmentKey: 'production',
  version: 1,
  flags: Array.from({ length: FLAG_COUNT }, (_, i) => makeFlag(i, RULES_PER_FLAG)),
  segments: [],
  servedAt: new Date().toISOString(),
};

const client = new FlagshipClient({ sdkKey: 'bench', baseUrl: 'http://localhost', bootstrap });

const contexts: EvaluationContext[] = Array.from({ length: 1000 }, (_, i) => ({
  key: `user-${i}`,
  attributes: { plan: `plan-${i % RULES_PER_FLAG}`, region: 'eu', version: '3.1.0' },
}));

function run(label: string, iterations: number, fn: (i: number) => void): void {
  // Warm up so JIT compilation is not counted.
  for (let i = 0; i < Math.min(iterations, 50_000); i++) fn(i);

  const started = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn(i);
  const elapsedNs = Number(process.hrtime.bigint() - started);

  const perOp = elapsedNs / iterations;
  const opsPerSec = 1e9 / perOp;
  console.log(
    `${label.padEnd(34)} ${perOp.toFixed(1).padStart(8)} ns/op   ${(opsPerSec / 1e6).toFixed(2).padStart(7)} M ops/sec`,
  );
}

const ITERATIONS = 2_000_000;

console.log('Flagship evaluation benchmark');
console.log(`  node        ${process.version}`);
console.log(`  platform    ${process.platform} ${process.arch}`);
console.log(`  ruleset     ${FLAG_COUNT} flags x ${RULES_PER_FLAG} rules, in-process, no network I/O`);
console.log(`  iterations  ${ITERATIONS.toLocaleString()}\n`);

// Worst case: every rule is examined before falling through to the default.
run('miss all rules -> default', ITERATIONS, (i) => {
  client.evaluate('flag-7', { key: `user-${i % 1000}`, attributes: { plan: 'none' } }, false);
});

// Typical case: matches the first rule and buckets into a rollout.
run('match first rule + rollout', ITERATIONS, (i) => {
  client.evaluate('flag-7', contexts[i % 1000]!, false);
});

// The boolean convenience path most callers actually use.
run('isEnabled', ITERATIONS, (i) => {
  client.isEnabled('flag-7', contexts[i % 1000]!);
});

// Flag lookup across the whole ruleset, to show indexing is O(1) in flag count.
run('varying flag key (200 flags)', ITERATIONS, (i) => {
  client.evaluate(`flag-${i % FLAG_COUNT}`, contexts[i % 1000]!, false);
});
