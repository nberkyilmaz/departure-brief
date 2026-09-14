/**
 * Route, ETA and end-to-end flight resolution over a memory store seeded from
 * the recorded AWC responses and the NASR fixture slice. No network.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFlightPlan } from '../../src/domain/flight.js';
import { distanceNm, initialCourse, parseLatLon } from '../../src/domain/geo.js';
import { resolveNearestDayTime } from '../../src/domain/time.js';
import { AWC_BASE_URL, AwcClient } from '../../src/fetch/awc.js';
import { storeAndDecode } from '../../src/store/decode.js';
import { readNasrDirectory } from '../../src/fetch/nasr.js';
import { flightText } from '../../src/resolve/describe.js';
import { resolveFlight } from '../../src/resolve/flight.js';
import { resolveRoute, UnknownWaypointError } from '../../src/resolve/route.js';
import { MemoryStore } from '../../src/store/memory.js';
import { FIXTURES, replayHttp } from '../helpers/http.js';

const KJFK = { lat: 40.63992805, lon: -73.77869222 };
const KTEB = { lat: 40.85010278, lon: -74.06083333 };

async function seededStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.putAirports(readNasrDirectory(join(FIXTURES, 'nasr', '2026-09-03')));
  const awc = new AwcClient(
    replayHttp({
      [`${AWC_BASE_URL}/metar?ids=KJFK,KTEB,KHPN&format=json`]: { status: 200, file: 'awc/metar-KJFK-KTEB-KHPN.json' },
      [`${AWC_BASE_URL}/taf?ids=KJFK,KTEB,KHPN&format=json`]: { status: 200, file: 'awc/taf-KJFK-KTEB-KHPN.json' },
    }),
  );
  const fetched = new Date('2026-09-07T12:00Z');
  const m = await awc.metars(['KJFK', 'KTEB', 'KHPN']);
  await storeAndDecode(store, m.reports, m.request, fetched);
  const t = await awc.tafs(['KJFK', 'KTEB', 'KHPN']);
  await storeAndDecode(store, t.reports, t.request, fetched);
  return store;
}

const plan = parseFlightPlan(JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'flights', 'demo-kteb-khpn.json'), 'utf8')));

describe('geo', () => {
  it('KJFK–KTEB is about 18 nm on a north-westerly course', () => {
    const d = distanceNm(KJFK, KTEB);
    expect(d).toBeGreaterThan(17);
    expect(d).toBeLessThan(19);
    const c = initialCourse(KJFK, KTEB);
    expect(c).toBeGreaterThan(300);
    expect(c).toBeLessThan(330);
    expect(distanceNm(KJFK, KJFK)).toBe(0);
  });

  it('parses lat,lon and rejects anything else', () => {
    expect(parseLatLon('40.6399, -73.7787')).toEqual({ lat: 40.6399, lon: -73.7787 });
    expect(parseLatLon('KJFK')).toBeNull();
    expect(parseLatLon('91,0')).toBeNull();
  });
});

describe('resolveNearestDayTime', () => {
  it('picks the instant nearest the reference across a month boundary', () => {
    const ref = new Date('2026-09-30T23:00:00Z');
    expect(resolveNearestDayTime({ day: 1, hour: 0, minute: 0 }, ref)?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(resolveNearestDayTime({ day: 30, hour: 12, minute: 0 }, ref)?.toISOString()).toBe('2026-09-30T12:00:00.000Z');
    // Degenerate: September has no 31st, so the candidates are a month away either side; nearest wins.
    expect(resolveNearestDayTime({ day: 31, hour: 12, minute: 0 }, ref)?.toISOString()).toBe('2026-08-31T12:00:00.000Z');
    expect(resolveNearestDayTime({ day: 2, hour: 6, minute: 0 }, new Date('2026-10-01T23:00:00Z'))?.toISOString()).toBe('2026-10-02T06:00:00.000Z');
  });
});

describe('parseFlightPlan', () => {
  it('normalises identifiers and rejects bad input with a message', () => {
    expect(plan.departure).toBe('KTEB');
    expect(plan.alternate).toBe('KJFK');
    expect(plan.route).toEqual(['N07']);
    expect(() => parseFlightPlan({})).toThrow('"departure" is required');
    expect(() => parseFlightPlan({ ...plan, departureTime: '2026-09-07T13:00' })).toThrow('ending in Z');
    expect(() => parseFlightPlan({ ...plan, cruise: { tas: 0, altitude: 3500 } })).toThrow('cruise.tas');
  });
});

describe('resolveRoute', () => {
  it('positions waypoints from the store, computes legs, cumulative distance and ETAs', async () => {
    const store = await seededStore();
    const route = await resolveRoute(store, plan);
    expect(route.points.map((p) => p.waypoint.id)).toEqual(['KTEB', 'N07', 'KHPN']);
    expect(route.points.map((p) => p.waypoint.role)).toEqual(['departure', 'enroute', 'destination']);
    expect(route.legs.length).toBe(2);
    expect(route.total).toBeGreaterThan(25);
    expect(route.total).toBeLessThan(45);
    expect(route.points[0]!.eta.toISOString()).toBe('2026-09-07T13:00:00.000Z');
    const minutes = (route.total / 110) * 60;
    expect((route.points[2]!.eta.getTime() - route.points[0]!.eta.getTime()) / 60_000).toBeCloseTo(minutes, 5);
    expect(route.alternate?.point.waypoint.id).toBe('KJFK');
    expect(route.alternate!.point.eta.getTime()).toBeGreaterThan(route.points[2]!.eta.getTime());
  });

  it('accepts lat,lon waypoints and rejects unknown identifiers', async () => {
    const store = await seededStore();
    const r = await resolveRoute(store, { ...plan, route: ['40.9,-74.2'] });
    expect(r.points[1]!.waypoint.airport).toBeNull();
    await expect(resolveRoute(store, { ...plan, route: ['KZZZ'] })).rejects.toThrow(UnknownWaypointError);
  });
});

describe('resolveFlight', () => {
  it('gives each point its forecast at ETA, borrowing the nearest TAF for a field without one', async () => {
    const store = await seededStore();
    const f = await resolveFlight(store, plan, new Date('2026-09-07T12:30:00Z'));
    const [teb, n07, hpn] = f.points;

    expect(teb!.forecast?.source).toBe('own');
    expect(teb!.forecast?.station).toBe('KTEB');
    expect(teb!.metar?.decoded.station?.value).toBe('KTEB');
    expect(teb!.forecast?.resolved.prevailing).not.toBeNull();

    expect(n07!.forecast?.source).toBe('nearby');
    expect(n07!.forecast?.station).toBe('KTEB');
    expect(n07!.forecast?.distance).toBeGreaterThan(5);
    expect(n07!.forecast?.distance).toBeLessThan(20);
    expect(n07!.metar).toBeNull();

    expect(hpn!.forecast?.source).toBe('own');
    expect(hpn!.forecast?.resolved.at).toEqual(hpn!.point.eta);
    expect(f.alternate?.forecast?.station).toBe('KJFK');
  });

  it('uses only what was known at asOf', async () => {
    const store = await seededStore();
    const f = await resolveFlight(store, plan, new Date('2026-09-07T11:00:00Z'));
    // The recorded TAFs were issued 1138Z: at 1100Z nothing was known, and N07's borrowed TAF is gone too.
    expect(f.points.map((p) => p.forecast)).toEqual([null, null, null]);
  });

  it('renders every waypoint with its citation text', async () => {
    const store = await seededStore();
    const out = flightText(await resolveFlight(store, plan, new Date('2026-09-07T12:30:00Z')));
    expect(out).toContain('KTEB → N07 → KHPN  alt KJFK');
    expect(out).toContain('not an official briefing');
    expect(out).toContain('nearest TAF, KTEB at');
    expect(out).toContain('prevailing:');
    expect(out).toContain('from base period 12:00Z–14:00Z: "35004KT P6SM SKC"');

    // Departing later, the FM periods are in force and are cited as such.
    const later = flightText(await resolveFlight(store, { ...plan, departureTime: '2026-09-07T16:00:00Z' }, new Date('2026-09-07T12:30:00Z')));
    expect(later).toMatch(/from FM07\d{4} \d{2}:\d{2}Z–\d{2}:\d{2}Z: "FM07/);
  });
});
