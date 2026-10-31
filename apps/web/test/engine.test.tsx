/**
 * The page's two sources of weather, and the line between them.
 *
 * The relay is played by a table of real recorded answers — the METAR and
 * TAF cache files of 2026-10-20, a recorded day's upper winds and NOTAMs —
 * served the way a browser receives them: already decompressed, with the
 * relay's age header. The clock is held at the moment those files were
 * taken, so "now" is the morning they describe.
 */
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadEngine } from '../src/engine.js';
import { WeatherNote } from '../src/WeatherNote.js';

const DEMO = join(__dirname, '..', 'public', 'demo');
const FETCH = join(__dirname, '..', '..', '..', 'packages', 'core', 'test', 'fixtures', 'fetch');
const RELAY = 'https://relay.example';
const FETCHED_AT = '2026-10-20T04:55:00.000Z';

const file = (...p: string[]) => readFileSync(join(...p), 'utf8');

type Answer = { status: number; body: string } | 'unreachable';

/** The relay's answers by path, as a browser would see them. */
function relayAnswers(): Record<string, Answer> {
  return {
    '/awc/cache/metars.cache.csv.gz': { status: 200, body: file(FETCH, 'awc-cache-2026-10-20', 'metars.cache.csv') },
    '/awc/cache/tafs.cache.xml.gz': { status: 200, body: file(FETCH, 'awc-cache-2026-10-20', 'tafs.cache.xml') },
    '/awc/isigmet?format=json': { status: 200, body: '[]' },
    '/awc/airsigmet?format=json': { status: 200, body: '[]' },
    upperwind: { status: 200, body: file(FETCH, 'canada-2026-09-18', 'upperwind.json') },
    ...Object.fromEntries(['CYSN', 'CYKF', 'CYHM'].map((s) => [`/cfps/?site=${s}&alpha=notam`, { status: 200, body: file(FETCH, 'canada-2026-09-18', 'notam', `${s}.json`) }])),
  };
}

let answers: Record<string, Answer> = relayAnswers();
let asked: string[] = [];

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T05:00:00Z'));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!url.startsWith(RELAY)) {
      // The page's own files, the squares of aerodromes among them.
      try {
        return new Response(file(DEMO, url.slice(url.indexOf('demo/') + 'demo/'.length)), { status: 200 });
      } catch {
        return new Response('not found', { status: 404 });
      }
    }
    asked.push(url);
    const path = url.slice(RELAY.length);
    const answer = path.includes('alpha=upperwind') ? answers['upperwind'] : answers[path];
    // What a refused connection, or a relay that does not name this page, looks like from inside fetch.
    if (!answer || answer === 'unreachable') throw new TypeError('Failed to fetch');
    return new Response(answer.body, { status: answer.status, headers: { 'X-Fetched-At': FETCHED_AT } });
  }) as typeof fetch;
});

afterEach(() => {
  answers = relayAnswers();
  asked = [];
});

afterAll(() => {
  vi.useRealTimers();
});

describe('live weather through the relay', () => {
  it('holds the live reports and none of the recorded ones', async () => {
    const engine = await loadEngine('/', RELAY);
    expect(engine.weather).toEqual({ mode: 'live', at: FETCHED_AT, problem: null, missing: [] });
    const yyz = engine.reports.find((r) => r.kind === 'metar' && r.station === 'CYYZ');
    expect(yyz?.body).toBe('METAR CYYZ 200400Z 35010KT 15SM SKC 11/07 A3036 RMK SLP286');
    // Nothing from the recorded day of 2026-09-19 survives into a live store.
    // A TAF issued last evening and still in force is live weather; September's is not.
    expect(engine.reports.filter((r) => r.kind === 'metar' || r.kind === 'taf').every((r) => (r.issuedAt ?? '') >= '2026-10-19')).toBe(true);
    // The world's stations arrive; only those the page has an aerodrome for are kept.
    expect(engine.reports.some((r) => r.station === 'EGLL')).toBe(false);
  });

  it('describes a field from this morning, not from the recording', async () => {
    const engine = await loadEngine('/', RELAY);
    const field = await engine.aerodrome('CYYZ');
    expect(JSON.stringify(field)).toContain('200400Z');
  });

  it('briefs a flight departing after now, and fetches its NOTAMs through the relay', async () => {
    const engine = await loadEngine('/', RELAY);
    const r = await engine.brief({ ...engine.plan, departureTime: '2026-10-20T12:00:00Z' }, engine.profile, engine.aircraft);
    expect(r.briefing.asOf).toBe('2026-10-20T05:00:00.000Z');
    for (const site of ['CYSN', 'CYKF', 'CYHM']) expect(asked).toContain(`${RELAY}/cfps/?site=${site}&alpha=notam`);
    // Ranked by the rules alone: no model's name on a ranking no model made.
    expect(engine.model).toBeNull();
    expect(r.briefing.document.notams?.model ?? null).toBeNull();
    // And the NOTAMs it fetched are on the reports page.
    expect(engine.reports.some((h) => h.kind === 'notam' && h.fetchedFor.includes('CYSN'))).toBe(true);
  });

  it('asks for a site’s NOTAMs once, however many times the flight is rebuilt', async () => {
    const engine = await loadEngine('/', RELAY);
    const plan = { ...engine.plan, departureTime: '2026-10-20T12:00:00Z' };
    await engine.brief(plan, engine.profile, engine.aircraft);
    await engine.brief(plan, { ...engine.profile, visibilitySm: 6 }, engine.aircraft);
    expect(asked.filter((u) => u.includes('site=CYSN&alpha=notam'))).toHaveLength(1);
  });

  it('carries every field in Canada and the United States, and keeps the American reports', async () => {
    const engine = await loadEngine('/', RELAY);
    expect(engine.aerodromes.length).toBeGreaterThan(17_000);
    expect(engine.aerodromes.find((a) => a.id === 'KMIA')).toMatchObject({ faaId: 'MIA', name: 'Miami International Airport' });
    expect(engine.reports.some((r) => r.kind === 'metar' && r.station === 'KBUF')).toBe(true);
    // Not Mexico's: there is neither an aerodrome nor a rule book here for it.
    expect(engine.reports.some((r) => r.station === 'MMMY')).toBe(false);
    // A field far from anywhere recorded, with its runways, fetched when it is asked about.
    const miami = await engine.aerodrome('kmia');
    expect(miami?.airport.name).toBe('Miami International Airport');
    expect(miami?.airport.runways.map((r) => r.id)).toContain('09/27');
    expect((await engine.airport('MIA'))?.icaoId).toBe('KMIA');
  });

  it('does not ask NAV CANADA for an American field’s NOTAMs, and says where to look', async () => {
    const engine = await loadEngine('/', RELAY);
    const plan = { ...engine.plan, departure: 'KBUF', destination: 'KIAG', alternate: null, route: [], departureTime: '2026-10-20T12:00:00Z' };
    const r = await engine.brief(plan, engine.profile, engine.aircraft);
    expect(asked.filter((u) => u.includes('alpha=notam'))).toEqual([]);
    const errors = r.briefing.document.notams?.fetchErrors ?? [];
    expect(errors.map((e) => e.site).sort()).toEqual(['KBUF', 'KIAG']);
    expect(errors[0]!.error).toMatch(/FAA.*notams\.aim\.faa\.gov/);
  });

  it('carries on without upper winds, and says they are missing', async () => {
    answers['upperwind'] = { status: 503, body: '{"error":"down"}' };
    const engine = await loadEngine('/', RELAY);
    expect(engine.weather.mode).toBe('live');
    expect(engine.weather.missing).toEqual(['upper winds']);
  });
});

