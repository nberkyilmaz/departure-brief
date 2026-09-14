/**
 * The wind triangle, and what a nav log does when it cannot solve one.
 *
 * The arithmetic is checked against the cases a pilot can verify in their
 * head — straight headwind, straight tailwind, wind square on the beam —
 * and then over the real flight, with the real forecast for Toronto.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFlightPlan } from '../../src/domain/flight.js';
import type { HttpClient } from '../../src/fetch/http.js';
import { NavCanadaClient } from '../../src/fetch/navcanada.js';
import { readOurAirportsDirectory } from '../../src/fetch/ourairports.js';
import { navLog, solveWind } from '../../src/navlog/compute.js';
import { resolveFlight } from '../../src/resolve/flight.js';
import { storeAndDecode } from '../../src/store/decode.js';
import { MemoryStore } from '../../src/store/memory.js';

const FIXTURES = join(__dirname, '..', 'fixtures', 'fetch');
const ROOT = join(__dirname, '..', '..', '..', '..');
const UPPERWIND = join(FIXTURES, 'navcanada', 'upperwind', '2026-09-14');

describe('solveWind', () => {
  it('answers the cases a pilot can check in their head', () => {
    // Straight down the nose: no correction, groundspeed down by the wind.
    // North is 360 on a heading bug, not 000.
    expect(solveWind(360, 100, { directionTrue: 360, speedKt: 20 })).toEqual({ windCorrectionAngle: 0, trueHeading: 360, groundspeedKt: 80 });
    // Straight up the tail: no correction, groundspeed up by the wind.
    expect(solveWind(360, 100, { directionTrue: 180, speedKt: 20 })).toEqual({ windCorrectionAngle: 0, trueHeading: 360, groundspeedKt: 120 });
    // Square on from the right: turn right into it, and lose a little speed.
    const beam = solveWind(360, 100, { directionTrue: 90, speedKt: 20 })!;
    expect(beam.windCorrectionAngle).toBeCloseTo(11.5, 1);
    expect(beam.trueHeading).toBeCloseTo(11.5, 1);
    expect(beam.groundspeedKt).toBeCloseTo(98, 0);
    // From the left, the same but the other way.
    expect(solveWind(360, 100, { directionTrue: 270, speedKt: 20 })!.windCorrectionAngle).toBeCloseTo(-11.5, 1);
  });

  it('wraps the heading rather than reporting 370 degrees', () => {
    const s = solveWind(350, 100, { directionTrue: 80, speedKt: 30 })!;
    expect(s.trueHeading).toBeGreaterThanOrEqual(0);
    expect(s.trueHeading).toBeLessThan(360);
    expect(s.trueHeading).toBeCloseTo(7.3, 0);
  });

  it('refuses a course that cannot be held', () => {
    // Forty knots across the course, in an aeroplane that does thirty.
    expect(solveWind(360, 30, { directionTrue: 90, speedKt: 40 })).toBeNull();
    // And a headwind stronger than the aircraft: no groundspeed forwards.
    expect(solveWind(360, 30, { directionTrue: 360, speedKt: 40 })).toBeNull();
    expect(solveWind(360, 0, { directionTrue: 90, speedKt: 10 })).toBeNull();
  });
});

/** Serves the recorded upper wind response for whichever sites are asked about. */
const replay: HttpClient = {
  async get(url) {
    const sites = [...url.matchAll(/site=([A-Z0-9]{3,4})/g)].map((m) => m[1]!);
    const data: unknown[] = [];
    for (const site of sites) {
      try {
        data.push(...(JSON.parse(readFileSync(join(UPPERWIND, `${site}.json`), 'utf8')) as { data: unknown[] }).data);
      } catch {
        // Not an upper wind site.
      }
    }
    return { status: 200, body: JSON.stringify({ meta: {}, data }), headers: {} };
  },
};

