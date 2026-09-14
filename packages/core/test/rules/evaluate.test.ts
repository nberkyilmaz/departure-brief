/**
 * End-to-end: resolved flight + profile → briefing. Over the memory store
 * seeded from the recorded AWC responses and the NASR slice (the US fixture
 * flight), plus solar and profile-parsing checks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFlightPlan } from '../../src/domain/flight.js';
import { parseAircraftLimits, parsePilotProfile } from '../../src/domain/profile.js';
import { isNight, solarElevation } from '../../src/domain/sun.js';
import { AWC_BASE_URL, AwcClient } from '../../src/fetch/awc.js';
import { storeAndDecode } from '../../src/store/decode.js';
import { readNasrDirectory } from '../../src/fetch/nasr.js';
import { resolveFlight } from '../../src/resolve/flight.js';
import { briefingText } from '../../src/rules/describe.js';
import { evaluateFlight } from '../../src/rules/evaluate.js';
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

describe('solar elevation', () => {
  const cysn = { lat: 43.1916, lon: -79.1717 };
  it('sunrise at CYSN on 2026-09-07 is close to 10:50Z and sunset to 23:40Z', () => {
    expect(Math.abs(solarElevation(cysn, new Date('2026-09-07T10:50:00Z')))).toBeLessThan(1.5);
    expect(Math.abs(solarElevation(cysn, new Date('2026-09-07T23:40:00Z')))).toBeLessThan(1.5);
    expect(solarElevation(cysn, new Date('2026-09-07T17:15:00Z'))).toBeGreaterThan(50);
    expect(solarElevation(cysn, new Date('2026-09-07T05:00:00Z'))).toBeLessThan(-30);
  });
  it('civil twilight: night ~30 minutes after sunset, not at sunset', () => {
    expect(isNight(cysn, new Date('2026-09-07T23:45:00Z'))).toBe(false);
    expect(isNight(cysn, new Date('2026-09-08T00:20:00Z'))).toBe(true);
    expect(isNight(cysn, new Date('2026-09-07T15:00:00Z'))).toBe(false);
  });
});

describe('profile and aircraft parsing', () => {
  it('reads the owner profile', () => {
    expect(profile).toEqual({ version: 1, name: 'default', ceiling: 2500, visibility: 5, crosswind: 15, crosswindIncludesGust: true, maxGustSpread: null, nightAllowed: true });
    expect(aircraft).toEqual({ type: 'C172', demonstratedCrosswind: null, demonstratedCrosswindSource: null });
  });
  it('rejects nonsense with a message naming the field', () => {
    expect(() => parsePilotProfile({ ceilingAglFt: -1 })).toThrow('ceilingAglFt');
    expect(() => parseAircraftLimits({})).toThrow('"type"');
  });
});

describe('evaluateFlight', () => {
  it('gives a verdict per point with cited findings, and never a verdict without findings', async () => {
    const store = await seededStore();
    const resolved = await resolveFlight(store, plan, new Date('2026-09-07T12:30:00Z'));
    const b = evaluateFlight(resolved, profile, aircraft);
    expect(b.rulesVersion).toBe(3);
    expect(b.profile).toEqual({ name: 'default', version: 1 });
    expect(b.aircraft).toBe('C172');
    expect(b.points.map((p) => p.waypoint)).toEqual(['KTEB', 'N07', 'KHPN']);
    for (const p of [...b.points, b.alternate!]) {
      expect(p.findings.length).toBeGreaterThan(0);
      for (const f of p.findings) {
        expect(f.waypoint).toBe(p.waypoint);
        if (f.severity !== 'advisory') expect(f.citations.length).toBeGreaterThan(0);
        for (const c of f.citations) if (c.span && c.raw) expect(c.raw.slice(c.span.start, c.span.end)).toBe(c.text);
      }
    }
    // Recorded conditions were VFR everywhere: 35004KT P6SM SKC and the like.
    expect(b.verdict).toBe('go');
    // N07 borrowed KTEB's TAF and says so; it has no runways in the crosswind check? It does (NASR) — and no METAR.
    const n07 = b.points[1]!;
    expect(n07.findings.some((f) => f.rule === 'forecast.borrowed')).toBe(true);
    expect(n07.findings.some((f) => f.basis.startsWith('observed'))).toBe(false);
    // KTEB at departure: prevailing checks, regulatory Class D, and the 1151Z observation as hard evidence for a 1300Z departure.
    const kteb = b.points[0]!;
    // KTEB's TAF was `35004KT P6SM SKC`: nothing to clear, so no cloud-clearance finding — and none faked.
    expect(kteb.findings.map((f) => f.rule)).toEqual(expect.arrayContaining(['personal.ceiling', 'personal.visibility', 'crosswind.personal', 'vfr.visibility']));
    expect(kteb.findings.some((f) => f.rule === 'vfr.cloudClearance')).toBe(false);
    expect(kteb.findings.find((f) => f.basis.startsWith('observed'))!.severity).not.toBe('marginal');
  });

  it('a stricter profile turns the same flight into a no-go with the prevailing finding cited', async () => {
    const store = await seededStore();
    const resolved = await resolveFlight(store, plan, new Date('2026-09-07T12:30:00Z'));
    // KTEB's 35004KT is 13° off runway 01: about 0.9 kt across. Half a knot is the only way to trip it.
    const strict = parsePilotProfile({ name: 'strict', ceilingAglFt: 2500, visibilitySm: 5, crosswindKt: 0.5 });
    const b = evaluateFlight(resolved, strict, null);
    expect(b.verdict).toBe('no-go');
    const f = b.points[0]!.findings.find((f) => f.rule === 'crosswind.personal' && f.severity === 'no-go')!;
    expect(f.basis).toBe('prevailing');
    expect(f.citations[0]!.kind).toBe('taf');
    expect(f.citations[0]!.text).toMatch(/^\d{5}KT$/);
  });

  it('with nothing known as of an early time, every point is marginal for lack of a forecast', async () => {
    const store = await seededStore();
    const resolved = await resolveFlight(store, plan, new Date('2026-09-07T11:00:00Z'));
    const b = evaluateFlight(resolved, profile, aircraft);
    expect(b.verdict).toBe('marginal');
    expect(b.points.every((p) => p.findings.some((f) => f.rule === 'forecast.coverage'))).toBe(true);
  });

  it('is deterministic and renders', async () => {
    const store = await seededStore();
    const resolved = await resolveFlight(store, plan, new Date('2026-09-07T12:30:00Z'));
    expect(evaluateFlight(resolved, profile, aircraft)).toEqual(evaluateFlight(resolved, profile, aircraft));
    const text = briefingText(evaluateFlight(resolved, profile, aircraft));
    expect(text).toContain('VERDICT: GO');
    expect(text).toContain('not an official briefing');
    expect(text).toMatch(/ok\s+\[prevailing\] .*← "/);
  });
});
