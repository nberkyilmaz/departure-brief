/**
 * Runway lengths against the handbook, on real fields and what they
 * reported: the OurAirports records of 18 September 2026, and the METARs
 * and TAFs the weather service held on the morning of 7 September.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Conditions } from '../../src/decode/conditions.js';
import { decodeMetar } from '../../src/decode/metar/index.js';
import { decodeTaf } from '../../src/decode/taf/index.js';
import { parsePilotProfile, type PilotProfile } from '../../src/domain/profile.js';
import { readOurAirportsDirectory } from '../../src/fetch/ourairports.js';
import type { PerformanceSpec } from '../../src/perf/types.js';
import type { WaypointObservation } from '../../src/resolve/observation.js';
import { resolveTaf } from '../../src/resolve/taf.js';
import type { CheckContext } from '../../src/rules/checks.js';
import { metarConditions } from '../../src/rules/evaluate.js';
import { checkRunway, surfaceKind, type RunwayDistance } from '../../src/rules/runway.js';
import { rawReport } from '../../src/store/types.js';
import { FIXTURES } from '../helpers/http.js';

const ROOT = join(__dirname, '..', '..', '..', '..');
const spec = JSON.parse(readFileSync(join(ROOT, 'aircraft', 'c172.performance.json'), 'utf8')) as PerformanceSpec;
const profile = parsePilotProfile(JSON.parse(readFileSync(join(ROOT, 'profiles', 'default.json'), 'utf8')));
const airports = new Map(readOurAirportsDirectory(join(FIXTURES, 'canada-2026-09-18', 'ourairports'), { snapshot: '2026-09-18' }).map((a) => [a.icaoId ?? a.faaId, a]));
const lines = (kind: 'metar' | 'taf') => readFileSync(join(__dirname, '..', 'fixtures', kind, 'awc-cache-2026-09-07.txt'), 'utf8').split('\n');
const METARS = lines('metar');
const TAFS = lines('taf');

/** The station's first report in the recorded cache, as the briefing holds it. */
function observation(station: string): WaypointObservation {
  const body = METARS.find((l) => new RegExp(`^(METAR |SPECI )?${station} `).test(l))!;
  const [, day, hour, minute] = /(\d{2})(\d{2})(\d{2})Z/.exec(body)!;
  const report = rawReport({ kind: 'metar', source: 'awc', station, body, issuedAt: new Date(`2026-09-${day}T${hour}:${minute}:00Z`), upstream: null });
  return { station, source: 'own', distance: 0 as never, report, decoded: decodeMetar(body), ageMinutes: 0, ownAsleep: false };
}

interface Options {
  readonly what?: 'takeoff' | 'landing';
  readonly profile?: Partial<PilotProfile>;
  /** A TAF period instead of the observation, with the attention a crossed limit gets there. */
  readonly forecast?: { readonly conditions: Conditions; readonly raw: string; readonly basis: string; readonly violation: 'alert' | 'caution' };
}

function judge(station: string, o: Options = {}) {
  const obs = observation(station);
  const f = o.forecast;
  const ctx: CheckContext = {
    waypoint: station,
    at: obs.report.issuedAt!,
    basis: f?.basis ?? 'observed',
    basisKind: f ? (f.violation === 'alert' ? 'prevailing' : 'overlay') : 'observed',
    violation: f?.violation ?? 'alert',
    source: f ? { kind: 'taf', station, raw: f.raw, sha256: null } : { kind: 'metar', station, raw: obs.report.body, sha256: obs.report.sha256 },
    profile: { ...profile, ...o.profile },
    aircraft: null,
    airport: airports.get(station)!,
    airspace: null,
    cruiseAltitude: 4500 as never,
    night: false,
  };
  const found = checkRunway(ctx, f?.conditions ?? metarConditions(obs.decoded), { what: o.what ?? 'takeoff', handbook: spec, observation: obs });
  expect(found).toHaveLength(1);
  const finding = found[0]!;
  const ends = finding.values['runways'] as RunwayDistance[];
  return { finding, end: (id: string) => ends.find((r) => r.end === id)!, ends };
}

