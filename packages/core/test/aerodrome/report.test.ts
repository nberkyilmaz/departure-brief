import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { aerodromeReport } from '../../src/aerodrome/report.js';
import { AWC_BASE_URL, AwcClient } from '../../src/fetch/awc.js';
import { ingestNeighbourhood } from '../../src/fetch/neighbourhood.js';
import { readOurAirportsDirectory } from '../../src/fetch/ourairports.js';
import { parsePilotProfile } from '../../src/domain/profile.js';
import { MemoryStore } from '../../src/store/memory.js';
import { FIXTURES, replayHttp } from '../helpers/http.js';

/**
 * One field, reported on without a flight plan.
 *
 * The instant is 03:40Z on 19 September 2026 — half past eleven at night in
 * St. Catharines, with CYSN closed and KIAG reporting across the river.
 * Every report here is the real one the AWC returned for that box.
 */

const CYSN = { lat: 43.191598, lon: -79.171686 };
const NIGHT = new Date('2026-09-19T03:40:00Z');
const BOX = `${AWC_BASE_URL}/metar?bbox=42,-81.41,45,-77.59&format=json`;

const PROFILE = parsePilotProfile({
  version: 1,
  name: 'test',
  ceilingAglFt: 2500,
  visibilitySm: 5,
  crosswindKt: 15,
  crosswindIncludesGust: true,
});

async function niagaraStore() {
  const store = new MemoryStore();
  await store.putAirports(readOurAirportsDirectory(join(FIXTURES, 'ourairports', '2026-09-19-niagara'), { snapshot: '2026-09-19' }));
  await ingestNeighbourhood({ store, awc: new AwcClient(replayHttp({ [BOX]: { status: 200, file: 'awc/metar-bbox-CYSN.json' } })) }, CYSN, 'CYSN', NIGHT);
  return store;
}

describe('reporting on a field that has gone to bed', () => {
  it('borrows the nearest current observation and says whose it is', async () => {
    const report = await aerodromeReport(await niagaraStore(), 'CYSN', NIGHT, PROFILE, null);
    expect(report).not.toBeNull();
    expect(report!.airport.icaoId).toBe('CYSN');
    expect(report!.observation?.source).toBe('nearby');
    expect(report!.observation?.station).toBe('KIAG');
    expect(report!.findings.some((f) => f.rule === 'observation.borrowed')).toBe(true);
  });

  it('knows it is night there', async () => {
    const report = await aerodromeReport(await niagaraStore(), 'CYSN', NIGHT, PROFILE, null);
    expect(report!.night).toBe(true);
    expect(report!.daylight.civilDusk).not.toBeNull();
  });

  it('returns null for a field it has never heard of, rather than an empty report', async () => {
    expect(await aerodromeReport(await niagaraStore(), 'ZZZZ', NIGHT, PROFILE, null)).toBeNull();
  });
});

describe('the wind on each runway', () => {
  it('puts the runway most into wind first', async () => {
    const report = await aerodromeReport(await niagaraStore(), 'CYSN', NIGHT, PROFILE, null);
    const crosswind = report!.crosswind;
    expect(crosswind).not.toBeNull();

    // KIAG reported 36005KT. CYSN's 01 lies on 358.3° true, so the wind is
    // within two degrees of straight down it.
    expect(crosswind!.speed).toBe(5);
    expect(crosswind!.runways[0]?.end).toBe('01');
    expect(crosswind!.runways[0]?.crosswind).toBeLessThan(0.5);
    expect(crosswind!.runways[0]?.headwind).toBeGreaterThan(4.9);
  });

  it('reports a tailwind as a negative headwind rather than hiding it', async () => {
    const report = await aerodromeReport(await niagaraStore(), 'CYSN', NIGHT, PROFILE, null);
    const reciprocal = report!.crosswind!.runways.find((r) => r.end === '19');
    expect(reciprocal).toBeDefined();
    expect(reciprocal!.headwind).toBeLessThan(-4.9);
  });

  it('covers every runway end the field has a heading for', async () => {
    const report = await aerodromeReport(await niagaraStore(), 'CYSN', NIGHT, PROFILE, null);
    // Three runways, two ends each.
    expect(report!.crosswind!.runways.map((r) => r.end).sort()).toEqual(['01', '11', '19', '24', '06', '29'].sort());
    expect(report!.crosswind!.unknownHeading).toEqual([]);
  });

  it('is absent rather than zero when there is no observation to take a wind from', async () => {
    const store = new MemoryStore();
    await store.putAirports(readOurAirportsDirectory(join(FIXTURES, 'ourairports', '2026-09-19-niagara'), { snapshot: '2026-09-19' }));
    const report = await aerodromeReport(store, 'CYSN', NIGHT, PROFILE, null);
    expect(report!.observation).toBeNull();
    expect(report!.crosswind).toBeNull();
  });
});
