/**
 * Airspace on the page: the side view, the map and the words under them,
 * through the page's own engine, over what the FAA's layers answered on
 * 9 November 2026. Reno to Ely has the terrain Open-Meteo gave for it, since
 * a floor measured from the ground needs the ground.
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AirspaceClient, ElevationClient, routeAirspace, routeTerrain, type HttpClient } from '@depbrief/core/judge';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadEngine, type LocalBriefing } from '../src/engine.js';
import { airspaceBlocks, airspaceLines, columnsOf, notesOf } from '../src/picture.js';
import { airspaceShapes, routeLayers } from '../src/routeLayers.js';
import { SideView } from '../src/SideView.js';

const DEMO = join(__dirname, '..', 'public', 'demo');
const FETCH = join(__dirname, '..', '..', '..', 'packages', 'core', 'test', 'fixtures', 'fetch');
const NE = join(FETCH, 'northeast-2026-11-09');
const FAA_DIR = join(FETCH, 'faa', 'airspace-2026-11-09');
const RELAY = 'https://relay.example';
const NOW = '2026-11-09T05:59:55Z';

type Recorded = { url: string; status: number; body: string };
const faa: Recorded[] = readdirSync(FAA_DIR).filter((n) => n.startsWith('K')).flatMap((n) => JSON.parse(readFileSync(join(FAA_DIR, n), 'utf8')) as Recorded[]);
const elevation = JSON.parse(readFileSync(join(FETCH, 'open-meteo', 'elevation-2026-11-09', 'KRNO-KELY.json'), 'utf8')) as Recorded[];
const replay = (recorded: readonly Recorded[]): HttpClient => ({
  async get(url) {
    const found = recorded.find((r) => r.url === url);
    if (!found) throw new Error(`nothing recorded for ${url}`);
    return { status: found.status, body: found.body, headers: {} };
  },
});

const answers: Record<string, string> = {
  '/awc/cache/metars.cache.csv.gz': readFileSync(join(NE, 'metars.cache.csv'), 'utf8'),
  '/awc/cache/tafs.cache.xml.gz': readFileSync(join(NE, 'tafs.cache.xml'), 'utf8'),
};
let faaAsked = 0;
let faaRefuses = false;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.includes('arcgis.com')) {
      faaAsked++;
      if (faaRefuses) return new Response(JSON.parse(readFileSync(join(FAA_DIR, 'refused.json'), 'utf8')).body as string, { status: 200 });
      const found = faa.find((r) => r.url === url);
      return found ? new Response(found.body, { status: found.status }) : new Response('unavailable', { status: 503 });
    }
    if (url.startsWith('https://api.open-meteo.com')) return new Response('unavailable', { status: 503 });
    if (!url.startsWith(RELAY)) {
      try {
        return new Response(readFileSync(join(DEMO, url.slice(url.indexOf('demo/') + 'demo/'.length)), 'utf8'), { status: 200 });
      } catch {
        return new Response('not found', { status: 404 });
      }
    }
    const body = answers[url.slice(RELAY.length)];
    if (body === undefined) throw new TypeError('Failed to fetch');
    return new Response(body, { status: 200, headers: { 'X-Fetched-At': NOW } });
  }) as typeof fetch;
});

afterEach(cleanup);
afterAll(() => {
  vi.useRealTimers();
});

async function briefed(departure: string, destination: string, altitude: number): Promise<LocalBriefing> {
  const engine = await loadEngine('/', RELAY);
  const plan = { ...engine.plan, departure, destination, alternate: null, route: [], departureTime: '2026-11-10T00:30:00Z', cruise: { tas: 110, altitude }, airspace: null };
  return engine.brief(plan, engine.profile, engine.aircraft);
}

const areasOf = async (b: LocalBriefing, altitude: number) => (await routeAirspace(new AirspaceClient(replay(faa)), b.picture.line, altitude)).areas;

describe('in words', () => {
  it('says each shelf\'s limits and where, one line a name', async () => {
    const b = await briefed('KALB', 'KPIT', 6500);
    const lines = airspaceLines(await areasOf(b, 6500));
    expect(lines.map((l) => l.name)).toEqual(['ALBANY COUNTY AIRPORT CLASS C', 'DUKE MOA', 'PITTSBURGH CLASS B']);
    expect(lines[2]!.words).toBe('4,000 ft to 8,000 ft, 299 to 319 nm; 2,500 ft to 8,000 ft, 309 to 319 nm; surface to 8,000 ft, 312 to 319 nm.');
  });

  it('gives a special use area its limits, and its hours as published', async () => {
    const b = await briefed('KALB', 'KPIT', 6500);
    expect(airspaceLines(await areasOf(b, 6500))[1]!.words).toBe('8,000 ft to below FL180, 192 to 204 nm. Published hours: 1000 - 1500, DAILY; OTHER TIMES BY NOTAM.');
  });

  it('puts two stretches of the same shelf together', async () => {
    const b = await briefed('KBOS', 'KPHL', 4500);
    const york = airspaceLines(await areasOf(b, 4500)).find((l) => l.name === 'NEW YORK CLASS B')!;
    expect(york.words).toContain('3,000 ft to 7,000 ft, 140 to 149 nm and 181 to 192 nm');
  });

  it('says a stretch once when two records cover it with the same limits', async () => {
    const b = await briefed('KNHK', 'KWAL', 4500);
    const river = airspaceLines(await areasOf(b, 4500)).find((l) => l.name === 'PATUXENT RIVER CLASS D')!;
    expect(river.areas).toHaveLength(2);
    expect(river.words).toMatch(/^surface to 2,500 ft, 0 to 5 nm\./);
  });

  it('says a floor is above the ground, and what an area leaves out', async () => {
    const b = await briefed('KPHX', 'KLAS', 9500);
    const alert = airspaceLines(await areasOf(b, 9500)).find((l) => l.name === 'A-231')!;
    expect(alert.words).toBe('500 ft above the ground to 6,500 ft, 16 to 45 nm. Published hours: CONTINUOUS. EXCLUDES CLASS D AIRSPACE.');
  });

  it('says when there is no top', async () => {
    const b = await briefed('KALM', 'KELP', 9500);
    expect(airspaceLines(await areasOf(b, 9500)).find((l) => l.name === 'R-5107B')!.words).toMatch(/^surface to no stated top, /);
  });
});

describe('on the side view', () => {
  const xAt = (nm: number) => nm * 2;
  const yOf = (ft: number) => 300 - ft / 50;

  it('stands a block on the chart for every shelf, and letters only the widest of a name', async () => {
    const b = await briefed('KALB', 'KPIT', 6500);
    const blocks = airspaceBlocks(await areasOf(b, 6500), 10_000, null, xAt, yOf);
    expect(blocks).toHaveLength(6);
    expect(blocks.filter((x) => x.kind === 'class-b' && x.label).map((x) => x.label!.text)).toEqual(['B']);
    // The surface shelf of the Albany Class C, 0 to 5 nm and from the ground to 4,300 ft.
    expect(blocks[0]!.path).toBe('M0.0 214.0L10.1 214.0L10.1 300.0L0.0 300.0Z');
  });

  it('leaves off a block measured from the ground until there is ground, and keeps it in the list', async () => {
    const b = await briefed('KRNO', 'KELY', 11_500);
    const areas = await areasOf(b, 11_500);
    const flat = areas.filter((a) => a.floor.reference !== 'agl' && a.ceiling.reference !== 'agl');
    expect(flat.length).toBeLessThan(areas.length);
    expect(airspaceBlocks(areas, 14_000, null, xAt, yOf)).toHaveLength(flat.reduce((n, a) => n + a.stretches.length, 0));
    expect(new Set(airspaceLines(areas).map((l) => l.name))).toEqual(new Set(areas.map((a) => a.name)));
  });

  it('follows the terrain under a floor measured from it', async () => {
    const b = await briefed('KRNO', 'KELY', 11_500);
    const terrain = await routeTerrain(new ElevationClient(replay(elevation)), b.picture.line);
    const areas = await areasOf(b, 11_500);
    const blocks = airspaceBlocks(areas, 14_000, terrain, xAt, yOf);
    const index = areas.findIndex((a) => a.name === 'FALLON SOUTH 1 MOA');
    const key = `${index}-0`;
    const block = blocks.find((x) => x.key === key)!;
    // About 47 nm long, with terrain every two: more corners than a flat-floored block's four.
    expect(block.path.split('L').length).toBeGreaterThan(40);
    const heights = block.path.split(/[ML]/).filter(Boolean).slice(-10).map((p) => Number(p.replace('Z', '').split(' ')[1]));
    expect(new Set(heights).size).toBeGreaterThan(3);
  });

  it('draws it and lists it, with the marks in the key', async () => {
    const b = await briefed('KALB', 'KPIT', 6500);
    const { container } = render(<SideView stored={b.briefing} picture={b.picture} />);
    await waitFor(() => expect(container.querySelector('.side-airspace')).not.toBeNull());
    expect(container.querySelector('.side-airspace')!.textContent).toContain('PITTSBURGH CLASS B');
    expect(container.querySelectorAll('path.sv-air')).toHaveLength(6);
    expect(container.querySelector('.side-key')!.textContent).toContain('Military operations area');
    expect(container.querySelector('.side-notes')!.textContent).toContain("FAA's published shapes");
  });

  it('says so when the FAA does not answer, and draws none', async () => {
    faaRefuses = true;
    try {
      // Tucson is not asked for by any other test here, so nothing is left over from them.
      const b = await briefed('KTUS', 'KNYL', 7500);
      const { container } = render(<SideView stored={b.briefing} picture={b.picture} />);
      await waitFor(() => expect(container.querySelector('.side-notes')!.textContent).toContain('could not be fetched from the FAA'));
      expect(container.querySelectorAll('path.sv-air')).toHaveLength(0);
    } finally {
      faaRefuses = false;
    }
  });

  it('does not ask for a route over Canada, and says none is drawn', async () => {
    const b = await briefed('CYVR', 'CYYC', 11_500);
    expect(b.picture.overUS).toBe('none');
    const before = faaAsked;
    render(<SideView stored={b.briefing} picture={b.picture} />);
    await Promise.resolve();
    expect(faaAsked).toBe(before);
    expect(notesOf(b.picture, columnsOf(b.briefing, b.picture), false, 'loading', 'not-asked').join(' ')).toContain('only cover the United States');
  });

  it('says what is missing on a route across the border', async () => {
    const b = await briefed('KBUF', 'CYYZ', 5500);
    expect(b.picture.overUS).toBe('part');
    expect(notesOf(b.picture, columnsOf(b.briefing, b.picture), false, 'loading', { areas: [] }).join(' ')).toContain('none is drawn over Canada');
  });
});

describe('on the map', () => {
  it('draws each shape, in the line a chart draws its kind with, saying what it is when tapped', async () => {
    const b = await briefed('KALB', 'KPIT', 6500);
    const shapes = airspaceShapes(await areasOf(b, 6500)).features;
    expect(shapes).toHaveLength(6);
    const pittsburgh = shapes.filter((f) => f.properties!['title'] === 'B PITTSBURGH CLASS B');
    expect(pittsburgh).toHaveLength(3);
    expect(pittsburgh.every((f) => f.properties!['hue'] === 'blue' && f.properties!['line'] === 'solid')).toBe(true);
    expect(shapes.find((f) => f.properties!['tag'] === 'MOA')!.properties).toMatchObject({ hue: 'magenta', line: 'dotted', words: '8,000 ft to below FL180, 192 to 204 nm. Published hours: 1000 - 1500, DAILY; OTHER TIMES BY NOTAM.' });
  });

  it('puts the airspace under the route, since it arrives after it', () => {
    for (const scheme of ['day', 'night'] as const) {
      const ids = routeLayers(scheme).map((l) => l.id);
      expect(ids.indexOf('airspace-fill')).toBeLessThan(ids.indexOf('corridor-fill'));
      expect(Math.max(...ids.filter((id) => id.startsWith('airspace')).map((id) => ids.indexOf(id)))).toBeLessThan(ids.indexOf('route'));
    }
  });
});
