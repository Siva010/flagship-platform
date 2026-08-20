import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RulesetSnapshot } from '@flagship/core';
import { FlagshipClient, type ExposureRecord } from './client.ts';

function snapshot(version: number, value: unknown = true): RulesetSnapshot {
  return {
    environmentKey: 'production',
    version,
    flags: [
      {
        key: 'f',
        enabled: true,
        salt: 'salt-a',
        variations: [
          { key: 'on', value },
          { key: 'off', value: false },
        ],
        defaultVariationKey: 'on',
        offVariationKey: 'off',
        prerequisites: [],
        rules: [],
        bucketBy: 'key',
      },
    ],
    segments: [],
    servedAt: '2026-08-20T00:00:00.000Z',
  };
}

const ctx = { key: 'user-1', attributes: {} };

describe('FlagshipClient', () => {
  it('returns the fallback before any ruleset has loaded', () => {
    const client = new FlagshipClient({ sdkKey: 'k', baseUrl: 'http://localhost' });
    assert.equal(client.ready, false);
    assert.equal(client.version, -1);

    const result = client.evaluate('f', ctx, 'FALLBACK');
    assert.equal(result.value, 'FALLBACK');
    assert.equal(result.reason.kind, 'error');
  });

  it('evaluates from a bootstrap ruleset without any network call', () => {
    const client = new FlagshipClient({
      sdkKey: 'k',
      baseUrl: 'http://localhost',
      bootstrap: snapshot(7),
    });
    assert.equal(client.ready, true);
    assert.equal(client.version, 7);
    assert.equal(client.evaluate('f', ctx, false).value, true);
  });

  it('exposes isEnabled for the boolean case', () => {
    const client = new FlagshipClient({
      sdkKey: 'k',
      baseUrl: 'http://localhost',
      bootstrap: snapshot(1),
    });
    assert.equal(client.isEnabled('f', ctx), true);
    assert.equal(client.isEnabled('missing', ctx), false, 'unknown flag falls back');
  });

  it('falls back when the variation is not a boolean', () => {
    const client = new FlagshipClient({
      sdkKey: 'k',
      baseUrl: 'http://localhost',
      bootstrap: snapshot(1, 'a string'),
    });
    assert.equal(client.isEnabled('f', ctx, false), false);
  });
});

describe('FlagshipClient — version ordering', () => {
  it('applies a newer snapshot', () => {
    const client = new FlagshipClient({
      sdkKey: 'k',
      baseUrl: 'http://localhost',
      bootstrap: snapshot(1),
    });
    assert.equal(client.applySnapshot(snapshot(2)), true);
    assert.equal(client.version, 2);
  });

  it('rejects an older or equal snapshot, so out-of-order delivery cannot regress state', () => {
    const client = new FlagshipClient({
      sdkKey: 'k',
      baseUrl: 'http://localhost',
      bootstrap: snapshot(5),
    });
    assert.equal(client.applySnapshot(snapshot(4)), false, 'older rejected');
    assert.equal(client.applySnapshot(snapshot(5)), false, 'equal rejected');
    assert.equal(client.version, 5);
  });

  it('re-indexes on apply, so evaluation reflects the new ruleset', () => {
    const client = new FlagshipClient({
      sdkKey: 'k',
      baseUrl: 'http://localhost',
      bootstrap: snapshot(1, 'first'),
    });
    assert.equal(client.evaluate('f', ctx, 'FALLBACK').value, 'first');
    client.applySnapshot(snapshot(2, 'second'));
    assert.equal(client.evaluate('f', ctx, 'FALLBACK').value, 'second');
  });
});

describe('FlagshipClient — host safety', () => {
  it('reports exposures for real evaluations', () => {
    const seen: ExposureRecord[] = [];
    const client = new FlagshipClient({
      sdkKey: 'k',
      baseUrl: 'http://localhost',
      bootstrap: snapshot(3),
      onExposure: (event) => seen.push(event),
    });

    client.evaluate('f', ctx, false);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], {
      flagKey: 'f',
      variationKey: 'on',
      contextKey: 'user-1',
      rulesetVersion: 3,
      reason: { kind: 'default' },
    });
  });

  it('does not record an exposure when evaluation errored', () => {
    // The user never saw a variation, so counting it would corrupt experiment
    // denominators.
    const seen: ExposureRecord[] = [];
    const client = new FlagshipClient({
      sdkKey: 'k',
      baseUrl: 'http://localhost',
      bootstrap: snapshot(1),
      onExposure: (event) => seen.push(event),
    });
    client.evaluate('does-not-exist', ctx, false);
    assert.equal(seen.length, 0);
  });

  it('never lets a throwing exposure callback reach the caller', () => {
    const errors: Error[] = [];
    const client = new FlagshipClient({
      sdkKey: 'k',
      baseUrl: 'http://localhost',
      bootstrap: snapshot(1),
      onExposure: () => {
        throw new Error('host callback exploded');
      },
      onError: (error) => errors.push(error),
    });

    // The whole point: this must not throw.
    const result = client.evaluate('f', ctx, false);
    assert.equal(result.value, true);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.message, 'host callback exploded');
  });

  it('survives a throwing error handler too', () => {
    const client = new FlagshipClient({
      sdkKey: 'k',
      baseUrl: 'http://localhost',
      bootstrap: snapshot(1),
      onExposure: () => {
        throw new Error('first');
      },
      onError: () => {
        throw new Error('second');
      },
    });
    assert.doesNotThrow(() => client.evaluate('f', ctx, false));
  });
});
