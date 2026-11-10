/**
 * Pilot reports on the page: the side view and the map, drawn from the
 * AWC's file of 05:59Z on 9 November 2026 through the page's own engine.
 * The clock is held at the moment it was recorded.
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadEngine, type LocalBriefing } from '../src/engine.js';
import { columnsOf, notesOf, pirepTag, pirepWords, placePireps } from '../src/picture.js';
import { routeMarks } from '../src/routeLayers.js';
import { SideView } from '../src/SideView.js';
import type { PicturePirep } from '../src/types.js';

const DEMO = join(__dirname, '..', 'public', 'demo');
const FETCH = join(__dirname, '..', '..', '..', 'packages', 'core', 'test', 'fixtures', 'fetch');
const NE = join(FETCH, 'northeast-2026-11-09');
const RELAY = 'https://relay.example';
const NOW = '2026-11-09T05:59:55Z';

const answers: Record<string, string> = {
  '/awc/cache/metars.cache.csv.gz': readFileSync(join(NE, 'metars.cache.csv'), 'utf8'),
  '/awc/cache/tafs.cache.xml.gz': readFileSync(join(NE, 'tafs.cache.xml'), 'utf8'),
  '/awc/cache/aircraftreports.cache.xml.gz': readFileSync(join(FETCH, 'pireps-2026-11-09', 'aircraftreports.cache.xml'), 'utf8'),
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
    const body = answers[url.slice(RELAY.length)];
    if (body === undefined) throw new TypeError('Failed to fetch');
    return new Response(body, { status: 200, headers: { 'X-Fetched-At': NOW } });
  }) as typeof fetch;
});

afterEach(cleanup);
afterAll(() => {
  vi.useRealTimers();
});

async function briefed(departure = 'KALB', destination = 'KPIT', altitude = 6500): Promise<LocalBriefing> {
  const engine = await loadEngine('/', RELAY);
  const plan = { ...engine.plan, departure, destination, alternate: null, route: [], departureTime: '2026-11-09T06:15:00Z', cruise: { tas: 110, altitude }, airspace: null };
  return engine.brief(plan, engine.profile, engine.aircraft);
}

const NOW_MS = Date.parse(NOW);

describe('a pilot report in words', () => {
  it('says what was found, how high, in what, how long ago and where', async () => {
    const { picture } = await briefed();
    expect(pirepWords(picture.pireps[0]!, NOW_MS)).toBe('Moderate rime icing, at 9,500 ft, -7 °C, S22T, 38 min ago. 144 nm along your route.');
    expect(pirepWords(picture.pireps[1]!, NOW_MS)).toBe('Low-level wind shear, at 1,000 ft, CRJ2, 33 min ago. 266 nm along your route, 38 nm left of it.');
  });

  it('gives a band as a band, and says when there is no height', async () => {
    const { picture } = await briefed('PANC', 'PAFA', 9500);
    expect(pirepWords(picture.pireps[0]!, NOW_MS)).toMatch(/^Light mixed icing from 4,000 to 6,200 ft, at 6,000 ft, -8 °C, E75L, 65 min ago\. 224 nm along your route, 7 nm left of it\.$/);
    const denver = await briefed('KFSD', 'KDEN', 9500);
    expect(pirepWords(denver.picture.pireps[2]!, NOW_MS)).toMatch(/^No turbulence, descending, height not given, B739, /);
  });

  it('falls back on the report itself when the fields say nothing', () => {
    const remark: PicturePirep = { station: 'PGUM', text: 'PGUM UA /OV PGUM/TM 0533/FL020/TP B38M/RM DURD RWY IN SIGHT AT 020', at: '2026-11-09T05:33:00Z', lat: 13.484, lon: 144.797, nm: 10, offsetNm: 0, passAt: NOW, speaksForThen: true, altitudeFt: 2000, phase: null, aircraft: 'B38M', urgent: false, tempC: null, clouds: [], turbulence: [], icing: [] };
    expect(pirepWords(remark, NOW_MS)).toMatch(/^As filed, at 2,000 ft/);
    expect(pirepTag(remark)).toBe('');
  });

  it('puts a few letters beside the mark', async () => {
    const { picture } = await briefed();
    expect(picture.pireps.map(pirepTag)).toEqual(['MOD ICE', 'LLWS']);
    const denver = await briefed('KFSD', 'KDEN', 9500);
    expect(pirepTag(denver.picture.pireps[1]!)).toBe('NEG TB');
  });
});

describe('placing them on the chart', () => {
  const at = (nm: number, altitudeFt: number | null) => ({ nm, altitudeFt }) as PicturePirep;

  it('leaves off what has no height or is above the chart, keeping each one its number', () => {
    const placed = placePireps([at(10, null), at(20, 3000), at(30, 20_000)], 10_000, (nm) => nm, (ft) => 300 - ft / 40);
    expect(placed.map((p) => [p.n, p.x, p.y])).toEqual([[2, 20, 225]]);
  });

  it('steps crowded ones apart so each can be read', () => {
    const placed = placePireps([at(10, 3000), at(12, 3050), at(14, 3000)], 10_000, (nm) => nm, (ft) => 300 - ft / 40);
    const ys = placed.map((p) => p.y);
    expect(new Set(ys.map(Math.round)).size).toBe(3);
    expect(Math.min(...ys.slice(1).map((y, i) => Math.abs(y - ys[i]!)))).toBeGreaterThanOrEqual(16);
  });
});

describe('the side view', () => {
  it('marks each report at its height, filled or hollow, and lists it with the report as filed', async () => {
    const { briefing, picture } = await briefed();
    const { container } = render(<SideView stored={briefing} picture={picture} />);
    expect(container.querySelectorAll('.side-plot .sv-pirep')).toHaveLength(2);
    // Both will be more than ninety minutes old when you get there.
    expect(container.querySelectorAll('.side-plot .sv-pirep.hollow')).toHaveLength(2);
    const rows = [...container.querySelectorAll('.side-pireps li')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('.side-pirep-text')!.textContent).toBe('ITH UA /OV ITH210045/TM 0522/FL095/TP S22T/TA M07/IC MOD RIME');
  });

  it('fills the one that speaks for when you pass', async () => {
    const { briefing, picture } = await briefed('KFSD', 'KDEN', 9500);
    const { container } = render(<SideView stored={briefing} picture={picture} />);
    expect(container.querySelectorAll('.side-plot .sv-pirep:not(.hollow)')).toHaveLength(1);
  });

  it('says what they are and how far to go on them', async () => {
    const { briefing, picture } = await briefed();
    const notes = notesOf(picture, columnsOf(briefing, picture), false).join(' ');
    expect(notes).toContain('the only source of tops, icing and turbulence here');
    expect(notes).toContain('Where nobody has reported, the chart shows nothing, which does not mean nothing is there.');
  });

  it('says that nobody has reported, without calling that good news', async () => {
    const { briefing, picture } = await briefed('KMIA', 'KTPA');
    expect(picture.pireps).toEqual([]);
    expect(notesOf(picture, columnsOf(briefing, picture), false).join(' ')).toContain('No pilot has reported within 50 nm of your route in the last 90 minutes. That says nothing about the air');
  });

  it('says nothing about them when there are none to go by', async () => {
    const { briefing, picture } = await briefed();
    expect(notesOf({ ...picture, pireps: [], pirepsHeld: 0 }, columnsOf(briefing, picture), false).join(' ')).not.toMatch(/[Pp]ilot/);
  });
});

describe('the map', () => {
  it('puts a numbered mark on each, the same numbers as the list', async () => {
    const { briefing, picture } = await briefed();
    const marks = routeMarks(briefing, picture).filter((m) => m.kind === 'pirep');
    expect(marks.map((m) => m.text)).toEqual(['1', '2']);
    expect(marks.every((m) => m.className === 'rm-pirep hollow')).toBe(true);
    // Tapped, each says what it is and shows the report it came from.
    expect(marks.map((m) => m.popup!.code)).toEqual(picture.pireps.map((p) => p.text));
  });
});
