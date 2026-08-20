import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { murmurHash3x86_32, murmurHash3x86_32String } from './murmur.ts';

describe('murmurHash3x86_32', () => {
  it('matches published reference vectors (seed 0)', () => {
    // These come from the canonical smhasher/reference implementation. They are
    // the only thing proving this port is correct rather than merely
    // self-consistent with the Go port.
    const vectors: [string, number][] = [
      ['', 0],
      ['a', 0x3c2569b2],
      ['ab', 0x9bbfd75f],
      ['abc', 0xb3dd93fa],
      ['abcd', 0x43ed676a],
      ['Hello, world!', 0xc0363e43],
    ];
    for (const [input, expected] of vectors) {
      assert.equal(murmurHash3x86_32String(input), expected >>> 0, `input=${JSON.stringify(input)}`);
    }
  });

  it('always returns an unsigned 32-bit integer', () => {
    // The signed-int32 trap: a naive port returns negatives for many inputs.
    for (let i = 0; i < 5000; i++) {
      const h = murmurHash3x86_32String(`key-${i}`);
      assert.ok(Number.isInteger(h), `not an integer: ${h}`);
      assert.ok(h >= 0 && h <= 0xffffffff, `out of uint32 range: ${h}`);
    }
  });

  it('hashes UTF-8 bytes, not UTF-16 code units', () => {
    // "é" is 1 UTF-16 code unit but 2 UTF-8 bytes. An implementation that
    // iterates charCodeAt would hash the wrong input and silently diverge
    // from the Go and Java SDKs.
    const utf8 = new TextEncoder().encode('é');
    assert.equal(utf8.length, 2);
    assert.equal(murmurHash3x86_32String('é'), murmurHash3x86_32(utf8));
  });

  it('is sensitive to the seed', () => {
    assert.notEqual(murmurHash3x86_32String('abc', 0), murmurHash3x86_32String('abc', 1));
  });

  it('exercises every tail length', () => {
    // len % 4 of 0..3 each take a different branch through the tail switch.
    for (const input of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', 'abcdef', 'abcdefg']) {
      const h = murmurHash3x86_32String(input);
      assert.ok(h >= 0 && h <= 0xffffffff);
    }
  });
});
