/**
 * An American flight through the page engine, over the relay's answers
 * recorded at 04:53Z on 9 November 2026: the wind measured by a balloon and
 * labelled so, a freezing level from the same balloons, and G-AIRMETs on
 * the map and the side view. The clock is held at the moment of recording.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadEngine, type LocalBriefing } from '../src/engine.js';
import { NavLogPage } from '../src/NavLogPage.js';
import { columnsOf, hazardKey, notesOf } from '../src/picture.js';
import { routeMarks, routeShapes } from '../src/routeLayers.js';
import { SideView } from '../src/SideView.js';
import { fieldCards, measuredWords } from '../src/summary.js';

const DEMO = join(__dirname, '..', 'public', 'demo');
const FETCH = join(__dirname, '..', '..', '..', 'packages', 'core', 'test', 'fixtures', 'fetch');
const NE = join(FETCH, 'northeast-2026-11-09');
const SND = join(FETCH, 'noaa', 'soundings-2026-11-09');
const RELAY = 'https://relay.example';
const NOW = '2026-11-09T04:53:45Z';

const modified = JSON.parse(readFileSync(join(SND, 'last-modified.json'), 'utf8')) as Record<string, string>;
const soundings = JSON.stringify(
  Object.fromEntries(
    readdirSync(SND)
      .filter((n) => n.endsWith('.txt') && modified[n])
      .map((n) => [n.replace('.txt', ''), { askedAt: NOW, modified: modified[n], text: readFileSync(join(SND, n), 'latin1') }]),
  ),
);
const answers: Record<string, string> = {
  '/awc/cache/metars.cache.csv.gz': readFileSync(join(NE, 'metars.cache.csv'), 'utf8'),
  '/awc/cache/tafs.cache.xml.gz': readFileSync(join(NE, 'tafs.cache.xml'), 'utf8'),
  '/awc/cache/gairmets.cache.xml.gz': readFileSync(join(NE, 'gairmets.cache.xml'), 'utf8'),
  '/awc/sigmet?format=json': readFileSync(join(NE, 'sigmet.json'), 'utf8'),
  '/noaa/soundings': soundings,
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

async function briefed(): Promise<LocalBriefing> {
  const engine = await loadEngine('/', RELAY);
  const plan = { ...engine.plan, departure: 'KALB', destination: 'KPIT', alternate: null, route: [], departureTime: '2026-11-09T05:30:00Z', cruise: { tas: 110, altitude: 6500 }, airspace: null };
  return engine.brief(plan, engine.profile, engine.aircraft);
}

describe('a wind measured by a balloon', () => {
  it('says so on the field card, with the balloon and its age', async () => {
    const { briefing } = await briefed();
    const [albany] = fieldCards(briefing);
    expect(albany!.lines.find((l) => l.label.startsWith('At '))!.text).toBe('271°T at 27 kt, -1 °C. Measured by the Albany balloon at 00Z, 5 h ago');
  });

  it('says so on the nav log, and how far off it was', async () => {
    const { briefing } = await briefed();
    render(<NavLogPage briefing={briefing} />);
    expect(document.body.textContent).toContain('Measured by the Pittsburgh balloon at 00Z, 5 h ago, 2 nm away');
    expect(document.body.textContent).toContain('measured by the nearest balloon in the US');
    // A real groundspeed: the blank a US leg had since the winds aloft bulletin was discontinued is gone.
    expect(briefing.document.navlog.legs[0]!.groundspeedKt).toBeGreaterThan(0);
  });

  it('words its age as minutes, then hours', () => {
    const at = '2026-11-09T12:00:00Z';
    expect(measuredWords('Albany', at, 0, Date.parse('2026-11-09T12:40:00Z'))).toBe('Measured by the Albany balloon at 12Z, 40 min ago');
    expect(measuredWords('Albany', at, 40.4, Date.parse('2026-11-09T17:10:00Z'))).toBe('Measured by the Albany balloon at 12Z, 5 h ago, 40 nm away');
  });
});

describe('the picture of an American flight', () => {
  it('draws a freezing level from the balloons, and says it was measured', async () => {
    const { briefing, picture } = await briefed();
    render(<SideView stored={briefing} picture={picture} />);
    expect(screen.getAllByText(/^0°/).length).toBeGreaterThanOrEqual(3);
    const notes = notesOf(picture, columnsOf(briefing, picture), false).join(' ');
    expect(notes).toContain('Freezing level, measured, not forecast for the time you pass: 5,800 ft by the Albany balloon at 00Z; 5,300 ft by the Buffalo balloon at 00Z, 101 nm away; 7,200 ft by the Pittsburgh balloon at 00Z, 2 nm away.');
  });

  it('gives each G-AIRMET one letter on the side view and every area it covers on the map', async () => {
    const { briefing, picture } = await briefed();
    expect(picture.hazards.map(hazardKey)[1]).toMatch(/^AIRMET TANGO 3W, MOD turbulence, surface to 8,000 ft, 2 to 288 nm, in force to /);
    const side = render(<SideView stored={briefing} picture={picture} />);
    expect(side.container.querySelectorAll('.sv-band.airmet')).toHaveLength(2);
    side.unmount();
    // Two hazards, one of them under two pictures: three areas on the map, and a letter where the route is inside each.
    expect(routeShapes(picture).hazards.features).toHaveLength(3);
    expect(routeMarks(briefing, picture).filter((m) => m.className === 'rm-tag airmet')).toHaveLength(2);
  });
});

describe('the weather note', () => {
  it('has nothing to say about US winds when the balloons are there', async () => {
    const engine = await loadEngine('/', RELAY);
    expect(engine.weather.missingUS).toEqual([]);
    expect(engine.weather.stale).toEqual([]);
  });
});
