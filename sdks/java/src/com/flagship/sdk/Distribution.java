package com.flagship.sdk;

/**
 * One slice of a percentage rollout. Weights are in basis points of
 * {@link Bucketing#BUCKET_SPACE} and must sum to exactly that value.
 */
public record Distribution(String variationKey, int weight) {}
