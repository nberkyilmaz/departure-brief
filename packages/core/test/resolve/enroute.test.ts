/**
 * The weather between the fields a flight names, over the recorded
 * snapshot of 19 September 2026: every Canadian station that was reporting,
 * its own METAR and TAF, at their real times and positions.
 *
 * Ottawa to Toronto, direct, passes Trenton about two dozen miles to the
 * left and Toronto Island eight miles to the left, both with a TAF and a
 * METAR of their own. Nothing here is arranged except the flight.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { departureWindow } from '../../src/brief/window.js';
import { diffBriefings } from '../../src/brief/diff.js';
import { assembleBriefing } from '../../src/brief/assemble.js';
import { parseFlightPlan, type FlightPlan } from '../../src/domain/flight.js';
import { parseAircraftLimits, parsePilotProfile } from '../../src/domain/profile.js';
import { AWC_BASE_URL, AwcClient } from '../../src/fetch/awc.js';
import { readOurAirportsDirectory } from '../../src/fetch/ourairports.js';
import { CORRIDOR_NM, ON_TRACK_NM } from '../../src/resolve/enroute.js';
import { resolveFlight } from '../../src/resolve/flight.js';
import { evaluateFlight } from '../../src/rules/evaluate.js';
import { storeAndDecode } from '../../src/store/decode.js';
import { MemoryStore } from '../../src/store/memory.js';

const root = join(__dirname, '..', '..', '..', '..');
const SNAPSHOT = join(__dirname, '..', 'fixtures', 'fetch', 'canada-2026-09-18');
const weather = JSON.parse(readFileSync(join(SNAPSHOT, 'weather.json'), 'utf8')) as {
  _recorded: string;
  metar: { icaoId: string }[];
  taf: { icaoId: string }[];
};
const RECORDED = new Date(`${weather._recorded.slice(0, 16)}:00Z`);
const profileJson = JSON.parse(readFileSync(join(root, 'profiles', 'default.json'), 'utf8')) as Record<string, unknown>;
const profile = parsePilotProfile(profileJson);
const aircraft = parseAircraftLimits(JSON.parse(readFileSync(join(root, 'aircraft', 'c172.json'), 'utf8')));

/** Every station in the recorded responses, through the real client, as the relay's whole-country files would arrive. */
async function seeded(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.putAirports(readOurAirportsDirectory(join(SNAPSHOT, 'ourairports'), { snapshot: '2026-09-18' }).filter((a) => a.siteType === 'A'));
  const awc = new AwcClient({
    async get(url) {
      return { status: 200, body: JSON.stringify(url.startsWith(`${AWC_BASE_URL}/taf`) ? weather.taf : weather.metar), headers: {} };
    },
  });
  const ids = (rows: { icaoId: string }[]) => [...new Set(rows.map((r) => r.icaoId))];
  const m = await awc.metars(ids(weather.metar));
  await storeAndDecode(store, m.reports, m.request, RECORDED);
  const t = await awc.tafs(ids(weather.taf));
  await storeAndDecode(store, t.reports, t.request, RECORDED);
  return store;
}

const DEPART = new Date(RECORDED.getTime() + 3_600_000);
const flight = (departure: string, destination: string, route: string[] = []): FlightPlan =>
  parseFlightPlan({ departure, destination, alternate: null, route, departureTime: DEPART.toISOString(), cruise: { tas: 110, altitude: 4500 }, airspace: null });