describe('the runway surface as recorded', () => {
  it('is paved when every word is a paving, whatever the spelling or the condition after it', () => {
    for (const s of ['ASP', 'ASPH-G', 'ASPHALT', 'asphalt', 'CON', 'CONC-F', 'concrete/grooved', 'CONC-GRVD', 'PEM', 'paved', 'ASPH-CONC-G', 'Asphalt/Concrete']) expect(surfaceKind(s)).toBe('paved');
  });

  it('is grass when every word is grass, or grass and a paving, the mix being read the longer way', () => {
    for (const s of ['TURF', 'Turf', 'TURF-G', 'GRS', 'GRASS / SOD', 'Grass', 'ASPH-TURF', 'Asphalt/Turf', 'CONC-TURF-G', 'TURF/ASP']) expect(surfaceKind(s)).toBe('grass');
  });

  it('is neither when any word is something the handbook has no figure for, or nothing is recorded', () => {
    for (const s of ['GVL', 'GRAVEL', 'TURF-GRVL', 'TURF/SNOW', 'WATER', 'DIRT', 'COM', 'GRE', 'UNK', 'OLD ASP', 'Tuef', 'Turf, soft during spring thaw', 'ASPH-L']) expect(surfaceKind(s)).toBeNull();
    expect(surfaceKind(null)).toBeNull();
  });
});

describe('reading each runway end', () => {
  it("reads the handbook at the next printed altitude and temperature up, from the field's elevation and its altimeter setting", () => {
    // CYKA, 1,133 ft, A2997: 1,083 ft pressure altitude at 11 °C, read at 2,000 ft and 20 °C.
    const { finding } = judge('CYKA');
    expect(finding.values).toMatchObject({ elevationFt: 1133, pressureAltitudeFt: 1083, tempC: 11, altimeterFrom: 'CYKA' });
    expect(finding.values['cell']).toEqual({ pressureAltitudeFt: 2000, columnC: 20, groundRollFt: 1075, totalFt: 1895 });
  });

  it('says a runway is too short when the handbook alone does not fit, and still finds the field fine on another', () => {
    const { finding, end } = judge('CYKA');
    expect(end('05')).toMatchObject({ availableFt: 1875, totalFt: 1895, neededFt: 2843, status: 'over', reasons: ['short'] });
    expect(end('09')).toMatchObject({ availableFt: 8000, status: 'fits' });
    expect(finding.attention).toBe('routine');
    expect(finding.values['best']).toBe('09');
    expect(finding.summary).toBe(
      'takeoff on 09: 2,843 ft needed with your 50% margin (1,895 ft by the handbook), 8,000 ft available; 05 and 23: needs 1,895 ft by the handbook, has 1,875 ft — at 1,083 ft pressure altitude and 11 °C (CYKA, observed 11:00Z)',
    );
  });

  it('adds your margin to the handbook, and with none compares the handbook as printed', () => {
    // CYDN 05009KT: runway 26 has 6.9 kt of tailwind, +35%, and 2,700 ft.
    const { end } = judge('CYDN');
    expect(end('26')).toMatchObject({ windPercent: 35, totalFt: 2329, neededFt: 3494, availableFt: 2700, status: 'over', reasons: ['margin'] });
    expect(end('26').alongKt).toBeCloseTo(-6.9, 1);
    const bare = judge('CYDN', { profile: { runwayMargin: 0 } });
    expect(bare.end('26')).toMatchObject({ totalFt: 2329, neededFt: 2329, status: 'fits' });
    expect(bare.finding.summary).toMatch(/^takeoff on 32: 1,725 ft needed by the handbook, 5,000 ft available/);
  });

  it('takes nothing off for a headwind', () => {
    const { end } = judge('CYDN');
    expect(end('08').alongKt).toBeGreaterThan(6);
    expect(end('08')).toMatchObject({ windPercent: 0, totalFt: 1725 });
  });

  it("adds the grass note's share of the printed ground roll: 15% of it taking off, 45% landing", () => {
    // CYLL 11/29 is 1,500 ft of grass: 15% of 1,180 ft is 177 ft.
    const takeoff = judge('CYLL');
    expect(takeoff.end('11')).toMatchObject({ kind: 'grass', grassFt: 177, totalFt: 2085 + 177, status: 'over', reasons: ['short'] });
    expect(takeoff.end('08')).toMatchObject({ kind: 'paved', grassFt: 0, status: 'fits' });
    // CYPA 16/34 is 2,500 ft of grass: 45% of 570 ft is 256.5, so 257.
    const landing = judge('CYPA', { what: 'landing' });
    expect(landing.end('34')).toMatchObject({ grassFt: 257, totalFt: 1335 + 257, neededFt: 2388, status: 'fits' });
    expect(landing.end('16')).toMatchObject({ windPercent: 7, totalFt: 1704, neededFt: 2556, status: 'over', reasons: ['margin'] });
  });

  it('takes a variable wind as a tailwind of its full speed on every end', () => {
    const { ends } = judge('CYQZ');
    expect(ends.map((r) => [r.end, r.alongKt, r.windPercent, r.crosswindKt])).toEqual([
      ['13', -2, 10, 2],
      ['31', -2, 10, 2],
    ]);
  });

  it('works a tailwind on the gust, and gives no figure past the 10 kt the handbook allows for', () => {
    // CYEN 09023G35KT: runway 26 has the whole 35 kt gust behind it.
    const { end, finding } = judge('CYEN');
    expect(end('26')).toMatchObject({ status: 'beyond', problem: "35 kt of tailwind is more than the 10 kt the handbook's takeoff table allows for", totalFt: null });
    expect(end('15')).toMatchObject({ status: 'over', reasons: ['margin', 'crosswind'] });
    expect(finding.summary).toContain("15: needs 3,128 ft with your 50% margin (2,085 ft by the handbook), has 3,000 ft, and 32 kt across, over your 15 kt limit");
    expect(finding.attention).toBe('routine');
  });

  it('measures the landing from past a displaced threshold, and the takeoff from the end', () => {
    // CYHU 06L/24R: 7,840 ft, the 06L threshold displaced 1,100 ft.
    const landing = judge('CYHU', { what: 'landing' });
    expect(landing.end('06L').availableFt).toBe(7840 - 1100);
    expect(landing.end('24R').availableFt).toBe(7840);
    expect(judge('CYHU').end('06L').availableFt).toBe(7840);
  });
});

