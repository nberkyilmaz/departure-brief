/**
 * The airspace along a route, over what the FAA's two layers answered on
 * 9 November 2026 for real routes, each through the client that asked.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { routeAirspace, type AirspaceArea } from '../../src/brief/airspace.js';
import { routePicture } from '../../src/brief/picture.js';
import { CatalogStore, type AirportCell, type AirportIndex } from '../../src/demo/airports.js';
import { parseFlightPlan } from '../../src/domain/flight.js';
import { AirspaceClient, AirspaceError } from '../../src/fetch/airspace.js';
import type { HttpClient } from '../../src/fetch/response.js';
import { resolveFlight } from '../../src/resolve/flight.js';

const DIR = join(__dirname, '..', 'fixtures', 'fetch', 'faa', 'airspace-2026-11-09');
const DEMO = join(__dirname, '..', '..', '..', '..', 'apps', 'web', 'public', 'demo', 'airports');
const store = new CatalogStore(JSON.parse(readFileSync(join(DEMO, 'index.json'), 'utf8')) as AirportIndex, async (name) => JSON.parse(readFileSync(join(DEMO, `${name}.json`), 'utf8')) as AirportCell);

type Recorded = { url: string; status: number; body: string };
const recordedFor = (route: string) => JSON.parse(readFileSync(join(DIR, `${route}.json`), 'utf8')) as Recorded[];

function replaying(route: string): HttpClient {
  const recorded = recordedFor(route);
  return {
    async get(url) {
      const found = recorded.find((r) => r.url === url);
      if (!found) throw new Error(`nothing recorded for ${url}`);
      return { status: found.status, body: found.body, headers: {} };
    },
  };
}

async function pictureOf(departure: string, destination: string, altitude: number) {
  const plan = parseFlightPlan({ departure, destination, alternate: null, route: [], departureTime: '2026-11-10T00:30:00Z', cruise: { tas: 110, altitude }, airspace: null });
  return routePicture(store, await resolveFlight(store, plan, new Date('2026-11-09T22:00:00Z')));
}

async function along(departure: string, destination: string, altitude: number) {
  const picture = await pictureOf(departure, destination, altitude);
  const { areas } = await routeAirspace(new AirspaceClient(replaying(`${departure}-${destination}`)), picture.line, altitude);
  return { picture, areas };
}

const named = (areas: readonly AirspaceArea[], name: string) => areas.filter((a) => a.name === name);
const miles = (a: AirspaceArea) => a.stretches.map((s) => [Math.round(s.fromNm), Math.round(s.toNm)]);

describe('what is asked for', () => {
  it('keeps to the FAA\'s own airspace, from both layers', () => {
    const asked = recordedFor('KALB-KPIT').map((r) => new URL(r.url));
    const where = (layer: string) => asked.find((u) => u.pathname.includes(layer))!.searchParams.get('where');
    expect(where('Class_Airspace')).toBe("CLASS IN ('B','C','D') AND STATE IS NOT NULL");
    expect(where('Special_Use_Airspace')).toBe("COUNTRY = 'UNITED STATES'");
    for (const u of asked) expect(u.searchParams.get('maxAllowableOffset')).toBe('0.0005');
  });

  it('is small enough for a phone, even through the northeast', () => {
    const bytes = recordedFor('KBOS-KPHL').reduce((sum, r) => sum + r.body.length, 0);
    expect(bytes).toBeLessThan(40 * 1024);
  });
});

describe('the shelves of a Class B', () => {
  it('are each drawn where the line goes through them, in the order reached', async () => {
    const { areas } = await along('KPHX', 'KLAS', 9500);
    const phoenix = named(areas, 'PHOENIX CLASS B');
    expect(phoenix.map((a) => a.floor.ft)).toEqual([0, 5000, 4000, 6000]);
    expect(phoenix.map(miles)).toEqual([[[0, 2]], [[2, 8]], [[8, 12]], [[12, 17]]]);
    expect(phoenix[0]!.floor.reference).toBe('surface');
    expect(phoenix[1]!.ceiling).toEqual({ ft: 9000, reference: 'msl', excluded: false });
  });

  it('runs to the end of the line at a field inside one', async () => {
    const { picture, areas } = await along('KPHX', 'KLAS', 9500);
    const surface = named(areas, 'LAS VEGAS CLASS B').find((a) => a.floor.reference === 'surface')!;
    expect(surface.stretches[0]!.toNm).toBeCloseTo(picture.totalNm, 0);
  });

  it('gives a shelf the line leaves and comes back to two stretches', async () => {
    const { areas } = await along('KBOS', 'KPHL', 4500);
    expect(miles(named(areas, 'NEW YORK CLASS B').find((a) => a.floor.ft === 3000)!)).toEqual([[140, 149], [181, 192]]);
  });

  it('takes the hole out of a shelf that has one', async () => {
    const { areas } = await along('KMCI', 'KSTJ', 3500);
    const shelf = named(areas, 'KANSAS CITY CLASS B').find((a) => a.floor.ft === 2400)!;
    expect(shelf.rings).toHaveLength(2);
    // Kansas City International is inside the outline, and in the hole the surface area fills.
    expect(miles(shelf)).toEqual([[5, 10]]);
  });
});

describe('the limits, as the FAA writes them', () => {
  it('reads a flight level, and a top that is not part of the area', async () => {
    const { areas } = await along('KALB', 'KPIT', 6500);
    const duke = named(areas, 'DUKE MOA')[0]!;
    expect(duke.kind).toBe('moa');
    expect(duke.floor).toEqual({ ft: 8000, reference: 'msl', excluded: false });
    expect(duke.ceiling).toEqual({ ft: 18_000, reference: 'fl', excluded: true });
    expect(duke.hours).toBe('1000 - 1500, DAILY; OTHER TIMES BY NOTAM');
  });

  it('reads a height above the ground, and what the area leaves out', async () => {
    const { areas } = await along('KPHX', 'KLAS', 9500);
    const alert = named(areas, 'A-231')[0]!;
    expect(alert.kind).toBe('alert');
    expect(alert.floor).toEqual({ ft: 500, reference: 'agl', excluded: false });
    expect(alert.excludes).toBe('EXCLUDES CLASS D AIRSPACE');
  });

  it('reads a top that does not include its own height on a Class D', async () => {
    const { areas } = await along('KTUS', 'KNYL', 7500);
    expect(named(areas, 'TUCSON-RYAN FIELD CLASS D')[0]!.ceiling).toEqual({ ft: 4200, reference: 'msl', excluded: true });
  });

  it('has no top for an area published as unlimited', async () => {
    const { areas } = await along('KALM', 'KELP', 9500);
    expect(named(areas, 'R-5107B')[0]!.ceiling).toEqual({ ft: null, reference: 'none', excluded: false });
  });

  it('says a part-time Class D is set by NOTAM, and nothing for one that is always there', async () => {
    const { areas } = await along('KBOS', 'KPHL', 4500);
    expect(named(areas, 'NORWOOD CLASS D')[0]!.hours).toBe('BY NOTAM');
    expect(named(areas, 'BOSTON CLASS B')[0]!.hours).toBeNull();
  });

  it('keeps the pieces a MOA is left with either side of what it excludes', async () => {
    const { areas } = await along('KRNO', 'KELY', 11_500);
    const across = named(areas, 'FALLON SOUTH 4 MOA').filter((a) => a.excludes === 'EXCLUDES 2000 FT AGL TO 10500 FT MSL');
    expect(across.map((a) => [a.floor.reference, a.floor.ft, a.ceiling.reference, a.ceiling.ft])).toEqual([
      ['agl', 200, 'agl', 2000],
      ['msl', 10_500, 'msl', 18_000],
    ]);
  });
});

describe('what is left out', () => {
  it('leaves out a shape that is only a hole in another', async () => {
    const recorded = recordedFor('KNHK-KWAL').flatMap((r) => (JSON.parse(r.body) as { features: { properties: Record<string, unknown> }[] }).features);
    const cutOuts = recorded.filter((f) => String(f.properties['UPPER_VAL']) === '0');
    expect(cutOuts.length).toBeGreaterThan(0);
    const { areas } = await along('KNHK', 'KWAL', 4500);
    expect(areas.every((a) => a.ceiling.reference !== 'surface')).toBe(true);
  });

  it('leaves out what starts well above the flight', async () => {
    const recorded = recordedFor('KALM-KELP').flatMap((r) => (JSON.parse(r.body) as { features: { properties: Record<string, unknown> }[] }).features);
    expect(recorded.some((f) => f.properties['NAME'] === 'R-5109A')).toBe(true);
    const { areas } = await along('KALM', 'KELP', 9500);
    expect(named(areas, 'R-5109A')).toEqual([]);
  });
});

describe('when the FAA does not answer', () => {
  const answering = (status: number, body: string): HttpClient => ({ get: async () => ({ status, body, headers: {} }) });
  const line = [{ lat: 42.748, lon: -73.802 }, { lat: 40.492, lon: -80.233 }];

  it('says so when it refuses with a 200', async () => {
    const { status, body } = JSON.parse(readFileSync(join(DIR, 'refused.json'), 'utf8')) as { status: number; body: string };
    expect(status).toBe(200);
    await expect(new AirspaceClient(answering(status, body)).along(line)).rejects.toBeInstanceOf(AirspaceError);
  });

  it('says so when what came back is not the layer', async () => {
    await expect(new AirspaceClient(answering(200, '<html></html>')).along(line)).rejects.toBeInstanceOf(AirspaceError);
    await expect(new AirspaceClient(answering(200, '{}')).along(line)).rejects.toThrow(/no features/);
  });
});

describe('how much of a route the FAA speaks for', () => {
  it('knows a route over the United States, one over Canada, and one across the border', async () => {
    expect((await pictureOf('KALB', 'KPIT', 6500)).overUS).toBe('all');
    expect((await pictureOf('CYVR', 'CYYC', 11_500)).overUS).toBe('none');
    expect((await pictureOf('KBUF', 'CYYZ', 5500)).overUS).toBe('part');
  });
});
