import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * SDK API keys.
 *
 * Keys are stored hashed, never in plaintext: a database dump must not hand an
 * attacker working credentials. That creates a lookup problem, since you cannot
 * query by a value you do not store. The fix is a short indexed prefix — enough
 * to find the candidate row, not enough to be useful on its own — and a
 * constant-time comparison of the hash.
 *
 * A plain bcrypt/argon2 hash would be stronger against offline cracking, but
 * these are 256-bit random secrets rather than user-chosen passwords, so there
 * is no dictionary to run. SHA-256 is the right tool here, and it is fast
 * enough to run on every SDK request.
 */

/** Client keys ship in browser bundles and receive filtered payloads. */
export type KeyKind = 'client' | 'server';

const PREFIX_LENGTH = 12;
const SECRET_BYTES = 32;

export interface GeneratedKey {
  /** Shown to the user exactly once. Never stored. */
  plaintext: string;
  prefix: string;
  hash: string;
  kind: KeyKind;
}

function label(kind: KeyKind): string {
  // A visible prefix lets a leaked key be identified at a glance, and lets
  // secret scanners match on it.
  return kind === 'client' ? 'fs_client_' : 'fs_server_';
}

export function generateApiKey(kind: KeyKind): GeneratedKey {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const plaintext = `${label(kind)}${secret}`;

  return {
    plaintext,
    prefix: plaintext.slice(0, PREFIX_LENGTH),
    hash: hashApiKey(plaintext),
    kind,
  };
}

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

export function keyPrefix(plaintext: string): string {
  return plaintext.slice(0, PREFIX_LENGTH);
}

/** Infers the key kind from its label. Returns undefined for a malformed key. */
export function keyKindOf(plaintext: string): KeyKind | undefined {
  if (plaintext.startsWith('fs_client_')) return 'client';
  if (plaintext.startsWith('fs_server_')) return 'server';
  return undefined;
}

/**
 * Constant-time hash comparison.
 *
 * A plain `===` leaks timing information: it returns as soon as two bytes
 * differ, so an attacker can recover a hash byte by byte from response times.
 */
export function verifyApiKey(plaintext: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashApiKey(plaintext), 'hex');
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHash, 'hex');
  } catch {
    return false;
  }
  // timingSafeEqual throws on a length mismatch, which would itself be a
  // timing signal, so the lengths are checked first and identically.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