describe('the field', () => {
  it('is an alert when no runway fits, saying why for each end', () => {
    const { finding } = judge('CYYN');
    expect(finding.attention).toBe('alert');
    expect(finding.summary).toBe(
      "no runway fits your takeoff: 04: needs 3,128 ft with your 50% margin (2,085 ft by the handbook), has 2,500 ft; 22: 23 kt of tailwind is more than the 10 kt the handbook's takeoff table allows for; 13: 4,250 ft is enough, but 23 kt across, over your 15 kt limit; 31: 10.2 kt of tailwind is more than the 10 kt the handbook's takeoff table allows for — at 2,810 ft pressure altitude and 15 °C (CYYN, observed 11:00Z)",
    );
  });

  it('is a caution when the same is forecast only in a TEMPO or PROB', () => {
    const taf = TAFS.find((l) => l.startsWith('TAF CYYN '))!;
    const resolved = resolveTaf(decodeTaf(taf), new Date('2026-09-07T11:40:00Z'), new Date('2026-09-07T17:00:00Z'));
    const tempo = resolved.overlays.find((o) => o.kind === 'TEMPO')!;
    const { finding } = judge('CYYN', { forecast: { conditions: tempo.conditions, raw: resolved.raw, basis: 'TEMPO 16:00Z–20:00Z', violation: 'caution' } });
    expect(finding.attention).toBe('caution');
    expect(finding.summary).toMatch(/^no runway fits your takeoff/);
  });

  it('is a note, not an alert, when the handbook has a figure for none of its runways', () => {
    // CYAT is 31 ft up, and A3030 puts it 349 ft below sea level by pressure.
    const { finding } = judge('CYAT');
    expect(finding.attention).toBe('note');
    expect(finding.summary).toBe(
      'no handbook takeoff figure for any runway here: 06 and 24: surface "GRVL", and the handbook gives figures for paved and dry grass runways only — at -349 ft pressure altitude and 8 °C (CYAT, observed 11:00Z)',
    );
  });

  it('with no wind, temperature or altimeter setting reported, reads still air at the hottest column and the elevation, and says so', () => {
    // CYMO: AUTO /////KT, everything missing.
    const { finding, end } = judge('CYMO');
    expect(finding.values).toMatchObject({ tempC: null, pressureAltitudeFt: 30, windKnown: false, altimeterFrom: null });
    expect(finding.values['cell']).toMatchObject({ pressureAltitudeFt: 1000, columnC: 40, totalFt: 1970 });
    expect(end('06')).toMatchObject({ alongKt: null, crosswindKt: null, status: 'fits' });
    expect(end('14')).toMatchObject({ status: 'unknown', problem: 'surface "COM", and the handbook gives figures for paved and dry grass runways only' });
    expect(finding.summary).toContain("— at 30 ft pressure altitude, the field's elevation as no altimeter setting was reported; no temperature reported by CYMO, so read at the table's hottest, 40 °C");
    expect(finding.summary).toContain('; no wind given, so read for still air and crosswind not judged');
  });
});

