import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileRuleset, RulesetValidationError, type FlagRow } from './ruleset.ts';

function flagRow(overrides: Partial<FlagRow> = {}): FlagRow {
  return {
    key: 'checkout',
    salt: 'salt-a',
    bucket_by: 'key',
    variations: [
      { key: 'on', value: true },
      { key: 'off', value: false },
    ],
    enabled: true,
    default_variation_key: 'off',
    off_variation_key: 'off',
    rules: [],
    prerequisites: [],
    ...overrides,
  };
}

const clientCondition = {
  kind: 'condition',
  attribute: 'plan',
  operator: 'eq',
  values: ['pro'],
  visibility: 'client',
};

const serverCondition = {
  kind: 'condition',
  attribute: 'email',
  operator: 'endsWith',
  values: ['@competitor.com'],
  visibility: 'server',
};

function compile(flags: FlagRow[], segments: { key: string; rule_tree: unknown }[] = []) {
  return compileRuleset({
    environmentKey: 'production',
    version: 1,
    flags,
    segments,
    servedAt: '2026-08-20T00:00:00.000Z',
  });
}

describe('compileRuleset', () => {
  it('produces both payloads', () => {
    const result = compile([flagRow()]);
    assert.equal(result.server.environmentKey, 'production');
    assert.equal(result.server.version, 1);
    assert.equal(result.server.flags.length, 1);
    assert.equal(result.client.flags.length, 1);
  });

  it('strips server-only rules from the client payload only', () => {
    const result = compile([
      flagRow({
        rules: [
          { id: 'r1', description: '', when: serverCondition, serve: { variationKey: 'on' } },
          { id: 'r2', description: '', when: clientCondition, serve: { variationKey: 'on' } },
        ],
      }),
    ]);

    assert.equal(result.server.flags[0]!.rules.length, 2);
    assert.equal(result.client.flags[0]!.rules.length, 1);
    assert.equal(
      JSON.stringify(result.client).includes('@competitor.com'),
      false,
      'server-only value must not reach the client payload',
    );
  });
});

describe('compileRuleset — validation', () => {
  function expectProblem(build: () => unknown, pattern: RegExp): void {
    try {
      build();
      assert.fail('expected a RulesetValidationError');
    } catch (error) {
      assert.ok(error instanceof RulesetValidationError, `wrong error type: ${String(error)}`);
      assert.ok(
        error.problems.some((problem) => pattern.test(problem)),
        `no problem matched ${pattern}; got: ${error.problems.join(' | ')}`,
      );
    }
  }

  it('rejects a default variation that is not declared', () => {
    expectProblem(
      () => compile([flagRow({ default_variation_key: 'ghost' })]),
      /defaultVariationKey is not a declared variation/,
    );
  });

  it('rejects a rule serving an undeclared variation', () => {
    expectProblem(
      () =>
        compile([
          flagRow({
            rules: [
              { id: 'r1', description: '', when: clientCondition, serve: { variationKey: 'ghost' } },
            ],
          }),
        ]),
      /serves undeclared variation/,
    );
  });

  it('rejects rollout weights that do not sum to 100000', () => {
    expectProblem(
      () =>
        compile([
          flagRow({
            rules: [
              {
                id: 'r1',
                description: '',
                when: clientCondition,
                serve: {
                  rollout: [
                    { variationKey: 'on', weight: 40_000 },
                    { variationKey: 'off', weight: 40_000 },
                  ],
                },
              },
            ],
          }),
        ]),
      /summing to 100000/,
    );
  });

  it('rejects a reference to a segment that does not exist', () => {
    expectProblem(
      () =>
        compile([
          flagRow({
            rules: [
              {
                id: 'r1',
                description: '',
                when: { kind: 'segment', segmentKey: 'ghost', negate: false },
                serve: { variationKey: 'on' },
              },
            ],
          }),
        ]),
      /references unknown segment "ghost"/,
    );
  });

  it('rejects a condition with no visibility rather than guessing', () => {
    // Guessing "client" would publish a server-only rule to browsers.
    expectProblem(
      () =>
        compile([
          flagRow({
            rules: [
              {
                id: 'r1',
                description: '',
                when: { kind: 'condition', attribute: 'plan', operator: 'eq', values: ['pro'] },
                serve: { variationKey: 'on' },
              },
            ],
          }),
        ]),
      /visibility/,
    );
  });

  it('rejects an unknown node kind', () => {
    expectProblem(
      () =>
        compile([
          flagRow({
            rules: [
              { id: 'r1', description: '', when: { kind: 'xor', children: [] }, serve: { variationKey: 'on' } },
            ],
          }),
        ]),
      /unknown node kind/,
    );
  });

  it('rejects a prerequisite pointing at a flag that does not exist', () => {
    expectProblem(
      () => compile([flagRow({ prerequisites: [{ flagKey: 'ghost', variationKey: 'on' }] })]),
      /prerequisite "ghost" does not exist/,
    );
  });

  it('rejects a prerequisite cycle', () => {
    expectProblem(
      () =>
        compile([
          flagRow({ key: 'a', prerequisites: [{ flagKey: 'b', variationKey: 'on' }] }),
          flagRow({ key: 'b', prerequisites: [{ flagKey: 'a', variationKey: 'on' }] }),
        ]),
      /prerequisite cycle/,
    );
  });

  it('accepts a valid prerequisite chain', () => {
    assert.doesNotThrow(() =>
      compile([
        flagRow({ key: 'a', prerequisites: [{ flagKey: 'b', variationKey: 'on' }] }),
        flagRow({ key: 'b', prerequisites: [{ flagKey: 'c', variationKey: 'on' }] }),
        flagRow({ key: 'c' }),
      ]),
    );
  });

  it('rejects a rule tree nested past the depth limit', () => {
    // Guards both this validator and every SDK against a stack-overflow payload.
    let node: unknown = clientCondition;
    for (let i = 0; i < 40; i++) node = { kind: 'and', children: [node] };

    expectProblem(
      () =>
        compile([
          flagRow({ rules: [{ id: 'r1', description: '', when: node, serve: { variationKey: 'on' } }] }),
        ]),
      /nested deeper than 32 levels/,
    );
  });

  it('reports every problem at once, not just the first', () => {
    try {
      compile([flagRow({ default_variation_key: 'ghost', off_variation_key: 'also-ghost' })]);
      assert.fail('expected an error');
    } catch (error) {
      assert.ok(error instanceof RulesetValidationError);
      assert.ok(error.problems.length >= 2, `got ${error.problems.length} problems`);
    }
  });
});
