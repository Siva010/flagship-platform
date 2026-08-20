package com.flagship.sdk;

import java.util.List;
import java.util.Optional;

/** Maps users to rollout buckets. Identical output in every SDK — see {@code spec/BUCKETING.md}. */
public final class Bucketing {

  /** The size of the bucket range. Every SDK must agree on it. */
  public static final int BUCKET_SPACE = 100_000;

  /** Never escaped; keys are restricted to {@code [a-zA-Z0-9._-]} at write time. */
  public static final String BUCKET_SEPARATOR = ":";

  private Bucketing() {}

  /**
   * Joins the hash input. Public so drift between the joiner and the hasher is impossible
   * to introduce accidentally — the conformance fixture asserts on this string too.
   */
  public static String bucketingInput(String flagKey, String salt, String bucketKey) {
    return flagKey + BUCKET_SEPARATOR + salt + BUCKET_SEPARATOR + bucketKey;
  }

  /**
   * Maps a user to a stable point in {@code [0, BUCKET_SPACE)}.
   *
   * <p>The modulo runs on the widened {@code long}, not on a raw {@code int}. Java's
   * {@code %} keeps the sign of its left operand, so taking it over a hash that still held
   * a sign bit would yield negative buckets for roughly half of all inputs — a divergence
   * that no amount of testing against another Java implementation would catch.
   */
  public static int bucketFor(String flagKey, String salt, String bucketKey) {
    long hash = MurmurHash3.hashUtf8(bucketingInput(flagKey, salt, bucketKey), 0);
    // Narrowing is safe: the remainder is already in [0, BUCKET_SPACE).
    return (int) (hash % BUCKET_SPACE);
  }

  /**
   * Walks the distribution in declaration order and serves the first variation whose
   * cumulative weight exceeds the bucket.
   *
   * <p>Declaration order is part of the wire contract: it is what makes raising a rollout
   * from 10% to 20% additive, so nobody already inside it moves.
   *
   * <p>Empty when the weights sum to no more than the bucket value, which means the
   * distribution is malformed. Callers fall back to the default variation.
   */
  public static Optional<String> variationForBucket(List<Distribution> distribution, int bucket) {
    int cumulative = 0;
    for (Distribution entry : distribution) {
      cumulative += entry.weight();
      if (bucket < cumulative) {
        return Optional.of(entry.variationKey());
      }
    }
    return Optional.empty();
  }

  /** Weights must sum to exactly {@link #BUCKET_SPACE}. Validated on write, not on the hot path. */
  public static boolean isValidDistribution(List<Distribution> distribution) {
    if (distribution.isEmpty()) {
      return false;
    }
    long total = 0;
    for (Distribution entry : distribution) {
      if (entry.weight() < 0) {
        return false;
      }
      total += entry.weight();
    }
    return total == BUCKET_SPACE;
  }
}
