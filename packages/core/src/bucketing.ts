import { murmurHash3x86_32String } from './murmur.ts';
import type { Distribution } from './types.ts';

/** Bucket space. Every SDK must agree on this constant. */
export const BUCKET_SPACE = 100_000;

/** The separator is never escaped; keys are restricted to [a-zA-Z0-9._-] at write time. */
export const BUCKET_SEPARATOR = ':';

/** Joins the bucketing input. Exported so the fixture generator and SDKs cannot drift. */
export function bucketingInput(flagKey: string, salt: string, bucketKey: string): string {
  return flagKey + BUCKET_SEPARATOR + salt + BUCKET_SEPARATOR + bucketKey;
}

/**
 * Maps a user to a stable point in [0, BUCKET_SPACE).
 * Identical output in every SDK language — see spec/BUCKETING.md.
 */
export function bucketFor(flagKey: string, salt: string, bucketKey: string): number {
  return murmurHash3x86_32String(bucketingInput(flagKey, salt, bucketKey), 0) % BUCKET_SPACE;
}

/**
 * Walks a distribution in declaration order, serving the first variation whose
 * cumulative weight exceeds the bucket.
 *
 * Declaration order is part of the wire contract: it is what makes raising a
 * rollout from 10% to 20% purely additive, so nobody already inside it moves.
 *
 * Returns undefined when weights sum to less than the bucket value, which means
 * the distribution is malformed. Callers fall back to the default variation.
 */
export function variationForBucket(
  distribution: readonly Distribution[],
  bucket: number,
): string | undefined {
  let cumulative = 0;
  for (const entry of distribution) {
    cumulative += entry.weight;
    if (bucket < cumulative) return entry.variationKey;
  }
  return undefined;
}

/** Weights must sum to exactly BUCKET_SPACE. Validated on write, not on the hot path. */
export function isValidDistribution(distribution: readonly Distribution[]): boolean {
  if (distribution.length === 0) return false;
  let total = 0;
  for (const entry of distribution) {
    if (!Number.isInteger(entry.weight) || entry.weight < 0) return false;
    total += entry.weight;
  }
  return total === BUCKET_SPACE;
}
