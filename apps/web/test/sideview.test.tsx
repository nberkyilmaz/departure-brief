/**
 * The side view, drawn from the live products the relay held on the evening
 * of 8 November 2026, through the same page engine a visitor gets: Vancouver
 * to Calgary over the Rockies, and a flight that starts inside two SIGMETs.
 * The clock is held at the moment those products were taken.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BriefingView } from '../src/BriefingView.js';
import { loadEngine, type LocalBriefing } from '../src/engine.js';
import { alongRowId, altitudeTicks, chartTop, COLUMN_PX, columnsOf, emptyStretches, layersToLabel, notesOf, spread, xOfNm } from '../src/picture.js';
import { SideView } from '../src/SideView.js';
import { alongTheWay, fieldCards } from '../src/summary.js';
import type { FlightPlanInput } from '../src/types.js';

const DEMO = join(__dirname, '..', 'public', 'demo');
const SNAPSHOT = join(__dirname, '..', '..', '..', 'packages', 'core', 'test', 'fixtures', 'fetch', 'rockies-2026-11-08');
const RELAY = 'https://relay.example';
const NOW = '2026-11-09T01:26:00Z';

const answers: Record<string, string> = {
  '/awc/cache/metars.cache.csv.gz': 'metars.cache.csv',
  '/awc/cache/tafs.cache.xml.gz': 'tafs.cache.xml',
  '/awc/isigmet?format=json': 'isigmet.json',
  '/awc/airsigmet?format=json': 'airsigmet.json',
};

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
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
