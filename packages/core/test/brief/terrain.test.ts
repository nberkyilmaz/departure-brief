/**
 * The ground under a route, over the heights Open-Meteo gave for Vancouver
 * to Calgary on 9 November 2026 and the real positions of the aerodromes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { routePicture } from '../../src/brief/picture.js';
import { routeTerrain, samplesAlong } from '../../src/brief/terrain.js';
import { parseFlightPlan } from '../../src/domain/flight.js';
import { trackPosition } from '../../src/domain/geo.js';
import { ElevationClient } from '../../src/fetch/elevation.js';
import { readOurAirportsDirectory } from '../../src/fetch/ourairports.js';
import { resolveFlight } from '../../src/resolve/flight.js';
import { MemoryStore } from '../../src/store/memory.js';

const FETCH = join(__dirname, '..', 'fixtures', 'fetch');
const recorded = JSON.parse(readFileSync(join(FETCH, 'open-meteo', 'elevation-2026-11-09', 'CYVR-CYYC.json'), 'utf8')) as { url: string; status: number; body: string }[];
const client = new ElevationClient({
  async get(url) {
    const found = recorded.find((r) => r.url === url);
    if (!found) throw new Error(`nothing recorded for ${url}`);
    return { status: found.status, body: found.body, headers: {} };
  },
});

async function lineOf(departure: string, destination: string) {
  const store = new MemoryStore();
  await store.putAirports(readOurAirportsDirectory(join(FETCH, 'canada-2026-09-18', 'ourairports'), { snapshot: '2026-09-18' }).filter((a) => a.siteType === 'A'));
  const plan = parseFlightPlan({ departure, destination, alternate: null, route: [], departureTime: '2026-11-09T03:00:00Z', cruise: { tas: 110, altitude: 11500 }, airspace: null });
  const flight = await resolveFlight(store, plan, new Date('2026-11-09T01:26:00Z'));
  return { flight, picture: await routePicture(store, flight) };
}

describe('where the ground is sampled', () => {
  it('is every two miles or closer along the line, from one end to the other', async () => {
    const { picture, flight } = await lineOf('CYVR', 'CYYC');
    const samples = samplesAlong(picture.line);
    const [a, b] = [flight.route.points[0]!.waypoint.position, flight.route.points[1]!.waypoint.position];
    expect(samples[0]!.position).toEqual(a);
    expect(samples[samples.length - 1]!.position).toEqual(b);
    expect(samples[samples.length - 1]!.nm).toBeCloseTo(flight.route.total, 3);
    samples.forEach((s, i) => {
      if (i > 0) expect(s.nm - samples[i - 1]!.nm).toBeLessThanOrEqual(2);
      expect(Math.abs(trackPosition(a, b, s.position).offsetNm)).toBeLessThan(0.05);
      expect(Math.abs(trackPosition(a, b, s.position).alongNm - s.nm)).toBeLessThan(0.05);
    });
  });

  it('spreads out rather than asking for more on a long route', async () => {
    const { picture, flight } = await lineOf('CYVR', 'CYHZ');
    const samples = samplesAlong(picture.line);
    expect(flight.route.total).toBeGreaterThan(2000);
    expect(samples).toHaveLength(300);
    expect(samples[1]!.nm).toBeCloseTo(flight.route.total / 299, 3);
  });
});

describe('the ground under the route', () => {
  it('is in feet, and knows its highest point', async () => {
    const { picture } = await lineOf('CYVR', 'CYYC');
    const terrain = await routeTerrain(client, picture.line);
    const metres = recorded.flatMap((r) => (JSON.parse(r.body) as { elevation: number[] }).elevation);
    expect(terrain.samples.map((s) => s.ft)).toEqual(metres.map((m) => Math.round(m / 0.3048)));
    expect(terrain.highest.ft).toBe(Math.max(...terrain.samples.map((s) => s.ft)));
    expect(terrain.highest.ft).toBe(9278);
    expect(Math.round(terrain.highest.nm)).toBe(257);
    expect(terrain.spacingNm).toBeLessThanOrEqual(2);
  });

  it('agrees with the published elevation of the fields at each end', async () => {
    const { picture, flight } = await lineOf('CYVR', 'CYYC');
    const { samples } = await routeTerrain(client, picture.line);
    const [from, to] = [flight.route.points[0]!.waypoint.airport!, flight.route.points[1]!.waypoint.airport!];
    expect(Math.abs(samples[0]!.ft - from.elevation!)).toBeLessThan(50);
    expect(Math.abs(samples[samples.length - 1]!.ft - to.elevation!)).toBeLessThan(50);
  });
});
