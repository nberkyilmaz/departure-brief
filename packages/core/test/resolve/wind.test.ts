/**
 * Choosing the upper wind forecast that applies, out of the six a site
 * publishes, and carrying it to a waypoint that has none of its own.
 *
 * Everything here runs on the records NAV CANADA served for Toronto on
 * 14 September 2026, replayed through the real client, over the real
 * geography of southern Ontario.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeUpperWind } from '../../src/decode/upperwind/decode.js';
import type { HttpClient } from '../../src/fetch/http.js';
import { NAVCANADA_CFPS_BASE_URL, NavCanadaClient } from '../../src/fetch/navcanada.js';
import { readOurAirportsDirectory } from '../../src/fetch/ourairports.js';
import { upperWindFor, windAt, UPPERWIND_RADIUS_NM } from '../../src/resolve/wind.js';
import { storeAndDecode } from '../../src/store/decode.js';
import { MemoryStore } from '../../src/store/memory.js';

const FIXTURES = join(__dirname, '..', 'fixtures', 'fetch');
const UPPERWIND = join(FIXTURES, 'navcanada', 'upperwind', '2026-09-14');

/** Serves the recorded upper wind responses and nothing else. */
const replay: HttpClient = {
  async get(url) {
    const m = /site=([A-Z0-9]{3,4})&alpha=upperwind$/.exec(url);
    if (!m) throw new Error(`no recorded response for ${url}`);
    return { status: 200, body: readFileSync(join(UPPERWIND, `${m[1]}.json`), 'utf8'), headers: {} };
  },
};

/** The store as it would be after a briefing fetched Toronto's upper winds. */
async function seeded(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.putAirports(readOurAirportsDirectory(join(FIXTURES, 'ourairports', '2026-09-07'), { snapshot: '2026-09-07' }));
  const fetched = await new NavCanadaClient(replay).upperWinds('CYYZ');
  await storeAndDecode(store, fetched.reports, fetched.request, new Date('2026-09-14T04:30:00Z'), 'CYYZ');
  return store;
}

const ASOF = new Date('2026-09-14T04:30:00Z');
/** Inside the first bulletin's window (02:00–09:00Z on the 14th). */
const MORNING = new Date('2026-09-14T06:00:00Z');
/** Inside the second (09:00–18:00Z). */
const AFTERNOON = new Date('2026-09-14T12:00:00Z');

describe('the client', () => {
  it('stores every record under the aerodrome a flight plan would name', async () => {
    const fetched = await new NavCanadaClient(replay).upperWinds('CYYZ');
    // Six: three bulletins, each issued for the low levels and the high ones.
    expect(fetched.reports).toHaveLength(6);
    // The service says "YYZ"; a plan says "CYYZ".
    expect(new Set(fetched.reports.map((r) => r.station))).toEqual(new Set(['CYYZ']));
    expect(fetched.reports.every((r) => r.kind === 'upperwind')).toBe(true);
    // The body is the record exactly as it arrived, which is what spans index into.
    expect(fetched.reports.every((r) => decodeUpperWind(r.body).levels.length > 0)).toBe(true);
  });
});

describe('upperWindFor', () => {
  it('picks the bulletin whose window covers the time, and whose levels reach the altitude', async () => {
    const store = await seeded();
    const morning = (await upperWindFor(store, 'CYYZ', 3500, MORNING, ASOF))!;
    expect(morning.forecast.useFrom!.value.getTime()).toBeLessThanOrEqual(MORNING.getTime());
    expect(morning.forecast.useTo!.value.getTime()).toBeGreaterThan(MORNING.getTime());
    // 3,500 ft is the low-level office's product, not the one starting at 24,000.
    expect(morning.forecast.issuer?.value).toBe('CWAO');
    expect(morning.wind.basis).toBe('interpolated');
    expect(morning.wind.from.map((l) => l.altitudeFt)).toEqual([3000, 6000]);

    // A later flight gets a different bulletin, not the same one stretched.
    const afternoon = (await upperWindFor(store, 'CYYZ', 3500, AFTERNOON, ASOF))!;
    expect(afternoon.report.sha256).not.toBe(morning.report.sha256);
  });

  it('gives the high-level bulletin to something flying in the flight levels', async () => {
    const store = await seeded();
    const high = (await upperWindFor(store, 'CYYZ', 34000, MORNING, ASOF))!;
    expect(high.forecast.issuer?.value).toBe('KWNO');
    expect(high.wind.basis).toBe('level');
    expect(high.wind.from[0]!.altitudeFt).toBe(34000);
  });

  it('has nothing to say about a time no bulletin covers', async () => {
    const store = await seeded();
    // A week later: the records are still stored, and none of them applies.
    expect(await upperWindFor(store, 'CYYZ', 3500, new Date('2026-09-21T06:00:00Z'), ASOF)).toBeNull();
  });

  it('uses only what was known by the briefing instant', async () => {
    const store = await seeded();
    expect(await upperWindFor(store, 'CYYZ', 3500, MORNING, new Date('2026-09-14T04:00:00Z'))).toBeNull();
  });

  it('has nothing to say about a site it holds no forecast for', async () => {
    const store = await seeded();
    expect(await upperWindFor(store, 'CYSN', 3500, MORNING, ASOF)).toBeNull();
  });
});

describe('windAt', () => {
  const CYSN = { lat: 43.191598, lon: -79.171686 };

  it('borrows Toronto for a field that has no forecast of its own, and says how far', async () => {
    const store = await seeded();
    const at = (await windAt(store, CYSN, 'CYSN', 3500, MORNING, ASOF))!;
    expect(at.station).toBe('CYYZ');
    expect(at.source).toBe('nearby');
    // St. Catharines to Toronto is about 40 nm across the lake.
    expect(at.distance).toBeGreaterThan(20);
    expect(at.distance).toBeLessThan(UPPERWIND_RADIUS_NM);
    expect(at.wind.speedKt).toBeGreaterThanOrEqual(0);
  });

  it('will not reach past the radius for one', async () => {
    const store = await seeded();
    // Somewhere over Quebec: Toronto is hundreds of miles away and its
    // forecast says nothing useful there.
    expect(await windAt(store, { lat: 46.8, lon: -71.2 }, null, 3500, MORNING, ASOF)).toBeNull();
  });
});
