/**
 * Which pilot reports belong on a flight's picture, over the AWC's file of
 * 05:59Z on 9 November 2026 and the country's real aerodromes. Albany to
 * Pittsburgh goes straight over a report of moderate rime icing near Ithaca.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { PIREP_ABOVE_CRUISE_FT, PIREP_CORRIDOR_NM, pirepsAlong } from '../../src/brief/pireps.js';
import { CatalogStore, type AirportCell, type AirportIndex } from '../../src/demo/airports.js';
import { parseFlightPlan } from '../../src/domain/flight.js';
import { parseAircraftReportCache } from '../../src/fetch/awcCache.js';
import { resolveFlight } from '../../src/resolve/flight.js';
import { storeAndDecode } from '../../src/store/decode.js';

const FILE = join(__dirname, '..', 'fixtures', 'fetch', 'pireps-2026-11-09', 'aircraftreports.cache.xml');
const DEMO = join(__dirname, '..', '..', '..', '..', 'apps', 'web', 'public', 'demo', 'airports');
const RECORDED = new Date('2026-11-09T05:59:55Z');

const newStore = () => new CatalogStore(JSON.parse(readFileSync(join(DEMO, 'index.json'), 'utf8')) as AirportIndex, async (name) => JSON.parse(readFileSync(join(DEMO, `${name}.json`), 'utf8')) as AirportCell);

let store: CatalogStore;
beforeAll(async () => {
  store = newStore();
  await storeAndDecode(store, parseAircraftReportCache(readFileSync(FILE, 'utf8'), 'recorded'), 'recorded', RECORDED, 'WORLD');
});

async function along(departure: string, destination: string, departureTime: string, altitude = 6500, asOf = RECORDED, from = store) {
  const plan = parseFlightPlan({ departure, destination, alternate: null, route: [], departureTime, cruise: { tas: 110, altitude }, airspace: null });
  return pirepsAlong(from, await resolveFlight(from, plan, asOf));
}

describe('the reports beside a flight', () => {
  it('are in the order you pass them, each at the nearest point of the route', async () => {
    const { pireps, held } = await along('KALB', 'KPIT', '2026-11-09T06:15:00Z');
    expect(held).toBe(23);
    expect(pireps.map((p) => [p.station, Math.round(p.nm), Math.round(p.offsetNm), p.altitudeFt])).toEqual([
      ['ITH', 144, 0, 9500],
      ['JST', 266, -38, 1000],
    ]);
  });

  it('count out to 50 nm either side, and no further', async () => {
    expect(PIREP_CORRIDOR_NM).toBe(50);
    const { pireps } = await along('KALB', 'KPIT', '2026-11-09T06:15:00Z');
    expect(pireps.every((p) => Math.abs(p.offsetNm) <= 50)).toBe(true);
    // Burlington's report is well north of this line.
    expect(pireps.map((p) => p.station)).not.toContain('BTV');
  });

  it('take in the ones around the field at each end, past where the line stops', async () => {
    const { pireps } = await along('KFSD', 'KDEN', '2026-11-09T06:15:00Z', 9500);
    expect(pireps.map((p) => p.station)).toEqual(['FSD', 'DEN', 'DEN']);
    expect(Math.round(pireps[0]!.nm)).toBe(0);
    expect(Math.round(pireps[1]!.nm)).toBe(420);
  });

  it('leave out what is well above you, and keep what has no height', async () => {
    expect(PIREP_ABOVE_CRUISE_FT).toBe(6000);
    // Ithaca's 9,500 ft is more than 6,000 above a 3,000 ft cruise.
    expect((await along('KALB', 'KPIT', '2026-11-09T06:15:00Z', 3000)).pireps.map((p) => p.station)).toEqual(['JST']);
    const { pireps } = await along('KFSD', 'KDEN', '2026-11-09T06:15:00Z', 9500);
    expect(pireps[2]).toMatchObject({ altitudeFt: null, phase: 'descending' });
  });

  it('say when one was made too long before you would reach it to speak for then', async () => {
    const near = await along('KFSD', 'KDEN', '2026-11-09T06:15:00Z', 9500);
    // Thirty-five minutes before you take off from beside it.
    expect(near.pireps[0]!.speaksForThen).toBe(true);
    // Over four hours before you would get to Denver.
    expect(near.pireps[1]!.speaksForThen).toBe(false);
  });

  it('stop being drawn at ninety minutes old, and not before they were known', async () => {
    const later = await along('KALB', 'KPIT', '2026-11-09T07:00:00Z', 6500, new Date('2026-11-09T06:53:00Z'));
    // Ithaca's was made at 05:22 and Johnstown's at 05:27.
    expect(later.pireps.map((p) => p.station)).toEqual(['JST']);
    expect((await along('KALB', 'KPIT', '2026-11-09T07:00:00Z', 6500, new Date('2026-11-09T05:00:00Z'))).held).toBe(0);
  });

  it('are none, and none held, when nothing has been fetched', async () => {
    expect(await along('KALB', 'KPIT', '2026-11-09T06:15:00Z', 6500, RECORDED, newStore())).toEqual({ pireps: [], held: 0 });
  });
});
