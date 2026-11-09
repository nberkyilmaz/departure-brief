/**
 * Getting the balloon files, over the ones recorded on 9 November 2026 and
 * the `Last-Modified` NOAA sent with each.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordFetchAttempt } from '../../src/fetch/freshness.js';
import type { HttpClient } from '../../src/fetch/response.js';
import { ingestSoundings, MAX_SOUNDING_SITES, NOAA_RAW_US_URL, NWS_API_URL, SoundingClient, SoundingError, soundingReport, SOUNDING_SOURCE } from '../../src/fetch/soundings.js';
import { SOUNDING_RADIUS_NM } from '../../src/resolve/wind.js';
import { MemoryStore } from '../../src/store/memory.js';

const DIR = join(__dirname, '..', 'fixtures', 'fetch', 'noaa', 'soundings-2026-11-09');
const file = (name: string) => readFileSync(join(DIR, name), 'latin1');
const MODIFIED = JSON.parse(readFileSync(join(DIR, 'last-modified.json'), 'utf8')) as Record<string, string>;
const NOW = new Date('2026-11-09T04:53:45Z');
const ALBANY = { lat: 42.748, lon: -73.802 };

describe('a file as a report', () => {
  it('is filed under the station, verbatim, at the hour it flew', () => {
    const r = soundingReport(file('usus41.kaly.man.aly.txt'), new Date(MODIFIED['usus41.kaly.man.aly.txt']!))!;
    expect(r).toMatchObject({ kind: 'upperwind', source: SOUNDING_SOURCE, station: '72518' });
    expect(r.issuedAt).toEqual(new Date('2026-11-09T00:00:00Z'));
    expect(r.body).toBe(file('usus41.kaly.man.aly.txt').trim());
  });

  it('is dated by when NOAA wrote the file, so one left behind for months stays old', () => {
    expect(soundingReport(file('usus45.kpsr.man.1y7.txt'), new Date('2026-07-22T17:30:00Z'))!.issuedAt).toEqual(new Date('2026-07-22T17:00:00Z'));
  });

  it('is nothing when the file holds no sounding', () => {
    expect(soundingReport('not a sounding', NOW)).toBeNull();
  });

  it('keeps a balloon that reported no levels, for the decoder to say so', () => {
    expect(soundingReport(file('usus43.koax.man.oax.txt'), NOW)!.station).toBe('72558');
  });
});

describe('through the relay', () => {
  const held = {
    'usus41.kaly.man.aly': { askedAt: NOW.toISOString(), modified: MODIFIED['usus41.kaly.man.aly.txt'], text: file('usus41.kaly.man.aly.txt') },
    'usus41.kbuf.man.buf': { askedAt: NOW.toISOString(), modified: MODIFIED['usus41.kbuf.man.buf.txt'], text: file('usus41.kbuf.man.buf.txt') },
    // Asked about, and NOAA did not answer the first time it was asked.
    'usus41.kcar.man.car': { askedAt: NOW.toISOString(), modified: null, text: '' },
  };
  const answering = (body: string): HttpClient => ({ get: async () => ({ status: 200, body, headers: {} }) });

  it('turns the whole copy into one report per station that has one', async () => {
    const { reports, request } = await new SoundingClient(answering(JSON.stringify(held)), 'https://relay.example/noaa/soundings').relayed(NOW);
    expect(request).toBe('https://relay.example/noaa/soundings');
    expect(reports.map((r) => r.station)).toEqual(['72518', '72528']);
  });

  it('says so when what came back is not the copy', async () => {
    await expect(new SoundingClient(answering('<html></html>'), 'https://r/noaa/soundings').relayed(NOW)).rejects.toBeInstanceOf(SoundingError);
    await expect(new SoundingClient(answering('[]'), 'https://r/noaa/soundings').relayed(NOW)).rejects.toThrow(/did not send the soundings/);
  });
});

describe('from the NWS product API', () => {
  const product = (location: string) => readFileSync(join(__dirname, '..', 'fixtures', 'fetch', 'noaa', 'alaska-2026-11-09', `${location}.json`), 'utf8');
  const answering = (body: string): HttpClient => ({ get: async () => ({ status: 200, body, headers: {} }) });

  it('reads the bulletin out of the product, dated by when it was issued', async () => {
    const { request, reports } = await new SoundingClient(answering(product('ANC'))).latestProduct('ANC', NOW);
    expect(request).toBe(`${NWS_API_URL}/products/types/MAN/locations/ANC/latest`);
    expect(reports[0]).toMatchObject({ station: '70273', source: SOUNDING_SOURCE, issuedAt: new Date('2026-11-09T00:00:00Z') });
  });

  it('says so when what came back is not a product', async () => {
    await expect(new SoundingClient(answering('<html></html>')).latestProduct('ANC', NOW)).rejects.toBeInstanceOf(SoundingError);
    await expect(new SoundingClient(answering('{"title":"Not Found"}')).latestProduct('ANC', NOW)).rejects.toThrow(/no bulletin/);
  });
});

describe('fetched for a route', () => {
  function recordedNoaa() {
    const asked: string[] = [];
    const http: HttpClient = {
      async get(url) {
        asked.push(url);
        if (url.startsWith(NWS_API_URL)) return { status: 200, body: readFileSync(join(__dirname, '..', 'fixtures', 'fetch', 'noaa', 'alaska-2026-11-09', `${url.split('/').at(-2)}.json`), 'utf8'), headers: {} };
        const name = url.slice(NOAA_RAW_US_URL.length + 1);
        return { status: 200, body: file(name), headers: { 'last-modified': new Date(MODIFIED[name]!).toUTCString() } };
      },
    };
    return { asked, soundings: new SoundingClient(http) };
  }

  it('asks only for the balloons nearest the route, one request each', async () => {
    const { asked, soundings } = recordedNoaa();
    const store = new MemoryStore();
    const result = await ingestSoundings({ store, soundings, now: () => NOW }, [ALBANY], SOUNDING_RADIUS_NM);
    expect(asked.map((u) => u.slice(NOAA_RAW_US_URL.length + 1))).toEqual(['usus41.kaly.man.aly.txt', 'usus41.kokx.man.okx.txt']);
    expect(result.sites).toEqual(['72518', '72501']);
    expect((await store.listRaw({ station: '72518', kind: 'upperwind' }))[0]!.issuedAt).toEqual(new Date('2026-11-09T00:00:00Z'));
  });

  it('goes to the NWS API for an Alaskan balloon', async () => {
    const { asked, soundings } = recordedNoaa();
    const store = new MemoryStore();
    await ingestSoundings({ store, soundings, now: () => NOW }, [{ lat: 61.174, lon: -149.998 }], SOUNDING_RADIUS_NM);
    expect(asked[0]).toBe(`${NWS_API_URL}/products/types/MAN/locations/ANC/latest`);
    expect((await store.listRaw({ station: '70273', kind: 'upperwind' }))).toHaveLength(1);
  });

  it('does not ask again within the hour', async () => {
    const { asked, soundings } = recordedNoaa();
    const store = new MemoryStore();
    await recordFetchAttempt(store, '72518', 'upperwind', NOW, 'earlier');
    const result = await ingestSoundings({ store, soundings, now: () => new Date(NOW.getTime() + 60_000) }, [ALBANY], SOUNDING_RADIUS_NM);
    expect(asked).toHaveLength(1);
    expect(result.skipped.map((s) => s.station)).toEqual(['72518']);
  });

  it('never asks about more than a handful, however long the route', async () => {
    const { asked, soundings } = recordedNoaa();
    await ingestSoundings({ store: new MemoryStore(), soundings, now: () => NOW }, [ALBANY, { lat: 40.5, lon: -80.2 }, { lat: 38.9, lon: -94 }, { lat: 39, lon: -105 }, { lat: 34, lon: -112 }], SOUNDING_RADIUS_NM);
    expect(asked.length).toBeLessThanOrEqual(MAX_SOUNDING_SITES);
  });
});
