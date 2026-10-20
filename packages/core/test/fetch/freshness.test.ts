/**
 * Not asking upstream again for something asked for a moment ago.
 *
 * On a laptop this saves a second. Serving strangers it is the difference
 * between courteous and abusive, so it is tested as behaviour rather than
 * left as an optimisation that might quietly stop working.
 */
import { describe, expect, it } from 'vitest';
import { AWC_BASE_URL, AwcClient } from '../../src/fetch/awc.js';
import { DEFAULT_FRESHNESS_MS, decideFetch, shouldFetch } from '../../src/fetch/freshness.js';
import { ingestStation } from '../../src/fetch/ingest.js';
import type { HttpClient } from '../../src/fetch/http.js';
import { MemoryStore } from '../../src/store/memory.js';
import { rawReport } from '../../src/store/types.js';

/** Counts what actually reached the network. */
function countingHttp(): HttpClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(url: string) {
      calls.push(url);
      const taf = url.includes('/taf');
      const body = JSON.stringify(
        taf
          ? [{ icaoId: 'CYSN', rawTAF: 'TAF CYSN 121940Z 1220/1301 19008KT P6SM BKN080', issueTime: '2026-09-12T19:40:00Z' }]
          : [{ icaoId: 'CYSN', rawOb: 'METAR CYSN 121900Z 18008KT 15SM BKN072 26/19 A2990', obsTime: Math.floor(Date.parse('2026-09-12T19:00:00Z') / 1000) }],
      );
      return { status: 200, body, headers: {} };
    },
  };
}

const AT = (iso: string) => new Date(iso);

describe('shouldFetch', () => {
  it('asks upstream for a station it has never asked about', async () => {
    const store = new MemoryStore();
    expect(await shouldFetch(store, 'CYSN', 'metar', AT('2026-09-12T20:00:00Z'))).toBe(true);
  });

  it('does not ask again inside the window, and does once it has passed', async () => {
    const store = new MemoryStore();
    const report = rawReport({ kind: 'metar', source: 'awc', station: 'CYSN', body: 'METAR CYSN 121900Z 18008KT', issuedAt: AT('2026-09-12T19:00:00Z'), upstream: null });
    await store.putRaw(report, { fetchedAt: AT('2026-09-12T19:55:00Z'), request: 'x', station: 'CYSN' });

    expect(await shouldFetch(store, 'CYSN', 'metar', AT('2026-09-12T20:00:00Z'))).toBe(false);
    expect(await shouldFetch(store, 'CYSN', 'metar', AT('2026-09-12T20:06:00Z'))).toBe(true);
    // A different kind at the same station is a different question.
    expect(await shouldFetch(store, 'CYSN', 'taf', AT('2026-09-12T20:00:00Z'))).toBe(true);
    // So is a different station: CYKF has never been asked about.
    expect(await shouldFetch(store, 'CYKF', 'metar', AT('2026-09-12T20:00:00Z'))).toBe(true);
  });

  it('is case-insensitive about the station, because a URL is not', async () => {
    const store = new MemoryStore();
    const report = rawReport({ kind: 'metar', source: 'awc', station: 'CYSN', body: 'METAR CYSN 121900Z', issuedAt: AT('2026-09-12T19:00:00Z'), upstream: null });
    await store.putRaw(report, { fetchedAt: AT('2026-09-12T19:55:00Z'), request: 'x', station: 'CYSN' });
    expect(await shouldFetch(store, 'cysn', 'metar', AT('2026-09-12T20:00:00Z'))).toBe(false);
  });

  it('can be turned off, for when a caller really does want the newest thing', async () => {
    const store = new MemoryStore();
    const report = rawReport({ kind: 'metar', source: 'awc', station: 'CYSN', body: 'METAR CYSN 121900Z', issuedAt: AT('2026-09-12T19:00:00Z'), upstream: null });
    await store.putRaw(report, { fetchedAt: AT('2026-09-12T19:59:00Z'), request: 'x', station: 'CYSN' });
    expect(await shouldFetch(store, 'CYSN', 'metar', AT('2026-09-12T20:00:00Z'), 0)).toBe(true);
  });

  it('counts a fetch made *for* a station even when the report is about no station', async () => {
    // A FIR-wide NOTAM belongs to no aerodrome, but asking for it still cost a request.
    const store = new MemoryStore();
    const report = rawReport({ kind: 'notam', source: 'navcanada-cfps', station: null, body: '(G3263/26 NOTAMN)', issuedAt: AT('2026-09-12T19:00:00Z'), upstream: null });
    await store.putRaw(report, { fetchedAt: AT('2026-09-12T19:50:00Z'), request: 'x', station: 'CYSN' });
    expect(await shouldFetch(store, 'CYSN', 'notam', AT('2026-09-12T20:00:00Z'))).toBe(false);
  });

  it('says why, in words a page can show a visitor', async () => {
    const store = new MemoryStore();
    const fresh = await decideFetch(store, 'CYSN', 'metar', AT('2026-09-12T20:00:00Z'));
    expect(fresh.fetched).toBe(true);
    expect(fresh.reason).toContain('has ever been fetched');

    const report = rawReport({ kind: 'metar', source: 'awc', station: 'CYSN', body: 'METAR CYSN 121900Z', issuedAt: AT('2026-09-12T19:00:00Z'), upstream: null });
    await store.putRaw(report, { fetchedAt: AT('2026-09-12T19:56:00Z'), request: 'x', station: 'CYSN' });
    const held = await decideFetch(store, 'CYSN', 'metar', AT('2026-09-12T20:00:00Z'));
    expect(held.fetched).toBe(false);
    expect(held.reason).toContain('4 min ago');
    expect(held.reason).toContain('using what is stored');
  });
});

