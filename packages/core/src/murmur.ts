/**
 * MurmurHash3 x86_32. Reference implementation for every Flagship SDK.
 *
 * See spec/BUCKETING.md. The traps this implementation exists to avoid:
 *
 * - JavaScript numbers are doubles, and `*` on two large uint32s loses low bits
 *   to float rounding. Every 32-bit multiply goes through Math.imul.
 * - `<<` and `|` yield *signed* int32, so every step is forced back to unsigned
 *   with `>>> 0`. Skipping this returns negative values that shift the bucket.
 */

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

function rotl32(x: number, r: number): number {
  return ((x << r) | (x >>> (32 - r))) >>> 0;
}

/** Hashes raw bytes. Callers hash the UTF-8 encoding of a string, never UTF-16 code units. */
export function murmurHash3x86_32(data: Uint8Array, seed = 0): number {
  const len = data.length;
  const nblocks = len >>> 2;
  let h1 = seed >>> 0;

  for (let i = 0; i < nblocks; i++) {
    const o = i * 4;
    // Little-endian block read.
    let k1 =
      (data[o]! | (data[o + 1]! << 8) | (data[o + 2]! << 16) | (data[o + 3]! << 24)) >>> 0;

    k1 = Math.imul(k1, C1) >>> 0;
    k1 = rotl32(k1, 15);
    k1 = Math.imul(k1, C2) >>> 0;

    h1 = (h1 ^ k1) >>> 0;
    h1 = rotl32(h1, 13);
    h1 = (Math.imul(h1, 5) + 0xe6546b64) >>> 0;
  }

  // Tail: 0-3 bytes that did not fill a block. The fallthrough is deliberate
  // and matches the reference implementation.
  const tail = nblocks * 4;
  let k1 = 0;
  switch (len & 3) {
    case 3:
      k1 ^= data[tail + 2]! << 16;
    // fallthrough
    case 2:
      k1 ^= data[tail + 1]! << 8;
    // fallthrough
    case 1:
      k1 ^= data[tail]!;
      k1 = Math.imul(k1 >>> 0, C1) >>> 0;
      k1 = rotl32(k1, 15);
      k1 = Math.imul(k1, C2) >>> 0;
      h1 = (h1 ^ k1) >>> 0;
  }

  // Finalization mix.
  h1 = (h1 ^ len) >>> 0;
  h1 = (h1 ^ (h1 >>> 16)) >>> 0;
  h1 = Math.imul(h1, 0x85ebca6b) >>> 0;
  h1 = (h1 ^ (h1 >>> 13)) >>> 0;
  h1 = Math.imul(h1, 0xc2b2ae35) >>> 0;
  h1 = (h1 ^ (h1 >>> 16)) >>> 0;

  return h1;
}

const encoder = new TextEncoder();

/** Convenience wrapper that hashes a string's UTF-8 bytes. */
export function murmurHash3x86_32String(input: string, seed = 0): number {
  return murmurHash3x86_32(encoder.encode(input), seed);
}
