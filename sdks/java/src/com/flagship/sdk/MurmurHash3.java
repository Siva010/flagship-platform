package com.flagship.sdk;

import java.nio.charset.StandardCharsets;

/**
 * MurmurHash3 x86_32. Must agree byte-for-byte with the TypeScript and Go SDKs — see
 * {@code spec/BUCKETING.md}.
 *
 * <p>The traps this implementation exists to avoid:
 *
 * <ul>
 *   <li>Java has no unsigned 32-bit type, but the algorithm is defined over uint32. The
 *       mix itself is safe in signed {@code int} because two's-complement addition,
 *       multiplication and XOR produce identical bit patterns either way. Only the
 *       <em>shifts</em> differ, so every right shift here is {@code >>>}. A single
 *       {@code >>} in the finalizer smears sign bits downward and silently changes the
 *       hash for every input whose intermediate value happens to be negative.
 *   <li>A {@code byte} in Java is signed, so widening one to {@code int} sign-extends.
 *       Every byte read is masked with {@code & 0xff} to undo that.
 *   <li>A Java {@code String} is UTF-16. The spec hashes UTF-8 bytes, so the string entry
 *       point encodes explicitly rather than trusting the platform default charset.
 * </ul>
 */
public final class MurmurHash3 {

  private static final int C1 = 0xcc9e2d51;
  private static final int C2 = 0x1b873593;

  private MurmurHash3() {}

  /**
   * Hashes a string's UTF-8 bytes.
   *
   * <p>Returns {@code long} rather than {@code int} so the uint32 result cannot reach a
   * caller still wearing a sign bit. The value is always in {@code [0, 2^32)}.
   */
  public static long hashUtf8(String input, int seed) {
    return hash(input.getBytes(StandardCharsets.UTF_8), seed);
  }

  /** Hashes raw bytes, returning the uint32 result widened into a {@code long}. */
  @SuppressWarnings("fallthrough") // The tail switch falls through by design; see below.
  public static long hash(byte[] data, int seed) {
    int hash = seed;
    int blockCount = data.length / 4;

    for (int block = 0; block < blockCount; block++) {
      int offset = block * 4;
      // Little-endian block read, independent of the host's byte order.
      int k =
          (data[offset] & 0xff)
              | ((data[offset + 1] & 0xff) << 8)
              | ((data[offset + 2] & 0xff) << 16)
              | ((data[offset + 3] & 0xff) << 24);

      k *= C1;
      k = Integer.rotateLeft(k, 15);
      k *= C2;

      hash ^= k;
      hash = Integer.rotateLeft(hash, 13);
      hash = hash * 5 + 0xe6546b64;
    }

    // Tail: the 0-3 bytes that did not fill a block. The fallthrough is deliberate and
    // matches the reference implementation — each case contributes one more byte before
    // the shared mix in case 1.
    int tailOffset = blockCount * 4;
    int k = 0;
    switch (data.length & 3) {
      case 3:
        k ^= (data[tailOffset + 2] & 0xff) << 16;
      case 2:
        k ^= (data[tailOffset + 1] & 0xff) << 8;
      case 1:
        k ^= data[tailOffset] & 0xff;
        k *= C1;
        k = Integer.rotateLeft(k, 15);
        k *= C2;
        hash ^= k;
      default:
        // Length is a multiple of 4; there is no tail to mix.
    }

    // Finalization mix. Every shift is unsigned — see the class comment.
    hash ^= data.length;
    hash ^= hash >>> 16;
    hash *= 0x85ebca6b;
    hash ^= hash >>> 13;
    hash *= 0xc2b2ae35;
    hash ^= hash >>> 16;

    // The one place the signed/unsigned boundary is crossed, and the only place it is
    // safe to cross it: the caller sees a plain non-negative number from here on.
    return hash & 0xFFFFFFFFL;
  }
}