describe('the stations along the way', () => {
  it('reads the ones beside the track, in the order they are passed', async () => {
    const f = await resolveFlight(await seeded(), flight('CYOW', 'CYYZ'), RECORDED);
    expect(f.enroute.map((s) => s.station)).toEqual(['CYTR', 'CYTZ']);
    const [cytr, cytz] = f.enroute;
    expect(cytr!.offset).toBeLessThan(-ON_TRACK_NM);
    expect(Math.abs(cytz!.offset)).toBeLessThan(ON_TRACK_NM);
    for (const s of f.enroute) {
      expect(Math.abs(s.offset)).toBeLessThanOrEqual(CORRIDOR_NM);
      expect(s.cumulative).toBeGreaterThan(0);
      expect(s.cumulative).toBeLessThan(f.route.total);
      // Each speaks for itself: its own TAF for the time it is passed, its own current METAR.
      expect(s.forecast?.station).toBe(s.station);
      expect(s.forecast?.resolved.prevailing).not.toBeNull();
      expect(s.metar?.station).toBe(s.station);
    }
  });

  it('times each one as every ETA is timed: distance along the track over the planned speed', async () => {
    const f = await resolveFlight(await seeded(), flight('CYOW', 'CYYZ'), RECORDED);
    for (const s of f.enroute) expect(Math.abs(s.eta.getTime() - (DEPART.getTime() + (s.cumulative / 110) * 3_600_000))).toBeLessThan(1);
    expect(f.enroute[0]!.eta.getTime()).toBeLessThan(f.enroute[1]!.eta.getTime());
  });

  it('does not read again a station a named field already reads', async () => {
    // Peterborough publishes nothing at this hour and borrows Trenton's TAF and METAR, so Trenton is on Peterborough's card, not listed beside it.
    const f = await resolveFlight(await seeded(), flight('CYSN', 'CYOW', ['CYPQ']), RECORDED);
    const cypq = f.points.find((p) => p.point.waypoint.id === 'CYPQ')!;
    expect(cypq.forecast?.station).toBe('CYTR');
    expect(f.enroute.map((s) => s.station)).not.toContain('CYTR');
    expect(f.enroute.map((s) => s.station)).not.toContain('CYPQ');
    expect(f.enroute.every((s) => s.leg === 0 || s.leg === 1)).toBe(true);
  });

  it('judges them by the same limits, and a station off the line only ever as a caution', async () => {
    // Minimums no evening could meet, so that every station along the way crosses them.
    const strict = parsePilotProfile({ ...profileJson, ceilingAglFt: 20_000, visibilitySm: 50 });
    const b = evaluateFlight(await resolveFlight(await seeded(), flight('CYOW', 'CYYZ'), RECORDED), strict, aircraft);
    const [cytr, cytz] = b.enroute;
    expect(cytr!.station).toBe('CYTR');
    expect(cytr!.findings.some((x) => x.attention === 'caution' && x.rule === 'personal.visibility')).toBe(true);
    expect(cytr!.findings.some((x) => x.attention === 'alert')).toBe(false);
    // On the line, the prevailing forecast crossing a limit is an alert, as it is at either end.
    expect(cytz!.findings.some((x) => x.attention === 'alert' && x.basisKind === 'prevailing' && x.rule === 'personal.visibility')).toBe(true);
    // Not the runways or the legal minima: those are for the fields the flight lands at.
    for (const s of b.enroute) expect(s.findings.every((x) => ['weather.present', 'personal.ceiling', 'personal.visibility'].includes(x.rule))).toBe(true);
    for (const s of b.enroute) for (const x of s.findings) expect(x.waypoint).toBe(s.station);
  });

  it('says in the strip what the worst forecast along the way is at each hour, from the forecasts alone', async () => {
    const store = await seeded();
    const strict = parsePilotProfile({ ...profileJson, ceilingAglFt: 20_000, visibilitySm: 50 });
    const slots = await departureWindow(store, flight('CYOW', 'CYYZ'), strict, aircraft, RECORDED, 3);
    for (const slot of slots) {
      const judged = evaluateFlight(await resolveFlight(store, { ...flight('CYOW', 'CYYZ'), departureTime: slot.departAt }, RECORDED), strict, aircraft);
      const forecast = judged.enroute.filter((s) => s.forecastCategory !== null);
      expect(slot.along.covered).toBe(forecast.length);
      expect(forecast.map((s) => s.station)).toContain(slot.along.station);
      expect(slot.along.findings.length).toBeGreaterThan(0);
      expect(slot.along.findings.every((x) => x.basisKind === 'prevailing' || x.basisKind === 'overlay')).toBe(true);
    }
  });

  it('records what each one was read from, and diffs them without calling a quiet station news', async () => {
    const store = await seeded();
    const resolved = await resolveFlight(store, flight('CYOW', 'CYYZ'), RECORDED);
    const b = assembleBriefing(resolved, profile, aircraft, RECORDED);
    expect(b.document.inputs.enroute.map((s) => s.station)).toEqual(['CYTR', 'CYTZ']);
    for (const s of b.document.inputs.enroute) {
      expect(b.document.inputs.reports.map((r) => r.sha256)).toContain(s.forecast);
      expect(b.document.inputs.reports.map((r) => r.sha256)).toContain(s.metar);
    }

    // A briefing made before the stations along the way were read has none; the same weather briefed now adds them, and that alone is not news.
    const older = { ...b, document: { ...b.document, briefing: { ...b.document.briefing, enroute: undefined as never } } };
    const quiet = b.document.briefing.enroute.every((s) => s.findings.every((x) => x.attention === 'routine' || x.attention === 'note'));
    const d = diffBriefings(older, b);
    expect(d.enroute.map((p) => p.waypoint)).toEqual(['CYTR', 'CYTZ']);
    expect(d.quiet).toBe(quiet);

    // Minimums that every station crosses: that is news, station by station.
    const strict = assembleBriefing(resolved, parsePilotProfile({ ...profileJson, ceilingAglFt: 20_000, visibilitySm: 50 }), aircraft, RECORDED);
    const worse = diffBriefings(b, strict);
    expect(worse.quiet).toBe(false);
    expect(worse.enroute.flatMap((p) => p.changes).some((c) => c.crossesLimit)).toBe(true);
  });
});
