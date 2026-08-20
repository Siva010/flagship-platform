/**
 * The in-process Java SDK.
 *
 * <p>Evaluation is local: the client holds the full ruleset in memory and never performs
 * network I/O on the hot path. See {@code spec/BUCKETING.md} for the bucketing contract
 * this package must satisfy.
 *
 * <p>Java has no unsigned 32-bit integer, and MurmurHash3 is defined over one. The
 * convention throughout this package is that {@code int} carries the raw 32-bit pattern
 * during the mix, and any value that escapes to a caller or reaches a comparison or a
 * modulo is widened to {@code long} with {@code & 0xFFFFFFFFL} first.
 */
package com.flagship.sdk;
