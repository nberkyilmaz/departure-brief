/**
 * The hand-written digest against the reference one. Content addressing is
 * the spine of the project, so this is checked at every length where an
 * implementation could get the padding wrong, not at a couple of samples.
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/hash/sha256.js';

const reference = (b: Uint8Array | string) => createHash('sha256').update(typeof b === 'string' ? Buffer.from(b, 'utf8') : Buffer.from(b)).digest('hex');

describe('sha256Hex', () => {
  it('matches the published vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('matches the reference at every length around a block boundary', () => {
    // 55/56 and 119/120 are where the length no longer fits in the final
    // block and a second one has to be added. Getting those wrong is the
    // classic way to write a digest that is right for short inputs only.
    for (let n = 0; n <= 200; n++) {
      const bytes = randomBytes(n);
      expect(sha256Hex(new Uint8Array(bytes))).toBe(reference(bytes));
    }
  });

  it('matches the reference on larger and multi-byte inputs', () => {
    for (const n of [1000, 4096, 100_000]) {
      const bytes = randomBytes(n);
      expect(sha256Hex(new Uint8Array(bytes))).toBe(reference(bytes));
    }
    // UTF-8, because a report can carry an accented aerodrome name.
    for (const s of ['CYSN', 'Rivière-du-Loup', '日本語のテキスト', 'x'.repeat(10_000)]) {
      expect(sha256Hex(s)).toBe(reference(s));
    }
  });
});
