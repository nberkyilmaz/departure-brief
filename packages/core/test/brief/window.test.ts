/**
 * When can I go, over the recorded TAFs for Teterboro and White Plains of
 * 7 September 2026. The window has to say, for every hour, exactly what the
 * briefing would have said had that hour been asked for — so most of this
 * checks it against the briefing's own judgement rather than against
 * numbers typed in here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { departureWindow, WINDOW_HOURS } from '../../src/brief/window.js';
import { parseFlightPlan } from '../../src/domain/flight.js';
import { parseAircraftLimits, parsePilotProfile } from '../../src/domain/profile.js';
import { AWC_BASE_URL, AwcClient } from '../../src/fetch/awc.js';
import { readNasrDirectory } from '../../src/fetch/nasr.js';
import { resolveFlight } from '../../src/resolve/flight.js';
import { evaluateFlight } from '../../src/rules/evaluate.js';
import { storeAndDecode } from '../../src/store/decode.js';
import { MemoryStore } from '../../src/store/memory.js';
import { FIXTURES, replayHttp } from '../helpers/http.js';

const root = join(__dirname, '..', '..', '..', '..');
const plan = parseFlightPlan(JSON.parse(readFileSync(join(root, 'flights', 'demo-kteb-khpn.json'), 'utf8')));
const profile = parsePilotProfile(JSON.parse(readFileSync(join(root, 'profiles', 'default.json'), 'utf8')));
const aircraft = parseAircraftLimits(JSON.parse(readFileSync(join(root, 'aircraft', 'c172.json'), 'utf8')));

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

const ASOF = new Date('2026-09-07T12:20:00Z');

describe('departureWindow', () => {
  it('takes every whole hour from the next one, the destination when you would arrive', async () => {
    const slots = await departureWindow(await seededStore(), plan, profile, aircraft, ASOF);
    expect(slots).toHaveLength(WINDOW_HOURS);
    expect(slots[0]!.departAt).toBe('2026-09-07T13:00:00.000Z');
    expect(slots.at(-1)!.departAt).toBe('2026-09-08T00:00:00.000Z');
    for (const s of slots) {
      // The ends of the flight only: N07, in the middle, is the briefing's business.
      expect(s.points.map((p) => p.waypoint)).toEqual(['KTEB', 'KHPN']);
      expect(s.points[0]!.at).toBe(s.departAt);
      expect(Date.parse(s.points[1]!.at)).toBeGreaterThan(Date.parse(s.departAt));
    }
  });

  it('says what the briefing would have said for that hour, and nothing about now', async () => {
    const store = await seededStore();
    const slots = await departureWindow(store, plan, profile, aircraft, ASOF);
    for (const s of [slots[0]!, slots[5]!, slots[11]!]) {
      const judged = evaluateFlight(await resolveFlight(store, { ...plan, departureTime: s.departAt }, ASOF), profile, aircraft);
      const ends = [judged.points[0]!, judged.points.at(-1)!];
      s.points.forEach((p, i) => {
        expect(p.category).toBe(ends[i]!.forecastCategory);
        const asked = ends[i]!.findings.filter((f) => (f.attention === 'alert' || f.attention === 'caution') && f.basisKind !== 'observed' && f.basisKind !== 'plan' && !f.rule.startsWith('forecast.'));
        expect(p.findings).toEqual(asked);
      });
      // The observation describes now, and now does not move with the departure time.
      expect(s.points.flatMap((p) => p.findings).some((f) => f.basisKind === 'observed')).toBe(false);
    }
  });

  it('carries the forecast category, and says whose forecast it is', async () => {
    const slots = await departureWindow(await seededStore(), plan, profile, aircraft, ASOF);
    // Clear skies and more than six miles all day at both: VFR every hour.
    expect(slots.flatMap((s) => s.points.map((p) => p.category))).toEqual(new Array(WINDOW_HOURS * 2).fill('VFR'));
    expect(slots[0]!.points.map((p) => p.forecastStation)).toEqual(['KTEB', 'KHPN']);
  });

  it('marks the hours a limit is crossed, and only those', async () => {
    // Day only: the hours that land after dark ask for attention, the ones before do not.
    const dayOnly = { ...profile, nightAllowed: false };
    const slots = await departureWindow(await seededStore(), plan, dayOnly, aircraft, ASOF);
    const night = (s: (typeof slots)[number]) => s.points.some((p) => p.findings.some((f) => f.rule === 'personal.night'));
    expect(night(slots[0]!)).toBe(false);
    expect(night(slots.at(-1)!)).toBe(true);
    // And each end says whether it is night there, whatever the minimums: 9 a.m. and 8 p.m. in New York.
    expect(slots[0]!.points.map((p) => p.night)).toEqual([false, false]);
    expect(slots.at(-1)!.points.map((p) => p.night)).toEqual([true, true]);
    // Once dark, it stays dark for the rest of the window.
    const firstDark = slots.findIndex(night);
    expect(firstDark).toBeGreaterThan(0);
    expect(slots.slice(firstDark).every(night)).toBe(true);
  });

  it('borrows a neighbour’s forecast once a field’s own runs out, as the briefing does, and says whose', async () => {
    // White Plains' TAF ends at 12Z on the 8th; Teterboro's and Kennedy's run to 18Z.
    const slots = await departureWindow(await seededStore(), plan, profile, aircraft, new Date('2026-09-08T03:30:00Z'));
    expect(slots[0]!.points[1]).toMatchObject({ waypoint: 'KHPN', covered: true, forecastStation: 'KHPN' });
    const late = slots.at(-1)!.points[1]!;
    expect(late).toMatchObject({ waypoint: 'KHPN', covered: true });
    expect(late.forecastStation).not.toBe('KHPN');
  });

  it('says when no forecast covers the time at all, rather than calling it clear', async () => {
    // From 18Z on the 8th nothing recorded covers either end.
    const slots = await departureWindow(await seededStore(), plan, profile, aircraft, new Date('2026-09-08T08:30:00Z'));
    expect(slots[0]!.points.every((p) => p.covered)).toBe(true);
    const last = slots.at(-1)!;
    expect(last.departAt).toBe('2026-09-08T20:00:00.000Z');
    expect(last.points).toMatchObject([
      { waypoint: 'KTEB', covered: false, category: null },
      { waypoint: 'KHPN', covered: false, category: null },
    ]);
  });
});