describe('falling back to the recorded weather', () => {
  it('when the METARs cannot be had, it shows the recorded reports and says why', async () => {
    answers['/awc/cache/metars.cache.csv.gz'] = { status: 503, body: '{"error":"no metars held yet"}' };
    const engine = await loadEngine('/', RELAY);
    expect(engine.weather.mode).toBe('recorded');
    expect(engine.weather.at).toBe('2026-09-19T00:52:00.000Z');
    expect(engine.weather.problem).toMatch(/METARs/);
    // All recorded, none live: never a mixture.
    expect(engine.reports.some((r) => (r.issuedAt ?? '').startsWith('2026-10-20'))).toBe(false);
    expect(engine.reports.length).toBeGreaterThan(800);
  });

  it('when the relay is not there at all', async () => {
    for (const k of Object.keys(answers)) answers[k] = 'unreachable';
    const engine = await loadEngine('/', RELAY);
    expect(engine.weather.mode).toBe('recorded');
    expect(engine.weather.problem).toMatch(/relay could not be reached/);
  });

  it('says when a field’s NOTAMs were not among those recorded, rather than showing none', async () => {
    const engine = await loadEngine('/');
    const r = await engine.brief({ ...engine.plan, destination: 'CNC3', alternate: null }, engine.profile, engine.aircraft);
    const errors = r.briefing.document.notams?.fetchErrors ?? [];
    expect(errors.map((e) => e.site)).toEqual(['CNC3']);
    expect(errors[0]!.error).toMatch(/none were recorded for it; the recording has NOTAMs for CYHM, CYKF, CYOW, CYSN, CYTZ, CYYZ only/);
  });

  it('and with no relay configured, it never asks one', async () => {
    const engine = await loadEngine('/');
    expect(engine.weather).toEqual({ mode: 'recorded', at: '2026-09-19T00:52:00.000Z', problem: null, missing: [] });
    expect(asked).toEqual([]);
  });
});

describe('what the page says about it', () => {
  it('names live weather and its age', () => {
    render(<WeatherNote weather={{ mode: 'live', at: FETCHED_AT, problem: null, missing: ['upper winds'] }} />);
    // One line, with the age in it: the rest is on the page that explains how this works.
    expect(document.body.textContent).toMatch(/^Live weather from 04:55Z, 5 min ago\./);
    expect(document.body.textContent).toMatch(/Not available just now: upper winds/);
  });

  it('never lets a fallback pass for current weather', () => {
    render(<WeatherNote weather={{ mode: 'recorded', at: '2026-09-19T00:52:00.000Z', problem: 'the live METARs could not be fetched: HTTP 503', missing: [] }} />);
    expect(document.body.textContent).toMatch(/The weather here is frozen/);
    expect(document.body.textContent).toMatch(/Live weather could not be had — the live METARs could not be fetched/);
    expect(document.body.textContent).toMatch(/19 Sep 2026 at 00:52Z/);
    expect(document.body.textContent).toMatch(/not current ones/);
  });
});
