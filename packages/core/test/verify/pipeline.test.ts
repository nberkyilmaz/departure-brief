/**
 * The whole verification loop over real recorded weather: brief a flight,
 * let its moment pass, and check what the TAF promised against what the
 * METAR said.
 *
 * KJFK's 0711 38Z TAF forecast the base period as `34007KT P6SM SKC`, and
 * the 1151Z observation came in `34007KT 10SM CLR`. A forecast that was
 * right is as much a test of the machinery as one that was wrong — and the
 * fixtures are real, so this is a real verification.
 */
import { describe, expect, it } from 'vitest';
import { parseFlightPlan } from '../../src/domain/flight.js';
import { AWC_BASE_URL, AwcClient } from '../../src/fetch/awc.js';
import { storeAndDecode } from '../../src/fetch/ingest.js';
import { readNasrDirectory } from '../../src/fetch/nasr.js';
import { resolveFlight } from '../../src/resolve/flight.js';
import { MemoryStore } from '../../src/store/memory.js';
import { checksFrom } from '../../src/verify/record.js';
import { matchOutstanding, outstandingChecks, recordForecastChecks } from '../../src/verify/run.js';
import { reliabilityOf, scorePair } from '../../src/verify/score.js';
import { join } from 'node:path';
import { FIXTURES, replayHttp } from '../helpers/http.js';

const BRIEFED_AT = new Date('2026-09-07T11:45:00Z');
// The TAF is valid 0712/0818, so a moment before 12:00Z is outside it and the
// forecast asserts nothing — which the resolver is right to say.
const DEPARTS = '2026-09-07T12:00:00.000Z';
const LATER = new Date('2026-09-07T13:00:00Z');

const plan = parseFlightPlan({
  departure: 'KJFK',
  destination: 'KTEB',
  alternate: null,
  route: [],
  departureTime: DEPARTS,
  cruise: { tas: 110, altitude: 4500 },
});

async function briefedStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.putAirports(readNasrDirectory(join(FIXTURES, 'nasr', '2026-09-03')));
  const awc = new AwcClient(
    replayHttp({
      [`${AWC_BASE_URL}/taf?ids=KJFK,KTEB,KHPN&format=json`]: { status: 200, file: 'awc/taf-KJFK-KTEB-KHPN.json' },
      [`${AWC_BASE_URL}/metar?ids=KJFK&format=json&hours=6`]: { status: 200, file: 'awc/metar-KJFK-6h.json' },
    }),
  );
  // Known at briefing time: the 1138Z TAFs, and KJFK's observations up to then.
  const t = await awc.tafs(['KJFK', 'KTEB', 'KHPN']);
  await storeAndDecode(store, t.reports, t.request, new Date('2026-09-07T11:40:00Z'));
  const m = await awc.metars(['KJFK'], { hours: 6 });
  await storeAndDecode(store, m.reports, m.request, new Date('2026-09-07T11:55:00Z'));
  return store;
}

describe('forecast verification, end to end', () => {
  it('records what the forecast asserted for each waypoint at its ETA', async () => {
    const store = await briefedStore();
    const resolved = await resolveFlight(store, plan, BRIEFED_AT);
    const checks = checksFrom(resolved, BRIEFED_AT);
    const jfk = checks.find((c) => c.station === 'KJFK')!;
    expect(jfk.validAt.toISOString()).toBe(DEPARTS);
    // `34007KT P6SM SKC`: clear, so no ceiling, and better than six miles.
    expect(jfk.ceilingFt).toBeNull();
    expect(jfk.visibilitySm).toBeGreaterThanOrEqual(6);
    expect(jfk.windDirTrue).toBe(340);
    expect(jfk.windKt).toBe(7);
    expect(jfk.category).toBe('VFR');
    expect(jfk.tafIssuedAt?.toISOString()).toBe('2026-09-07T11:38:00.000Z');
    expect(jfk.leadHours).toBeCloseTo(0.4, 1);

    const recorded = await recordForecastChecks(store, resolved, BRIEFED_AT);
    expect(recorded.recorded).toBe(checks.length);
    // Briefing the same flight again adds nothing: the prediction is the same prediction.
    expect((await recordForecastChecks(store, resolved, BRIEFED_AT)).recorded).toBe(0);
  });

  it('will not answer a question whose moment has not arrived', async () => {
    const store = await briefedStore();
    await recordForecastChecks(store, await resolveFlight(store, plan, BRIEFED_AT), BRIEFED_AT);
    const early = await matchOutstanding({ store }, { before: new Date('2026-09-07T11:00:00Z') });
    expect(early.considered).toBe(0);
    expect(early.matched).toBe(0);
    expect((await outstandingChecks(store, LATER)).length).toBeGreaterThan(0);
  });

  it('pairs the forecast with the observation nearest its moment, and scores it', async () => {
    const store = await briefedStore();
    await recordForecastChecks(store, await resolveFlight(store, plan, BRIEFED_AT), BRIEFED_AT);

    const report = await matchOutstanding({ store }, { before: LATER });
    expect(report.stations).toContain('KJFK');
    expect(report.matched).toBeGreaterThanOrEqual(1);
    // Matching again pairs nothing new; an outcome is written once.
    expect((await matchOutstanding({ store }, { before: LATER })).matched).toBe(0);

    const pairs = await store.listVerificationPairs({ station: 'KJFK' });
    expect(pairs).toHaveLength(1);
    const s = scorePair(pairs[0]!);
    // The 1151Z observation is the closest to 12:00Z, nine minutes before it.
    expect(s.offsetMinutes).toBe(-9);
    expect(s.observed.category).toBe('VFR');
    expect(s.forecast.category).toBe('VFR');
    expect(s.categoryMatched).toBe(true);
    // Both clear of cloud, so there is no ceiling to compare and none is invented.
    expect(s.ceilingErrorFt).toBeNull();
    expect(s.ceiling).toBeNull();
    // Forecast better than six miles, observed ten: within tolerance of each other.
    expect(s.visibility).toBe('close');

    const r = reliabilityOf('KJFK', pairs);
    expect(r.pairs).toBe(1);
    expect(r.categoryAgreement).toBe(1);
    expect(r.categoryOptimistic).toBe(0);
  });

  it('leaves a moment with no observation near it waiting, rather than pairing it with something far off', async () => {
    const store = await briefedStore();
    // KTEB is on the route but its observations were never fetched.
    const resolved = await resolveFlight(store, plan, BRIEFED_AT);
    await recordForecastChecks(store, resolved, BRIEFED_AT);
    const report = await matchOutstanding({ store }, { before: LATER });
    expect(report.noObservation.some((n) => n.station === 'KTEB')).toBe(true);
    // Still outstanding, so a later pass will try again.
    expect((await outstandingChecks(store, LATER)).some((c) => c.station === 'KTEB')).toBe(true);
  });
});
