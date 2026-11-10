/**
 * The side view and the route map, drawn from the live products the relay held on the evening
 * of 8 November 2026, through the same page engine a visitor gets: Vancouver
 * to Calgary over the Rockies, and a flight that starts inside two SIGMETs.
 * The clock is held at the moment those products were taken.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BriefingView } from '../src/BriefingView.js';
import { loadEngine, type LocalBriefing } from '../src/engine.js';
import { alongRowId, altitudeTicks, chartTop, COLUMN_PX, columnsOf, emptyStretches, layersToLabel, notesOf, spread, xOfNm } from '../src/picture.js';
import { gesturesFor } from '../src/mapBase.js';
import RouteMap from '../src/RouteMap.js';
import { nearbyAirports, routeMarks, routeShapes, type Mark } from '../src/routeLayers.js';
import { SideView } from '../src/SideView.js';
import { alongTheWay, fieldCards } from '../src/summary.js';
import type { FlightPlanInput } from '../src/types.js';

const DEMO = join(__dirname, '..', 'public', 'demo');
const SNAPSHOT = join(__dirname, '..', '..', '..', 'packages', 'core', 'test', 'fixtures', 'fetch', 'rockies-2026-11-08');
const RELAY = 'https://relay.example';
const NOW = '2026-11-09T01:26:00Z';
const ELEVATION = join(SNAPSHOT, '..', 'open-meteo', 'elevation-2026-11-09', 'CYVR-CYYC.json');
const heights = JSON.parse(readFileSync(ELEVATION, 'utf8')) as { url: string; status: number; body: string }[];
let heightsAsked = 0;

const answers: Record<string, string> = {
  '/awc/cache/metars.cache.csv.gz': 'metars.cache.csv',
  '/awc/cache/tafs.cache.xml.gz': 'tafs.cache.xml',
  '/awc/sigmet?format=json': 'isigmet.json',
};

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.startsWith('https://api.open-meteo.com')) {
      heightsAsked++;
      const found = heights.find((h) => h.url === url);
      // Only Vancouver to Calgary was recorded; any other flight meets a service that is not answering.
      return found ? new Response(found.body, { status: found.status }) : new Response('unavailable', { status: 503 });
    }
    if (!url.startsWith(RELAY)) {
      try {
        return new Response(readFileSync(join(DEMO, url.slice(url.indexOf('demo/') + 'demo/'.length)), 'utf8'), { status: 200 });
      } catch {
        return new Response('not found', { status: 404 });
      }
    }
    const path = url.slice(RELAY.length);
    const name = path.includes('alpha=upperwind') ? 'upperwind.json' : answers[path];
    if (!name) throw new TypeError('Failed to fetch');
    return new Response(readFileSync(join(SNAPSHOT, name), 'utf8'), { status: 200, headers: { 'X-Fetched-At': NOW } });
  }) as typeof fetch;
});

afterEach(cleanup);
afterAll(() => {
  vi.useRealTimers();
});

async function briefed(departure: string, destination: string, departureTime: string): Promise<LocalBriefing> {
  const engine = await loadEngine('/', RELAY);
  const plan: FlightPlanInput = { departure, destination, alternate: null, route: [], departureTime, cruise: { tas: 110, altitude: 11500 }, airspace: null };
  return engine.brief(plan, engine.profile, engine.aircraft);
}

const chipsIn = (root: ParentNode) => [...root.querySelectorAll('.side-plot .sv-chip')];

describe('the letters on the chart', () => {
  it('are the same ones the list and the field cards show', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    const columns = columnsOf(r.briefing, r.picture);
    const listed = new Map(alongTheWay(r.briefing).flatMap((l) => l.stations.map((s) => [s.review.station, s] as const)));
    const cards = fieldCards(r.briefing);
    for (const c of columns) {
      const said = c.station.role === 'along' ? listed.get(c.station.id)! : cards.find((f) => f.point.waypoint === c.station.id)!;
      expect([c.station.id, c.category, c.from]).toEqual([c.station.id, said.category, said.from]);
    }
  });

  it('are on every station, hollow where there is no forecast for your time', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    const { container } = render(<SideView stored={r.briefing} picture={r.picture} />);
    const chips = chipsIn(container);
    const columns = columnsOf(r.briefing, r.picture);
    expect(chips).toHaveLength(columns.length);
    columns.forEach((c, i) => {
      expect(chips[i]!.querySelector('text')?.textContent).toBe(c.category ? c.category[0] : '–');
      expect(chips[i]!.classList.contains('hollow')).toBe(c.from !== 'forecast');
    });
    expect(columns.filter((c) => c.from === 'now').map((c) => c.station.id)).toEqual(['CYHE', 'CYDC', 'CYBW']);
  });
});

describe('what the chart draws', () => {
  it('draws no cloud for an observation you would pass long after it was made, and says when it was made', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    const { container } = render(<SideView stored={r.briefing} picture={r.picture} />);
    expect(container.querySelectorAll('.sv-cloud.sv-observed')).toHaveLength(0);
    // CYVR's three layers, CYXX's three: the two with a forecast that has cloud. BKN200 is above the chart and written instead.
    expect(container.querySelectorAll('.sv-cloud:not(.sv-observed)')).toHaveLength(5);
    expect(container.querySelector('.side-axis')?.textContent).toContain('METAR');
    expect(container.querySelector('.side-plot')?.textContent).toMatch(/↑20,000/);
  });

  it('outlines the cloud of an observation you pass within ninety minutes of it', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T01:30:00Z');
    const { container } = render(<SideView stored={r.briefing} picture={r.picture} />);
    expect(container.querySelector('.sv-cloud.sv-observed .sv-cloud-outline')).not.toBeNull();
    expect(container.querySelector('.side-plot')?.textContent).toContain('OVC 5,600');
  });

  it('draws a TEMPO apart from what prevails', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    const { container } = render(<SideView stored={r.briefing} picture={r.picture} />);
    expect(container.querySelectorAll('.side-plot .sv-overlay')).toHaveLength(1);
    expect(container.querySelector('.side-plot')?.textContent).toContain('TEMPO');
  });

  it('draws a band for each SIGMET the route is in, with its letter and its words', async () => {
    const r = await briefed('CYYC', 'CYLW', '2026-11-09T01:30:00Z');
    const { container } = render(<SideView stored={r.briefing} picture={r.picture} />);
    expect(container.querySelectorAll('.sv-band.sigmet')).toHaveLength(2);
    expect([...container.querySelectorAll('.sv-tag')].map((t) => t.textContent)).toEqual(['A↑', 'B']);
    const key = container.querySelector('.side-hazards')?.textContent;
    expect(key).toContain('SIGMET CZEG, SEV mountain wave, surface to 22,000 ft');
    expect(key).toContain('SIGMET CZEG, SEV mountain wave, surface to 14,000 ft');
  });

  it('marks the freezing level where it is known, and only where it is known', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    const { container } = render(<SideView stored={r.briefing} picture={r.picture} />);
    expect(container.querySelectorAll('.side-plot .sv-freezing')).toHaveLength(2);
    const text = container.querySelector('.side-plot')?.textContent ?? '';
    expect(text).toContain('0°↓');
    expect(text).toContain('0°');
  });
});

describe('what the chart says it cannot show', () => {
  it('says so in words', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    const columns = columnsOf(r.briefing, r.picture);
    const notes = notesOf(r.picture, columns, true).join('\n');
    expect(notes).toContain('Cloud bases only');
    expect(notes).toContain('Ground is known only at the stations');
    expect(emptyStretches(columns).map((g) => [g.from, g.to, Math.round(g.nm)])).toEqual([['CYLW', 'CYBW', 203]]);
    expect(notes).toContain('Nothing reports for 203 nm between CYLW and CYBW.');
    expect(notes).toContain('7,000 ft at CYYC');
    expect(notes).toContain('below 6,000 ft at CYVR');
    expect(notes).toContain('it has no temperature under that height');
    expect(notes).toContain('planned 110 kt with no wind');
    expect(notes).toContain('go by the miles printed');
  });

  it('names an advisory it left out, and why', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    expect(r.picture.hazards).toEqual([]);
    const notes = notesOf(r.picture, columnsOf(r.briefing, r.picture), false).filter((n) => n.startsWith('Not drawn'));
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/^Not drawn: SIGMET CZEG, SEV mountain wave\. It is on your route, but it ends .*\(0[34]:\d\dZ\), before you reach it at .*\(05:\d\dZ\)\.$/);
  });

  it('says there is no freezing level when there are no upper-air temperatures', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    const none = { ...r.picture, freezing: [] };
    expect(notesOf(none, columnsOf(r.briefing, none), false).join('\n')).toContain('No upper-air temperatures reach this route');
  });
});

describe('tapping a station', () => {
  it('opens its line in Along the way, out of any fold it is in', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    render(<BriefingView stored={r.briefing} picture={r.picture} />);
    const row = document.getElementById(alongRowId('CYHE'))!;
    const own = row.querySelector('details')!;
    expect(own.open).toBe(false);
    fireEvent.click(screen.getByRole('link', { name: /^CYHE, 66 nm along/ }));
    expect(own.open).toBe(true);
    for (let el = row.parentElement; el; el = el.parentElement) if (el instanceof HTMLDetailsElement) expect(el.open).toBe(true);
  });

  it('takes a field the flight names to its own page', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    render(<SideView stored={r.briefing} picture={r.picture} />);
    fireEvent.click(screen.getByRole('link', { name: /^CYYC, 371 nm along/ }));
    expect(window.location.hash).toBe('#/aerodrome/CYYC');
    window.location.hash = '';
  });
});

describe('fitting it on a phone', () => {
  it('keeps every column readable and in order, on the real distances of a route', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    const miles = r.picture.stations.map((s) => s.nm);
    const phone = spread(miles, 310);
    expect(phone.xs).toHaveLength(miles.length);
    for (let i = 1; i < phone.xs.length; i++) expect(phone.xs[i]! - phone.xs[i - 1]!).toBeGreaterThanOrEqual(COLUMN_PX);
    expect(phone.spreadApart).toBe(true);
    // The two hundred empty miles still look longer than anything else on the route.
    const gaps = phone.xs.slice(1).map((x, i) => x - phone.xs[i]!);
    expect(Math.max(...gaps)).toBe(gaps[4]);
    expect(gaps[4]).toBeGreaterThan(COLUMN_PX * 2);
  });

  it('is true to the distance when there is room', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    const miles = r.picture.stations.map((s) => s.nm);
    const wide = spread(miles, 2000);
    expect(wide.spreadApart).toBe(false);
    expect((wide.xs[4]! - wide.xs[1]!) / (wide.xs[5]! - wide.xs[1]!)).toBeCloseTo((miles[4]! - miles[1]!) / (miles[5]! - miles[1]!), 6);
    expect(wide.width).toBeCloseTo(2000, 6);
  });

  it('places any distance between the columns either side of it', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    const miles = r.picture.stations.map((s) => s.nm);
    const { xs } = spread(miles, 310);
    miles.forEach((nm, i) => expect(xOfNm(nm, miles, xs)).toBeCloseTo(xs[i]!, 6));
    expect(xOfNm((miles[4]! + miles[5]!) / 2, miles, xs)).toBeCloseTo((xs[4]! + xs[5]!) / 2, 6);
  });

  it('reaches three thousand feet over the cruise or the highest ground', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    expect(chartTop(r.picture)).toBe(15000);
    expect(altitudeTicks(15000)).toEqual([0, 2000, 4000, 6000, 8000, 10000, 12000, 14000]);
  });

  it('words the layers that have room, with the ceiling and any storm first', async () => {
    // CYDC at 00:00Z: FEW055 SCT058TCU BKN062 BKN068TCU, passed inside the ninety minutes.
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T00:30:00Z');
    const sky = r.picture.stations.find((s) => s.id === 'CYDC')!.reading!.sky!;
    expect(sky.layers).toHaveLength(4);
    const yOf = (ft: number) => 298 - (ft / 15000) * 252;
    // Under the twelve pixels a label needs apart, so the ceiling, BKN at 8,498, speaks for the four.
    expect([...layersToLabel(sky.layers, yOf, 12)].map((l) => l.baseMsl)).toEqual([8498]);
    // CYXX's three are thousands of feet apart and each has room.
    const roomy = r.picture.stations.find((s) => s.id === 'CYXX')!.reading!.sky!;
    expect([...layersToLabel(roomy.layers, yOf, 12)].map((l) => l.baseMsl).sort((a, b) => a! - b!)).toEqual([2195, 6195, 14195]);
  });
});

describe('the route map', () => {
  const touchscreen = (coarse: boolean) => {
    window.matchMedia = ((query: string) => ({ matches: coarse && query.includes('coarse') })) as unknown as typeof window.matchMedia;
  };
  afterEach(() => touchscreen(false));
  const stationsOf = (marks: readonly Mark[]) => marks.filter((m) => m.kind === 'field' || m.kind === 'station');

  it('has every station, with the letter the list gives it, hollow where the list says observed', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    const marks = stationsOf(routeMarks(r.briefing, r.picture));
    const columns = columnsOf(r.briefing, r.picture);
    expect(marks).toHaveLength(columns.length);
    for (const c of columns) {
      const mark = marks.find((m) => m.title.startsWith(`${c.station.id},`))!;
      expect(mark.text).toBe(c.category ? c.category[0] : '–');
      expect(mark.className.split(' ').includes('hollow')).toBe(c.from !== 'forecast');
    }
  });

  it("names the fields the flight names, under a chart's aerodrome symbol", async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    const names = new Map([['CYVR', 'Vancouver International Airport']]);
    const marks = routeMarks(r.briefing, r.picture, (id) => names.get(id) ?? null);
    // Shortened as a chart prints it.
    expect(marks.filter((m) => m.kind === 'field').map((m) => [m.label, m.name])).toEqual([
      ['CYVR', 'Vancouver Intl'],
      ['CYYC', null],
    ]);
    // Five stations beside the route: few enough to name each.
    expect(marks.filter((m) => m.kind === 'station').map((m) => m.label)).toEqual(['CYXX', 'CYHE', 'CYDC', 'CYLW', 'CYBW']);
  });

  it('draws the route in one line, and nothing to an alternate the flight does not have', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    const shapes = routeShapes(r.picture);
    expect(shapes.route.features).toHaveLength(1);
    expect(shapes.alternate.features).toEqual([]);
    expect(shapes.corridor.features).toHaveLength(1);
    // Its distance printed once, at the middle, along the line: Vancouver to Calgary climbs about 18° from east on the map.
    expect(shapes.labels.features).toHaveLength(1);
    const [label] = shapes.labels.features;
    expect(label!.properties).toMatchObject({ label: `${Math.round(r.picture.totalNm)} NM`, kind: 'route' });
    expect(label!.properties!['rotate']).toBeLessThan(-14);
    expect(label!.properties!['rotate']).toBeGreaterThan(-22);
    const [lon, lat] = label!.geometry.coordinates;
    const [vancouver, calgary] = [r.picture.line[0]!, r.picture.line[r.picture.line.length - 1]!];
    expect(lon!).toBeGreaterThan(Math.min(vancouver.lon, calgary.lon));
    expect(lon!).toBeLessThan(Math.max(vancouver.lon, calgary.lon));
    expect(Math.abs(lon! - (vancouver.lon + calgary.lon) / 2)).toBeLessThan(0.3);
    expect(lat!).toBeGreaterThan(49);
  });

  it('draws the advisories you would be inside, with the letters the side view uses', async () => {
    const r = await briefed('CYYC', 'CYLW', '2026-11-09T01:30:00Z');
    expect(routeMarks(r.briefing, r.picture).filter((m) => m.kind === 'hazard').map((m) => m.text)).toEqual(['A', 'B']);
    expect(routeShapes(r.picture).hazards.features.map((f) => f.properties!['letter'])).toEqual(['A', 'B']);
  });

  it('draws none that will be over before you reach them', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    expect(routeMarks(r.briefing, r.picture).filter((m) => m.kind === 'hazard')).toHaveLength(0);
    expect(routeShapes(r.picture).hazards.features).toHaveLength(0);
  });

  it("opens a station's line in Along the way when it is tapped", async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    render(<BriefingView stored={r.briefing} picture={r.picture} />);
    const mark = routeMarks(r.briefing, r.picture).find((m) => m.title.startsWith('CYHE,'))!;
    const row = document.getElementById(alongRowId('CYHE'))!.querySelector('details')!;
    expect(row.open).toBe(false);
    mark.open!();
    expect(row.open).toBe(true);
  });

  it('shows the aerodromes around the route that the flight does not name', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    const engine = await loadEngine('/', RELAY);
    const nearby = nearbyAirports(engine.aerodromes, r.picture).features.map((f) => f.properties!['id'] as string);
    expect(nearby.length).toBeGreaterThan(20);
    expect(nearby).toContain('CYKA');
    expect(nearby).not.toContain('CYVR');
    expect(nearby).not.toContain('CYHE');
    // Toronto is nowhere near this flight.
    expect(nearby).not.toContain('CYYZ');
  });

  it('leaves one finger to the page on a touch screen, and the wheel to the page until the map is clicked', async () => {
    expect(gesturesFor(true)).toEqual({ cooperativeGestures: true, scrollZoom: false });
    expect(gesturesFor(false)).toEqual({ cooperativeGestures: false, scrollZoom: false });
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    touchscreen(true);
    const onPhone = render(<RouteMap stored={r.briefing} picture={r.picture} />);
    expect(onPhone.container.textContent).toContain('One finger scrolls the page');
    onPhone.unmount();
    touchscreen(false);
    const onDesktop = render(<RouteMap stored={r.briefing} picture={r.picture} />);
    expect(onDesktop.container.textContent).not.toContain('One finger scrolls the page');
  });

  it('says so in place of the map where the browser cannot draw one', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    const { container } = render(<RouteMap stored={r.briefing} picture={r.picture} />);
    expect(container.textContent).toContain('The map could not be drawn here. The side view and the list below have every station.');
  });
});

describe('the terrain under the line', () => {
  it('shades it once it arrives, and says what it is and is not', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    const { container } = render(<SideView stored={r.briefing} picture={r.picture} />);
    const note = await screen.findByText(/The shaded ground is the terrain under your line/);
    expect(note.textContent).toContain('every 2 nm');
    expect(note.textContent).toContain('Its highest point is 9,278 ft at 257 nm, 2,200 ft below your cruise.');
    expect(note.textContent).toContain('this is not a clearance');
    expect(note.textContent).toContain('Nothing reports for 203 nm between CYLW and CYBW.');
    expect(container.querySelector('.side-plot .sv-terrain')?.getAttribute('d')).toMatch(/^M/);
    expect(container.querySelector('.side-key')?.textContent).toContain('the terrain under your line');
    expect(container.querySelector('a[href="https://open-meteo.com/"]')).not.toBeNull();
    expect(container.querySelector('.side-notes')?.textContent).toContain('Copernicus');
  });

  it('asks once for a route, however many times the flight is redrawn', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    const first = render(<SideView stored={r.briefing} picture={r.picture} />);
    await screen.findByText(/The shaded ground/);
    first.unmount();
    const before = heightsAsked;
    const later = await briefed('CYVR', 'CYYC', '2026-11-09T04:00:00Z');
    render(<SideView stored={later.briefing} picture={later.picture} />);
    await screen.findByText(/The shaded ground/);
    expect(heightsAsked).toBe(before);
  });

  it('makes room when the ground is higher than the cruise, and gives the number', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    const low = { ...r.picture, cruiseFt: 6500 };
    const { container } = render(<SideView stored={r.briefing} picture={low} />);
    const note = await screen.findByText(/The shaded ground/);
    expect(note.textContent).toContain('2,800 ft above your cruise');
    await waitFor(() => expect(container.querySelector('.side-axis')?.textContent).toContain('12,000'));
  });

  it('runs the ground down to the baseline at each end', async () => {
    const r = await briefed('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    const { container } = render(<SideView stored={r.briefing} picture={r.picture} />);
    await screen.findByText(/The shaded ground/);
    const d = container.querySelector('.side-plot .sv-terrain')!.getAttribute('d')!;
    const points = [...d.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
    expect(points[0]![1]).toBe(points[points.length - 1]![1]);
    expect(points[0]![1]).toBe(Math.max(...points.map((p) => p[1])));
  });

  it('goes on without it when the service does not answer, and says so', async () => {
    const r = await briefed('CYYC', 'CYLW', '2026-11-09T01:30:00Z');
    const { container } = render(<SideView stored={r.briefing} picture={r.picture} />);
    await screen.findByText(/could not be fetched just now/);
    expect(container.querySelector('.sv-terrain')).toBeNull();
    expect(container.querySelector('.side-notes')?.textContent).toContain('Ground is known only at the stations');
    expect(container.querySelector('a[href="https://open-meteo.com/"]')).toBeNull();
  });
});
