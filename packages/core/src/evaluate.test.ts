import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateFlag, indexSnapshot } from './evaluate.ts';
import type { Flag, RulesetSnapshot, Segment, TargetingRule } from './types.ts';

function flag(overrides: Partial<Flag> & Pick<Flag, 'key'>): Flag {
  return {
    enabled: true,
    salt: 'salt-a',
    variations: [
      { key: 'on', value: true },
      { key: 'off', value: false },
    ],
    defaultVariationKey: 'off',
    offVariationKey: 'off',
    prerequisites: [],
    rules: [],
    bucketBy: 'key',
    ...overrides,
  };
}

function snapshot(flags: Flag[], segments: Segment[] = []): RulesetSnapshot {
  return {
    environmentKey: 'production',
    version: 1,
    flags,
    segments,
    servedAt: '2026-08-20T00:00:00.000Z',
  };
}

const ctx = (key: string, attributes: Record<string, string | number | boolean> = {}) => ({
  key,
  attributes,
});

describe('evaluateFlag — basics', () => {
  it('serves the off variation when the flag is disabled', () => {
    const env = indexSnapshot(snapshot([flag({ key: 'f', enabled: false })]));
    const result = evaluateFlag('f', ctx('u1'), env, 'FALLBACK');
    assert.equal(result.value, false);
    assert.equal(result.variationKey, 'off');
    assert.deepEqual(result.reason, { kind: 'off' });
  });

  it('serves the default variation when no rule matches', () => {
    const env = indexSnapshot(snapshot([flag({ key: 'f', defaultVariationKey: 'on' })]));
    const result = evaluateFlag('f', ctx('u1'), env, 'FALLBACK');
    assert.equal(result.value, true);
    assert.deepEqual(result.reason, { kind: 'default' });
  });

  it('returns the fallback and an error reason for an unknown flag', () => {
    const env = indexSnapshot(snapshot([]));
    const result = evaluateFlag('missing', ctx('u1'), env, 'FALLBACK');
    assert.equal(result.value, 'FALLBACK');
    assert.equal(result.reason.kind, 'error');
  });

  it('returns the fallback when a rule serves a variation that does not exist', () => {
    const env = indexSnapshot(
      snapshot([
        flag({
          key: 'f',
          rules: [
            {
              id: 'r1',
              description: '',
              when: { kind: 'and', children: [] },
              serve: { variationKey: 'nonexistent' },
            },
          ],
        }),
      ]),
    );
    const result = evaluateFlag('f', ctx('u1'), env, 'FALLBACK');
    assert.equal(result.value, 'FALLBACK');
    assert.equal(result.reason.kind, 'error');
  });
});

describe('evaluateFlag — targeting', () => {
  const rule = (when: TargetingRule['when']): TargetingRule => ({
    id: 'r1',
    description: '',
    when,
    serve: { variationKey: 'on' },
  });

  it('matches a simple condition', () => {
    const env = indexSnapshot(
      snapshot([
        flag({
          key: 'f',
          rules: [
            rule({
              kind: 'condition',
              attribute: 'plan',
              operator: 'eq',
              values: ['enterprise'],
              visibility: 'client',
            }),
          ],
        }),
      ]),
    );
    assert.equal(evaluateFlag('f', ctx('u1', { plan: 'enterprise' }), env, false).value, true);
    assert.equal(evaluateFlag('f', ctx('u1', { plan: 'free' }), env, false).value, false);
  });

  it('evaluates nested AND/OR/NOT trees', () => {
    const env = indexSnapshot(
      snapshot([
        flag({
          key: 'f',
          rules: [
            rule({
              kind: 'and',
              children: [
                {
                  kind: 'condition',
                  attribute: 'plan',
                  operator: 'eq',
                  values: ['enterprise'],
                  visibility: 'client',
                },
                {
                  kind: 'or',
                  children: [
                    {
                      kind: 'condition',
                      attribute: 'region',
                      operator: 'in',
                      values: ['eu', 'uk'],
                      visibility: 'client',
                    },
                    {
                      kind: 'condition',
                      attribute: 'beta',
                      operator: 'eq',
                      values: [true],
                      visibility: 'client',
                    },
                  ],
                },
                {
                  kind: 'not',
                  children: [
                    {
                      kind: 'condition',
                      attribute: 'suspended',
                      operator: 'eq',
                      values: [true],
                      visibility: 'client',
                    },
                  ],
                },
              ],
            }),
          ],
        }),
      ]),
    );

    const on = (attrs: Record<string, string | number | boolean>) =>
      evaluateFlag('f', ctx('u1', attrs), env, false).value;

    assert.equal(on({ plan: 'enterprise', region: 'eu' }), true);
    assert.equal(on({ plan: 'enterprise', beta: true }), true);
    assert.equal(on({ plan: 'enterprise', region: 'us' }), false, 'region and beta both fail');
    assert.equal(on({ plan: 'free', region: 'eu' }), false, 'plan fails');
    assert.equal(
      on({ plan: 'enterprise', region: 'eu', suspended: true }),
      false,
      'NOT clause excludes',
    );
  });

  it('takes the first matching rule in declaration order', () => {
    const env = indexSnapshot(
      snapshot([
        flag({
          key: 'f',
          variations: [
            { key: 'a', value: 'A' },
            { key: 'b', value: 'B' },
            { key: 'off', value: 'OFF' },
          ],
          rules: [
            {
              id: 'first',
              description: '',
              when: { kind: 'and', children: [] },
              serve: { variationKey: 'a' },
            },
            {
              id: 'second',
              description: '',
              when: { kind: 'and', children: [] },
              serve: { variationKey: 'b' },
            },
          ],
        }),
      ]),
    );
    const result = evaluateFlag('f', ctx('u1'), env, 'FALLBACK');
    assert.equal(result.value, 'A');
    assert.deepEqual(result.reason, { kind: 'ruleMatch', ruleId: 'first' });
  });
});