describe('ingestStation', () => {
  it('asks upstream once, then holds off — one visitor clicking twice costs one round of requests', async () => {
    const store = new MemoryStore();
    const http = countingHttp();
    const awc = new AwcClient(http);

    const first = await ingestStation({ store, awc, now: () => AT('2026-09-12T20:00:00Z') }, 'CYSN');
    expect(http.calls).toHaveLength(2);
    expect(first.skipped).toEqual([]);
    expect(first.metar.fetched).toBe(1);

    const second = await ingestStation({ store, awc, now: () => AT('2026-09-12T20:02:00Z') }, 'CYSN');
    expect(http.calls).toHaveLength(2);
    expect(second.skipped.map((s) => s.kind).sort()).toEqual(['metar', 'taf']);
    expect(second.metar.fetched).toBe(0);
    expect(second.skipped[0]!.reason).toContain('using what is stored');
  });

  it('asks again once the window has passed, per kind', async () => {
    const store = new MemoryStore();
    const http = countingHttp();
    const awc = new AwcClient(http);
    await ingestStation({ store, awc, now: () => AT('2026-09-12T20:00:00Z') }, 'CYSN');
    expect(http.calls).toHaveLength(2);

    // Past the METAR window but not the TAF one: one request, not two.
    const later = await ingestStation({ store, awc, now: () => AT('2026-09-12T20:15:00Z') }, 'CYSN');
    expect(http.calls).toHaveLength(3);
    expect(later.skipped.map((s) => s.kind)).toEqual(['taf']);
    expect(DEFAULT_FRESHNESS_MS.metar).toBeLessThan(DEFAULT_FRESHNESS_MS.taf);
  });

  it('a caller can force a fetch of one kind without forcing the others', async () => {
    const store = new MemoryStore();
    const http = countingHttp();
    const awc = new AwcClient(http);
    await ingestStation({ store, awc, now: () => AT('2026-09-12T20:00:00Z') }, 'CYSN');
    const forced = await ingestStation({ store, awc, now: () => AT('2026-09-12T20:01:00Z') }, 'CYSN', { maxAge: { metar: 0 } });
    expect(http.calls).toHaveLength(3);
    expect(forced.skipped.map((s) => s.kind)).toEqual(['taf']);
  });
});
