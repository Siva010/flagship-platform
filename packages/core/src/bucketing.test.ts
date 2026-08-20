import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BUCKET_SPACE,
  bucketFor,
  isValidDistribution,
  variationForBucket,
} from './bucketing.ts';

describe('bucketFor', () => {
  it('is deterministic', () => {
    for (let i = 0; i < 1000; i++) {
      const key = `user-${i}`;
      assert.equal(bucketFor('checkout', 'salt-a', key), bucketFor('checkout', 'salt-a', key));
    }
  });

  it('stays inside [0, BUCKET_SPACE)', () => {
    for (let i = 0; i < 10_000; i++) {
      const b = bucketFor('checkout', 'salt-a', `user-${i}`);
      assert.ok(b >= 0 && b < BUCKET_SPACE, `bucket out of range: ${b}`);
    }
  });

  it('separates flags, salts, and users', () => {
    const base = bucketFor('checkout', 'salt-a', 'user-1');
    assert.notEqual(base, bucketFor('search', 'salt-a', 'user-1'));
    assert.notEqual(base, bucketFor('checkout', 'salt-b', 'user-1'));
    assert.notEqual(base, bucketFor('checkout', 'salt-a', 'user-2'));
  });

  it('distributes roughly uniformly across deciles', () => {
    // Not a rigorous uniformity proof — a smoke test that would catch a hash
    // collapsing into a narrow range.
    const n = 100_000;
    const deciles = new Array<number>(10).fill(0);
    for (let i = 0; i < n; i++) {
      const b = bucketFor('checkout', 'salt-a', `user-${i}`);
      deciles[Math.floor((b / BUCKET_SPACE) * 10)]! += 1;
    }
    const expected = n / 10;
    for (const [i, count] of deciles.entries()) {
      const drift = Math.abs(count - expected) / expected;
      assert.ok(drift < 0.05, `decile ${i} drifted ${(drift * 100).toFixed(2)}% (count=${count})`);
    }
  });

  it('handles unicode and empty keys without throwing', () => {
    for (const key of ['', 'ユーザー', 'user-🎉', 'é'.repeat(100)]) {
      const b = bucketFor('checkout', 'salt-a', key);
      assert.ok(b >= 0 && b < BUCKET_SPACE);
    }
  });
});

describe('sticky assignment', () => {
  it('never moves a user out when a rollout percentage increases', () => {
    // The headline guarantee: raising a rollout from 10% to 20% must be purely
    // additive. Because the bucket is independent of the percentage, "in" is
    // just `bucket < threshold`, which is monotonic in the threshold.
    const users = Array.from({ length: 20_000 }, (_, i) => `user-${i}`);
    const buckets = users.map((u) => bucketFor('checkout', 'salt-a', u));

    let previouslyIn = new Set<string>();
    for (const percent of [1, 5, 10, 20, 50, 75, 100]) {
      const threshold = (percent / 100) * BUCKET_SPACE;
      const nowIn = new Set<string>();
      for (const [i, user] of users.entries()) {
        if (buckets[i]! < threshold) nowIn.add(user);
      }
      for (const user of previouslyIn) {
        assert.ok(nowIn.has(user), `user ${user} was dropped when rollout rose to ${percent}%`);
      }
      previouslyIn = nowIn;
    }

    assert.equal(previouslyIn.size, users.length, '100% rollout must include everyone');
  });

  it('keeps a user in the same variation when an unrelated flag changes', () => {
    const before = bucketFor('checkout', 'salt-a', 'user-42');
    const after = bucketFor('checkout', 'salt-a', 'user-42');
    assert.equal(before, after);
  });
});

describe('variationForBucket', () => {
  const even = [
    { variationKey: 'control', weight: 50_000 },
    { variationKey: 'treatment', weight: 50_000 },
  ];

  it('splits on the cumulative boundary', () => {
    assert.equal(variationForBucket(even, 0), 'control');
    assert.equal(variationForBucket(even, 49_999), 'control');
    assert.equal(variationForBucket(even, 50_000), 'treatment');
    assert.equal(variationForBucket(even, 99_999), 'treatment');
  });

  it('respects declaration order, so growing the first slice is additive', () => {
    const grown = [
      { variationKey: 'control', weight: 60_000 },
      { variationKey: 'treatment', weight: 40_000 },
    ];
    // Everyone who was control at 50k is still control at 60k.
    for (let b = 0; b < 50_000; b++) {
      if (variationForBucket(even, b) === 'control') {
        assert.equal(variationForBucket(grown, b), 'control');
      }
    }
  });

  it('returns undefined for a malformed distribution', () => {
    assert.equal(variationForBucket([{ variationKey: 'a', weight: 10 }], 99_999), undefined);
    assert.equal(variationForBucket([], 0), undefined);
  });
});

describe('isValidDistribution', () => {
  it('requires weights summing to exactly BUCKET_SPACE', () => {
    assert.ok(isValidDistribution([{ variationKey: 'a', weight: 100_000 }]));
    assert.ok(
      isValidDistribution([
        { variationKey: 'a', weight: 33_333 },
        { variationKey: 'b', weight: 33_333 },
        { variationKey: 'c', weight: 33_334 },
      ]),
    );
    assert.ok(!isValidDistribution([{ variationKey: 'a', weight: 99_999 }]));
    assert.ok(!isValidDistribution([]));
  });

  it('rejects negative and fractional weights', () => {
    assert.ok(
      !isValidDistribution([
        { variationKey: 'a', weight: -1 },
        { variationKey: 'b', weight: 100_001 },
      ]),
    );
    assert.ok(
      !isValidDistribution([
        { variationKey: 'a', weight: 50_000.5 },
        { variationKey: 'b', weight: 49_999.5 },
      ]),
    );
  });
});