describe('evaluateFlag — segments', () => {
  it('resolves a segment reference', () => {
    const env = indexSnapshot(
      snapshot(
        [
          flag({
            key: 'f',
            rules: [
              {
                id: 'r1',
                description: '',
                when: { kind: 'segment', segmentKey: 'employees', negate: false },
                serve: { variationKey: 'on' },
              },
            ],
          }),
        ],
        [
          {
            key: 'employees',
            when: {
              kind: 'condition',
              attribute: 'email',
              operator: 'endsWith',
              values: ['@flagship.dev'],
              visibility: 'server',
            },
          },
        ],
      ),
    );
    assert.equal(evaluateFlag('f', ctx('u1', { email: 'a@flagship.dev' }), env, false).value, true);
    assert.equal(evaluateFlag('f', ctx('u2', { email: 'a@other.com' }), env, false).value, false);
  });

  it('supports a negated segment', () => {
    const env = indexSnapshot(
      snapshot(
        [
          flag({
            key: 'f',
            rules: [
              {
                id: 'r1',
                description: '',
                when: { kind: 'segment', segmentKey: 'banned', negate: true },
                serve: { variationKey: 'on' },
              },
            ],
          }),
        ],
        [
          {
            key: 'banned',
            when: {
              kind: 'condition',
              attribute: 'status',
              operator: 'eq',
              values: ['banned'],
              visibility: 'server',
            },
          },
        ],
      ),
    );
    assert.equal(evaluateFlag('f', ctx('u1', { status: 'ok' }), env, false).value, true);
    assert.equal(evaluateFlag('f', ctx('u2', { status: 'banned' }), env, false).value, false);
  });

  it('fails closed on an unknown segment', () => {
    const env = indexSnapshot(
      snapshot([
        flag({
          key: 'f',
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
    );
    assert.equal(evaluateFlag('f', ctx('u1'), env, false).value, false);
  });

  it('terminates on a self-referential segment instead of overflowing the stack', () => {
    // A malformed ruleset must not take down the host application.
    const env = indexSnapshot(
      snapshot(
        [
          flag({
            key: 'f',
            rules: [
              {
                id: 'r1',
                description: '',
                when: { kind: 'segment', segmentKey: 'loop-a', negate: false },
                serve: { variationKey: 'on' },
              },
            ],
          }),
        ],
        [
          { key: 'loop-a', when: { kind: 'segment', segmentKey: 'loop-b', negate: false } },
          { key: 'loop-b', when: { kind: 'segment', segmentKey: 'loop-a', negate: false } },
        ],
      ),
    );
    const result = evaluateFlag('f', ctx('u1'), env, false);
    assert.equal(result.value, false);
  });
});

describe('evaluateFlag — prerequisites', () => {
  it('serves off when a prerequisite is not met', () => {
    const env = indexSnapshot(
      snapshot([
        flag({ key: 'gate', enabled: false }),
        flag({
          key: 'f',
          defaultVariationKey: 'on',
          prerequisites: [{ flagKey: 'gate', variationKey: 'on' }],
        }),
      ]),
    );
    const result = evaluateFlag('f', ctx('u1'), env, 'FALLBACK');
    assert.equal(result.value, false);
    assert.deepEqual(result.reason, { kind: 'prerequisiteFailed', flagKey: 'gate' });
  });

  it('evaluates normally when the prerequisite is met', () => {
    const env = indexSnapshot(
      snapshot([
        flag({ key: 'gate', defaultVariationKey: 'on' }),
        flag({
          key: 'f',
          defaultVariationKey: 'on',
          prerequisites: [{ flagKey: 'gate', variationKey: 'on' }],
        }),
      ]),
    );
    assert.equal(evaluateFlag('f', ctx('u1'), env, 'FALLBACK').value, true);
  });

  it('detects a prerequisite cycle instead of recursing forever', () => {
    const env = indexSnapshot(
      snapshot([
        flag({ key: 'a', prerequisites: [{ flagKey: 'b', variationKey: 'on' }] }),
        flag({ key: 'b', prerequisites: [{ flagKey: 'a', variationKey: 'on' }] }),
      ]),
    );
    const result = evaluateFlag('a', ctx('u1'), env, 'FALLBACK');
    // The cycle is caught; the flag falls back to its off variation rather than
    // crashing the host.
    assert.ok(result.reason.kind === 'prerequisiteFailed' || result.reason.kind === 'error');
  });
});

describe('evaluateFlag — rollouts', () => {
  const rolloutFlag = flag({
    key: 'f',
    variations: [
      { key: 'control', value: 'C' },
      { key: 'treatment', value: 'T' },
      { key: 'off', value: 'OFF' },
    ],
    rules: [
      {
        id: 'r1',
        description: '',
        when: { kind: 'and', children: [] },
        serve: {
          rollout: [
            { variationKey: 'control', weight: 50_000 },
            { variationKey: 'treatment', weight: 50_000 },
          ],
        },
      },
    ],
  });

  it('splits traffic and reports the bucket', () => {
    const env = indexSnapshot(snapshot([rolloutFlag]));
    let control = 0;
    let treatment = 0;
    for (let i = 0; i < 10_000; i++) {
      const result = evaluateFlag('f', ctx(`user-${i}`), env, 'FALLBACK');
      assert.ok(result.bucket !== undefined, 'rollout results carry their bucket');
      if (result.value === 'C') control += 1;
      else treatment += 1;
    }
    const skew = Math.abs(control - treatment) / 10_000;
    assert.ok(skew < 0.05, `50/50 split skewed by ${(skew * 100).toFixed(2)}%`);
  });

  it('is stable across repeated evaluations', () => {
    const env = indexSnapshot(snapshot([rolloutFlag]));
    for (let i = 0; i < 500; i++) {
      const a = evaluateFlag('f', ctx(`user-${i}`), env, 'FALLBACK');
      const b = evaluateFlag('f', ctx(`user-${i}`), env, 'FALLBACK');
      assert.equal(a.variationKey, b.variationKey);
    }
  });

  it('falls through to the default when the bucketing attribute is missing', () => {
    const env = indexSnapshot(
      snapshot([{ ...rolloutFlag, bucketBy: 'accountId', defaultVariationKey: 'off' }]),
    );
    const result = evaluateFlag('f', ctx('u1'), env, 'FALLBACK');
    assert.equal(result.value, 'OFF');
    assert.deepEqual(result.reason, { kind: 'default' });
  });

  it('buckets by a custom attribute, so a whole account moves together', () => {
    const env = indexSnapshot(snapshot([{ ...rolloutFlag, bucketBy: 'accountId' }]));
    const first = evaluateFlag('f', ctx('user-1', { accountId: 'acme' }), env, 'FALLBACK');
    const second = evaluateFlag('f', ctx('user-2', { accountId: 'acme' }), env, 'FALLBACK');
    assert.equal(first.variationKey, second.variationKey);
  });
});
