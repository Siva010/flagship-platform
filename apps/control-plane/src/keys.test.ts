import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  generateApiKey,
  hashApiKey,
  keyKindOf,
  keyPrefix,
  verifyApiKey,
} from './keys.ts';

describe('generateApiKey', () => {
  it('labels keys by kind so a leaked key is identifiable', () => {
    assert.ok(generateApiKey('client').plaintext.startsWith('fs_client_'));
    assert.ok(generateApiKey('server').plaintext.startsWith('fs_server_'));
  });

  it('never returns the plaintext in the stored fields', () => {
    const key = generateApiKey('server');
    assert.notEqual(key.hash, key.plaintext);
    assert.equal(key.hash.length, 64, 'sha256 hex');
    // The prefix is short enough to be useless on its own.
    assert.ok(key.prefix.length < key.plaintext.length / 2);
  });

  it('produces unique keys', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateApiKey('server').plaintext);
    assert.equal(seen.size, 1000);
  });

  it('derives a prefix that matches keyPrefix', () => {
    const key = generateApiKey('client');
    assert.equal(key.prefix, keyPrefix(key.plaintext));
  });
});

describe('verifyApiKey', () => {
  it('accepts the correct key', () => {
    const key = generateApiKey('server');
    assert.equal(verifyApiKey(key.plaintext, key.hash), true);
  });

  it('rejects a wrong key', () => {
    const key = generateApiKey('server');
    const other = generateApiKey('server');
    assert.equal(verifyApiKey(other.plaintext, key.hash), false);
  });

  it('rejects a key that differs by one character', () => {
    const key = generateApiKey('server');
    const tampered = key.plaintext.slice(0, -1) + (key.plaintext.endsWith('a') ? 'b' : 'a');
    assert.equal(verifyApiKey(tampered, key.hash), false);
  });

  it('rejects malformed stored hashes without throwing', () => {
    const key = generateApiKey('server');
    for (const bad of ['', 'not-hex', 'ab', 'z'.repeat(64)]) {
      assert.doesNotThrow(() => verifyApiKey(key.plaintext, bad));
      assert.equal(verifyApiKey(key.plaintext, bad), false);
    }
  });
});

describe('hashApiKey', () => {
  it('is deterministic', () => {
    assert.equal(hashApiKey('fs_server_abc'), hashApiKey('fs_server_abc'));
  });

  it('matches a known SHA-256 vector', () => {
    // Guards against the digest encoding silently changing.
    assert.equal(
      hashApiKey('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('keyKindOf', () => {
  it('reads the kind from the label', () => {
    assert.equal(keyKindOf(generateApiKey('client').plaintext), 'client');
    assert.equal(keyKindOf(generateApiKey('server').plaintext), 'server');
  });

  it('returns undefined for a malformed key rather than guessing', () => {
    // Guessing 'server' here would hand a client the unfiltered payload.
    assert.equal(keyKindOf('garbage'), undefined);
    assert.equal(keyKindOf(''), undefined);
    assert.equal(keyKindOf('fs_admin_xyz'), undefined);
  });
});