describe('a wet runway', () => {
  it('is a caution where it fits: the figures are for a dry runway', () => {
    const { finding } = judge('CYHE');
    expect(finding.attention).toBe('caution');
    expect(finding.values['wet']).toEqual(['light rain']);
    expect(finding.summary).toMatch(/; light rain observed, and the handbook's figures are for a dry runway$/);
    expect(finding.citations.some((c) => c.text === '-RA')).toBe(true);
  });

  it('is a step quieter in a TEMPO, and says forecast', () => {
    // CYLL at 17:00Z: FM071600 06012KT 3SM -RA, TEMPO 0716/0720 6SM -RA.
    const taf = TAFS.find((l) => l.startsWith('TAF CYLL '))!;
    const resolved = resolveTaf(decodeTaf(taf), new Date('2026-09-07T11:40:00Z'), new Date('2026-09-07T17:00:00Z'));
    const prevailing = judge('CYLL', { forecast: { conditions: resolved.prevailing!.conditions, raw: resolved.raw, basis: 'prevailing', violation: 'alert' } }).finding;
    expect(prevailing.attention).toBe('caution');
    expect(prevailing.summary).toMatch(/; light rain forecast, and the handbook's figures are for a dry runway$/);
    const tempo = resolved.overlays.find((o) => o.kind === 'TEMPO')!;
    expect(judge('CYLL', { forecast: { conditions: tempo.conditions, raw: resolved.raw, basis: 'TEMPO', violation: 'caution' } }).finding.attention).toBe('note');
  });

  it('changes nothing where there is no figure to doubt', () => {
    // CYKP: gravel, -RA.
    const { finding } = judge('CYKP');
    expect(finding.attention).toBe('note');
    expect(finding.values['wet']).toEqual([]);
    expect(finding.summary).not.toContain('dry runway');
  });
});

describe('what it cites', () => {
  it('the wind it read along each end, the temperature and setting, the handbook cell and note, the airport record and your profile', () => {
    const { finding } = judge('CYDN');
    expect(finding.citations.map((c) => [c.kind, c.text])).toEqual([
      ['metar', '05009KT'],
      ['metar', '15/15'],
      ['metar', 'A2995'],
      [
        'aircraft',
        'C172MPOH.pdf p.72 (5-12), Figure 5-4, Takeoff Distance (Sheet 1 of 2), 2,300 lb (Flaps Up, Full Throttle Prior to Brake Release, Paved, Level, Dry Runway, Zero Wind): 1,000 ft, 20 °C: 980 ft ground roll, 1,725 ft to clear 50 ft',
      ],
      ['aircraft', 'C172MPOH.pdf p.72 (5-12), note: "For operation with tailwinds up to 10 knots, increase distances by 10% for each 2 knots."'],
      ['airport', 'ourairports 2026-09-18'],
      ['profile', 'default v1'],
    ]);
    for (const c of finding.citations) if (c.span && c.raw) expect(c.raw.slice(c.span.start, c.span.end)).toBe(c.text);
    expect(finding.citations.filter((c) => c.kind === 'aircraft').every((c) => c.sha256 === spec.source.documentSha256)).toBe(true);
  });

  it('says which handbook figures the scan does not bear out', () => {
    // CYKA reads 2,000 ft and 20 °C, whose 1,895 the scan has as something else.
    const cell = judge('CYKA').finding.citations.find((c) => c.kind === 'aircraft')!;
    expect(cell.text).toMatch(/1,895 ft to clear 50 ft — the distance to clear 50 ft is read from the page image; the scan does not show it, so check it against your handbook$/);
  });
});
