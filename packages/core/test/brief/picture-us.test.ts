/**
 * The route picture of an American flight, over the products of 04:53Z on
 * 9 November 2026: the METARs and TAFs along the route, the G-AIRMETs, and
 * what the 00Z balloons measured. Albany to Pittsburgh goes under an icing
 * AIRMET, a low turbulence AIRMET that lasts two pictures, and a high
 * turbulence AIRMET that has nothing to do with a Cessna.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { routePicture, type RoutePicture } from '../../src/brief/picture.js';
import { CatalogStore, type AirportCell, type AirportIndex } from '../../src/demo/airports.js';
import { parseFlightPlan } from '../../src/domain/flight.js';
import { AwcClient } from '../../src/fetch/awc.js';
import { AwcCacheClient } from '../../src/fetch/awcCache.js';
import type { HttpClient } from '../../src/fetch/response.js';
import { soundingReport } from '../../src/fetch/soundings.js';
import { resolveFlight } from '../../src/resolve/flight.js';
import { storeAndDecode } from '../../src/store/decode.js';

const FETCH = join(__dirname, '..', 'fixtures', 'fetch');
const NE = join(FETCH, 'northeast-2026-11-09');
const SND = join(FETCH, 'noaa', 'soundings-2026-11-09');
const DEMO = join(__dirname, '..', '..', '..', '..', 'apps', 'web', 'public', 'demo', 'airports');
const RECORDED = new Date('2026-11-09T04:53:45Z');
const MODIFIED = JSON.parse(readFileSync(join(SND, 'last-modified.json'), 'utf8')) as Record<string, string>;

const http: HttpClient = {
  async get(url) {
    const name = url.includes('metars') ? 'metars.cache.csv' : url.includes('tafs') ? 'tafs.cache.xml' : url.includes('gairmets') ? 'gairmets.cache.xml' : 'sigmet.json';
    return { status: 200, body: readFileSync(join(NE, name), 'utf8'), headers: {} };
  },
};

async function seeded(): Promise<CatalogStore> {
  const store = new CatalogStore(JSON.parse(readFileSync(join(DEMO, 'index.json'), 'utf8')) as AirportIndex, async (name) => JSON.parse(readFileSync(join(DEMO, `${name}.json`), 'utf8')) as AirportCell);
  const cache = new AwcCacheClient(http, 'https://relay.example/awc/cache');
  for (const batch of [await cache.metars(), await cache.tafs()]) await storeAndDecode(store, batch.reports, batch.request, RECORDED);
  const hazards = await new AwcClient(http, 'https://relay.example/awc').sigmets();
  await storeAndDecode(store, hazards.reports, hazards.request, RECORDED, 'WORLD');
  const gairmets = await cache.gairmets();
  await storeAndDecode(store, gairmets.reports, gairmets.request, RECORDED, 'WORLD');
  const soundings = readdirSync(SND)
    .filter((n) => n.endsWith('.txt'))
    .flatMap((n) => soundingReport(readFileSync(join(SND, n), 'latin1'), new Date(MODIFIED[n] ?? RECORDED)) ?? []);
  await storeAndDecode(store, soundings, 'recorded', RECORDED);
  return store;
}

let store: CatalogStore;
beforeAll(async () => {
  store = await seeded();
});

async function pictureOf(departure: string, destination: string, departureTime: string, altitude = 6500): Promise<RoutePicture> {
  const plan = parseFlightPlan({ departure, destination, alternate: null, route: [], departureTime, cruise: { tas: 110, altitude }, airspace: null });
  return routePicture(store, await resolveFlight(store, plan, RECORDED));
}

describe('the freezing level on a US route', () => {
  it('is what the balloons measured, one mark for each balloon the route reads from', async () => {
    const p = await pictureOf('KALB', 'KPIT', '2026-11-09T05:30:00Z');
    expect(p.freezing.map((f) => [f.station, Math.round(f.nm), f.crossingsFt, f.belowFt, f.measuredAt])).toEqual([
      ['Albany', 0, [5800], null, '2026-11-09T00:00:00.000Z'],
      ['Buffalo', 200, [5300], null, '2026-11-09T00:00:00.000Z'],
      ['Pittsburgh', 319, [7200], null, '2026-11-09T00:00:00.000Z'],
    ]);
  });

  it('says how far off the balloon was', async () => {
    const p = await pictureOf('KBOS', 'KPHL', '2026-11-09T07:30:00Z');
    expect(p.freezing.map((f) => [f.station, Math.round(f.distanceNm)])).toEqual([
      ['Gray', 98],
      ['Upton', 22],
      ['Sterling', 116],
    ]);
  });
});

describe('G-AIRMETs on the picture', () => {
  it('draws one hazard for all the pictures of it you are under, with every area it covers', async () => {
    const p = await pictureOf('KALB', 'KPIT', '2026-11-09T05:30:00Z');
    expect(p.hazards.map((h) => [h.kind, h.region, h.what, h.baseFt, h.topFt])).toEqual([
      ['airmet', 'ZULU 4C', 'airframe icing', 3000, 15000],
      ['airmet', 'TANGO 3W', 'turbulence', 0, 8000],
    ]);
    const turbulence = p.hazards[1]!;
    expect(turbulence.laterAreas).toHaveLength(1);
    expect(turbulence.validFrom).toBe('2026-11-09T04:30:00.000Z');
    expect(turbulence.validTo).toBe('2026-11-09T10:30:00.000Z');
    // Handed from the 06Z picture to the 09Z one with no join to be seen.
    expect(turbulence.stretches.map((s) => [Math.round(s.fromNm), Math.round(s.toNm)])).toEqual([[2, 288]]);
    expect(turbulence.stretches[0]).toMatchObject({ startsInside: false, endsInside: false });
  });

  it('leaves out what starts above the cruise, and draws it once you are that high', async () => {
    const low = await pictureOf('KALB', 'KPIT', '2026-11-09T05:30:00Z');
    expect(low.hazards.map((h) => h.region)).not.toContain('TANGO 4W');
    const high = await pictureOf('KALB', 'KPIT', '2026-11-09T05:30:00Z', 19000);
    expect(high.hazards.map((h) => h.region)).toContain('TANGO 4W');
  });

  it('never excuses a picture of hours the flight is somewhere else', async () => {
    expect((await pictureOf('KALB', 'KPIT', '2026-11-09T05:30:00Z')).hazardsMissed).toEqual([]);
  });

  it('draws nothing for a picture that only touches the moment you take off', async () => {
    // Departing 07:30Z: the 06Z picture has just ended, and its icing was over the route.
    const p = await pictureOf('KBOS', 'KPHL', '2026-11-09T07:30:00Z');
    expect(p.hazards.map((h) => h.region)).toEqual(['TANGO 3W']);
  });

  it('says what an area of IFR or obscured mountains is made of', async () => {
    const p = await pictureOf('KBUF', 'KALB', '2026-11-09T13:30:00Z');
    expect(p.hazards.find((h) => h.region === 'SIERRA 1E')).toMatchObject({ what: 'mountain obscuration (MTNS OBSC BY CLDS PCPN BR)', baseFt: null, topFt: null });
  });
});
