import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateFlag, indexSnapshot } from './evaluate.ts';
import type { Condition, Flag, RulesetSnapshot, Segment } from './types.ts';
import { containsServerOnly, filterSnapshotForKey, findServerOnlyLeaks } from './visibility.ts';

const serverCondition: Condition = {
  kind: 'condition',
  attribute: 'email',
  operator: 'endsWith',
  values: ['@competitor.com'],
  visibility: 'server',
};

const clientCondition: Condition = {
  kind: 'condition',
  attribute: 'plan',
  operator: 'eq',
  values: ['pro'],
  visibility: 'client',
};

function flag(key: string, rules: Flag['rules']): Flag {
  return {
    key,
    enabled: true,
    salt: 'salt-a',
    variations: [
      { key: 'on', value: true },
      { key: 'off', value: false },
    ],
    defaultVariationKey: 'off',
    offVariationKey: 'off',
    prerequisites: [],
    rules,
    bucketBy: 'key',
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

describe('containsServerOnly', () => {
  it('finds a server-only condition at any depth', () => {
    assert.equal(containsServerOnly(clientCondition), false);
    assert.equal(containsServerOnly(serverCondition), true);
    assert.equal(
      containsServerOnly({
        kind: 'and',
        children: [clientCondition, { kind: 'or', children: [clientCondition, serverCondition] }],
      }),
      true,
    );
  });
});

describe('filterSnapshotForKey', () => {
  it('leaves a server payload untouched', () => {
    const source = snapshot([
      flag('f', [
        { id: 'r1', description: '', when: serverCondition, serve: { variationKey: 'on' } },
      ]),
    ]);
    assert.deepEqual(filterSnapshotForKey(source, 'server'), source);
  });

  it('strips a server-only rule from a client payload', () => {
    const source = snapshot([
      flag('f', [
        { id: 'secret', description: '', when: serverCondition, serve: { variationKey: 'on' } },
        { id: 'public', description: '', when: clientCondition, serve: { variationKey: 'on' } },
      ]),
    ]);

    const client = filterSnapshotForKey(source, 'client');
    const rules = client.flags[0]!.rules;
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.id, 'public');
    assert.equal(JSON.stringify(client).includes('@competitor.com'), false, 'value must not leak');
  });

  it('drops the whole rule when a server-only node sits inside an AND', () => {
    // The dangerous case. Removing just the server node would leave
    // `plan == pro`, which is MORE permissive than the author wrote and would
    // enable the flag for users they excluded.
    const source = snapshot([
      flag('f', [
        {
          id: 'mixed',
          description: '',
          when: { kind: 'and', children: [clientCondition, serverCondition] },
          serve: { variationKey: 'on' },
        },
      ]),
    ]);

    const client = filterSnapshotForKey(source, 'client');
    assert.equal(client.flags[0]!.rules.length, 0, 'rule must be dropped entirely, not rewritten');
  });

  it('does not widen targeting for a client', () => {
    // Property check: anyone the client payload enables must also be enabled by
    // the server payload. The reverse may differ, but never this direction.
    const source = snapshot([
      flag('f', [
        {
          id: 'mixed',
          description: '',
          when: { kind: 'and', children: [clientCondition, serverCondition] },
          serve: { variationKey: 'on' },
        },
      ]),
    ]);

    const serverEnv = indexSnapshot(filterSnapshotForKey(source, 'server'));
    const clientEnv = indexSnapshot(filterSnapshotForKey(source, 'client'));

    for (const email of ['a@competitor.com', 'a@example.com']) {
      for (const plan of ['pro', 'free']) {
        const ctx = { key: 'u1', attributes: { email, plan } };
        const onClient = evaluateFlag('f', ctx, clientEnv, false).value;
        const onServer = evaluateFlag('f', ctx, serverEnv, false).value;
        if (onClient) {
          assert.ok(onServer, `client enabled for ${plan}/${email} but server did not`);
        }
      }
    }
  });

  it('removes a server-only segment and every rule using it', () => {
    const source = snapshot(
      [
        flag('f', [
          {
            id: 'r1',
            description: '',
            when: { kind: 'segment', segmentKey: 'internal', negate: false },
            serve: { variationKey: 'on' },
          },
        ]),
      ],
      [{ key: 'internal', when: serverCondition }],
    );

    const client = filterSnapshotForKey(source, 'client');
    assert.equal(client.segments.length, 0);
    assert.equal(client.flags[0]!.rules.length, 0);
    assert.equal(JSON.stringify(client).includes('@competitor.com'), false);
  });

  it('keeps a client-safe segment', () => {
    const source = snapshot(
      [
        flag('f', [
          {
            id: 'r1',
            description: '',
            when: { kind: 'segment', segmentKey: 'pro-users', negate: false },
            serve: { variationKey: 'on' },
          },
        ]),
      ],
      [{ key: 'pro-users', when: clientCondition }],
    );

    const client = filterSnapshotForKey(source, 'client');
    assert.equal(client.segments.length, 1);
    assert.equal(client.flags[0]!.rules.length, 1);
  });

  it('propagates unsafety through a segment that references another segment', () => {
    const source = snapshot(
      [
        flag('f', [
          {
            id: 'r1',
            description: '',
            when: { kind: 'segment', segmentKey: 'outer', negate: false },
            serve: { variationKey: 'on' },
          },
        ]),
      ],
      [
        { key: 'outer', when: { kind: 'segment', segmentKey: 'inner', negate: false } },
        { key: 'inner', when: serverCondition },
      ],
    );

    const client = filterSnapshotForKey(source, 'client');
    assert.equal(client.segments.length, 0, 'outer is unsafe because inner is');
    assert.equal(client.flags[0]!.rules.length, 0);
  });

  it('treats a segment cycle as unsafe rather than looping forever', () => {
    const source = snapshot(
      [flag('f', [])],
      [
        { key: 'a', when: { kind: 'segment', segmentKey: 'b', negate: false } },
        { key: 'b', when: { kind: 'segment', segmentKey: 'a', negate: false } },
      ],
    );
    const client = filterSnapshotForKey(source, 'client');
    assert.equal(client.segments.length, 0);
  });
});

describe('findServerOnlyLeaks', () => {
  it('reports nothing for a filtered client payload', () => {
    const source = snapshot(
      [
        flag('f', [
          { id: 'r1', description: '', when: serverCondition, serve: { variationKey: 'on' } },
          { id: 'r2', description: '', when: clientCondition, serve: { variationKey: 'on' } },
        ]),
      ],
      [{ key: 'internal', when: serverCondition }],
    );
    assert.deepEqual(findServerOnlyLeaks(filterSnapshotForKey(source, 'client')), []);
  });

  it('catches a leak that slipped through', () => {
    const leaky = snapshot([
      flag('f', [
        { id: 'oops', description: '', when: serverCondition, serve: { variationKey: 'on' } },
      ]),
    ]);
    const leaks = findServerOnlyLeaks(leaky);
    assert.equal(leaks.length, 1);
    assert.match(leaks[0]!, /flag "f" rule "oops"/);
  });
});
