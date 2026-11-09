/**
 * Cloud heights in a borrowed report, over the TAFs and METARs of 04:53Z on
 * 9 November 2026. A report's heights are above the station that made it, so
 * a field reading a neighbour's has to use the neighbour's ground to know
 * where that cloud is.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { CatalogStore, type AirportCell, type AirportIndex } from '../../src/demo/airports.js';
import { parseFlightPlan } from '../../src/domain/flight.js';
import { parseAircraftLimits, parsePilotProfile } from '../../src/domain/profile.js';
import { AwcCacheClient } from '../../src/fetch/awcCache.js';
import type { HttpClient } from '../../src/fetch/response.js';
import { resolveFlight } from '../../src/resolve/flight.js';
import { evaluateFlight } from '../../src/rules/evaluate.js';
import { storeAndDecode } from '../../src/store/decode.js';

const NE = join(__dirname, '..', 'fixtures', 'fetch', 'northeast-2026-11-09');
const DEMO = join(__dirname, '..', '..', '..', '..', 'apps', 'web', 'public', 'demo', 'airports');
const RECORDED = new Date('2026-11-09T04:53:45Z');
const profile = parsePilotProfile({ version: 1, name: 'default', ceilingAglFt: 2500, visibilitySm: 5, crosswindKt: 15, crosswindIncludesGust: true });
const c172 = parseAircraftLimits({ type: 'C172', demonstratedCrosswindKt: 15 });
const http: HttpClient = { get: async (url) => ({ status: 200, body: readFileSync(join(NE, url.includes('metars') ? 'metars.cache.csv' : 'tafs.cache.xml'), 'utf8'), headers: {} }) };

let store: CatalogStore;
beforeAll(async () => {
  store = new CatalogStore(JSON.parse(readFileSync(join(DEMO, 'index.json'), 'utf8')) as AirportIndex, async (name) => JSON.parse(readFileSync(join(DEMO, `${name}.json`), 'utf8')) as AirportCell);
  const cache = new AwcCacheClient(http, 'https://relay.example/awc/cache');
  for (const batch of [await cache.metars(), await cache.tafs()]) await storeAndDecode(store, batch.reports, batch.request, RECORDED);
});

async function clearanceAt(field: string, altitude: number) {
  const plan = parseFlightPlan({ departure: field, destination: 'KROC', alternate: null, route: [], departureTime: '2026-11-09T06:00:00Z', cruise: { tas: 110, altitude }, airspace: { [field]: 'E' } });
  const briefing = evaluateFlight(await resolveFlight(store, plan, RECORDED), profile, c172);
  return briefing.points[0]!.findings.filter((f) => f.rule === 'vfr.cloudClearance' && f.basisKind === 'prevailing');
}

describe('cloud clearance from a borrowed TAF', () => {
  it('finds the cloud a pilot would be in, over a field higher than the station', async () => {
    // Arcade, 1,745 ft, on Buffalo's TAF, 728 ft: OVC035 is 4,228 ft, under a 4,500 ft cruise. Measured from Arcade it would be 745 ft above it.
    const [f] = await clearanceAt('KD23', 4500);
    expect(f).toMatchObject({ attention: 'alert', values: { baseMsl: 4228, clearance: -272, cruiseMsl: 4500 } });
    expect(f!.basis).toContain('TAF KBUF');
    expect(f!.summary).toContain('base 4228 ft MSL is 272 ft below your 4500 ft cruise');
  });

  it('does not invent cloud over a field lower than the station', async () => {
    // Dunkirk, 693 ft, on Jamestown's TAF, 1,723 ft: OVC035 is 5,223 ft. Measured from Dunkirk it would be 4,193 ft, under this cruise.
    const [f] = await clearanceAt('KDKK', 4500);
    expect(f).toMatchObject({ attention: 'routine', values: { baseMsl: 5223, clearance: 723 } });
  });

  it('leaves a field reading its own TAF as it was', async () => {
    const [f] = await clearanceAt('KBUF', 4500);
    expect(f!.basis).not.toContain('TAF');
    expect(f!.values['baseMsl']).toBe(4228);
  });
});