/** The owner's own flight, at a time the recorded upper winds cover. */
const plan = parseFlightPlan({
  ...JSON.parse(readFileSync(join(ROOT, 'flights', 'demo-cysn-cykf.json'), 'utf8')),
  departureTime: '2026-09-14T06:00:00Z',
});
const ASOF = new Date('2026-09-14T05:00:00Z');

async function flight() {
  const store = new MemoryStore();
  await store.putAirports(readOurAirportsDirectory(join(FIXTURES, 'ourairports', '2026-09-07'), { snapshot: '2026-09-07' }));
  const fetched = await new NavCanadaClient(replay).upperWinds(['CYYZ']);
  await storeAndDecode(store, fetched.reports, fetched.request, new Date('2026-09-14T04:30:00Z'), 'CYYZ');
  return resolveFlight(store, plan, ASOF);
}

describe('navLog', () => {
  it('works the real flight, leg by leg, from the real forecast', async () => {
    const log = navLog(await flight(), 8.5);

    expect(log.legs.map((l) => `${l.from}→${l.to}`)).toEqual(['CYSN→CYKF']);
    const leg = log.legs[0]!;
    // St. Catharines to Waterloo: about sixty miles, roughly north-west.
    expect(leg.distanceNm).toBeGreaterThan(50);
    expect(leg.distanceNm).toBeLessThan(70);
    expect(leg.trueCourse).toBeGreaterThan(270);
    expect(leg.trueCourse).toBeLessThan(330);

    // Toronto's column, borrowed, and said to be borrowed.
    expect(leg.wind!.station).toBe('CYYZ');
    expect(leg.wind!.altitudeFt).toBe(3500);
    expect(leg.groundspeedKt).toBeGreaterThan(0);
    expect(leg.minutes).toBe(Math.round((leg.distanceNm / leg.groundspeedKt!) * 60));
    expect(leg.cumulativeMinutes).toBe(leg.minutes);

    // Fuel follows time, at the rate given and no other.
    expect(leg.fuelGal).toBeCloseTo((leg.minutes! / 60) * 8.5, 1);
    expect(log.totalFuelGal).toBe(leg.fuelGal);
    expect(log.totalMinutes).toBe(leg.minutes);

    // OurAirports publishes no magnetic variation, so the courses are true
    // and the log says why rather than quietly printing true as magnetic.
    expect(leg.magneticCourse).toBeNull();
    expect(leg.magneticHeading).toBeNull();
    expect(leg.gaps.some((g) => g.includes('magnetic variation'))).toBe(true);

    // The alternate is worked out too, and kept out of the totals.
    expect(log.alternate!.to).toBe('CYHM');
    expect(log.alternate!.cumulativeMinutes).toBeNull();
    expect(log.totalDistanceNm).toBe(leg.distanceNm);
  });

  it('leaves a blank, and says why, when no forecast covers a leg', async () => {
    const store = new MemoryStore();
    await store.putAirports(readOurAirportsDirectory(join(FIXTURES, 'ourairports', '2026-09-07'), { snapshot: '2026-09-07' }));
    const log = navLog(await resolveFlight(store, plan, ASOF), 8.5);
    const leg = log.legs[0]!;

    expect(leg.wind).toBeNull();
    expect(leg.groundspeedKt).toBeNull();
    expect(leg.minutes).toBeNull();
    expect(leg.fuelGal).toBeNull();
    expect(leg.gaps.some((g) => g.includes('no upper wind forecast'))).toBe(true);
    // And the totals refuse to be a partial sum pretending to be a whole one.
    expect(log.totalMinutes).toBeNull();
    expect(log.totalFuelGal).toBeNull();
    // The distance is still known: it does not depend on the weather.
    expect(log.totalDistanceNm).toBeGreaterThan(50);
  });

  it('gives no fuel figure without a burn rate to use', async () => {
    const log = navLog(await flight(), null);
    expect(log.legs[0]!.fuelGal).toBeNull();
    expect(log.totalFuelGal).toBeNull();
    expect(log.totalMinutes).not.toBeNull();
  });
});
