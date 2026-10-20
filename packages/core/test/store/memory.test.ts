import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/store/memory.js';
import { rawReport, sha256Hex } from '../../src/store/types.js';
import { storeContract } from './contract.js';

storeContract('MemoryStore', async () => new MemoryStore());

describe('sha256Hex', () => {
  it('hashes UTF-8 bytes', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('a one-character change is a different report', () => {
    const a = rawReport({ kind: 'metar', source: 'awc', station: 'KJFK', body: 'KJFK 071151Z 34007KT', issuedAt: null, upstream: null });
    const b = rawReport({ kind: 'metar', source: 'awc', station: 'KJFK', body: 'KJFK 071151Z 34008KT', issuedAt: null, upstream: null });
    expect(a.sha256).not.toBe(b.sha256);
  });
});

describe('MemoryStore fetch log', () => {
  it('keeps every fetch, including repeats of known content', async () => {
    const store = new MemoryStore();
    const r = rawReport({ kind: 'taf', source: 'awc', station: 'KJFK', body: 'TAF KJFK', issuedAt: null, upstream: null });
    await store.putRaw(r, { fetchedAt: new Date(1), request: 'a', station: null });
    await store.putRaw(r, { fetchedAt: new Date(2), request: 'b', station: null });
    expect(store.fetchLog().map((f) => f.event.request)).toEqual(['a', 'b']);
  });
});
