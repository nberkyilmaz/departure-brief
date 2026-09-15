/**
 * Each check against synthetic conditions decoded from real report syntax,
 * with the owner's profile. Attention is whatever the context says a
 * violation is worth — the checks do not decide that.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeTaf } from '../../src/decode/taf/index.js';
import { readOurAirportsDirectory } from '../../src/fetch/ourairports.js';
import { parseAircraftLimits, parsePilotProfile } from '../../src/domain/profile.js';
import { checkCeiling, checkCrosswind, checkNight, checkRegulatory, checkVisibility, type CheckContext } from '../../src/rules/checks.js';
import { FIXTURES } from '../helpers/http.js';

const cysn = readOurAirportsDirectory(join(FIXTURES, 'ourairports', '2026-09-07'), { snapshot: '2026-09-07' }).find((a) => a.icaoId === 'CYSN')!;
const profile = parsePilotProfile({ version: 1, name: 'default', ceilingAglFt: 2500, visibilitySm: 5, crosswindKt: 15, crosswindIncludesGust: true });
const c172 = parseAircraftLimits({ type: 'C172', demonstratedCrosswindKt: 15 });

function ctx(over: Partial<CheckContext> = {}): CheckContext {
  return {
    waypoint: 'CYSN',
    at: new Date('2026-09-07T15:00:00Z'),
    basis: 'prevailing',
    basisKind: 'prevailing',
    violation: 'alert',
    source: { kind: 'taf', station: 'CYSN', raw: '', sha256: null },
    profile,
    aircraft: c172,
    airport: cysn,
    airspace: 'control-zone',
    cruiseAltitude: 3500 as never,
    night: false,
    ...over,
  };
}

/** Conditions from a TAF base period, with the context pointing at the same raw text. */
function cond(groups: string, over: Partial<CheckContext> = {}) {
  const raw = `TAF CYSN 071240Z 0713/0801 ${groups}`;
  const taf = decodeTaf(raw);
  return { c: taf.periods[0]!.conditions, ctx: ctx({ ...over, source: { kind: 'taf', station: 'CYSN', raw, sha256: null } }) };
}

describe('checkCeiling', () => {
  it('passes with citation when no ceiling', () => {
    const { c, ctx: x } = cond('VRB03KT P6SM FEW050');
    const [f] = checkCeiling(x, c);
    expect(f!.attention).toBe('routine');
    expect(f!.summary).toContain('no ceiling (FEW050)');
    expect(f!.citations[0]!.text).toBe('FEW050');
  });
  it('fails on a BKN below the minimum, citing the layer', () => {
    const { c, ctx: x } = cond('VRB03KT P6SM SCT015 BKN020 OVC040');
    const [f] = checkCeiling(x, c);
    expect(f!.attention).toBe('alert');
    expect(f!.values).toEqual({ ceiling: 2000, minimum: 2500 });
    expect(f!.citations[0]!.text).toBe('BKN020');
  });
  it('takes the context severity for overlays', () => {
    const { c, ctx: x } = cond('VRB03KT P6SM OVC010', { violation: 'caution', basis: 'TEMPO 15:00Z–17:00Z' });
    expect(checkCeiling(x, c)[0]!.attention).toBe('caution');
  });
  it('vertical visibility is a ceiling; CAVOK is unlimited; no sky at all is an advisory', () => {
    const vv = cond('00000KT 1/4SM FG VV002');
    expect(checkCeiling(vv.ctx, vv.c)[0]!.attention).toBe('alert');
    const cav = cond('24010KT CAVOK');
    expect(checkCeiling(cav.ctx, cav.c)[0]!.attention).toBe('routine');
    const none = cond('24010KT P6SM');
    expect(checkCeiling(none.ctx, none.c)[0]!.attention).toBe('note');
  });
});

describe('checkVisibility', () => {
  it.each([
    ['P6SM', 'routine'],
    ['5SM', 'routine'],
    ['4SM', 'alert'],
    ['M1/4SM', 'alert'],
    ['9999', 'routine'],
    ['8000', 'alert'],
    ['CAVOK', 'routine'],
  ])('%s → %s against a 5 SM minimum', (vis, sev) => {
    const { c, ctx: x } = cond(`24010KT ${vis} SKC`);
    expect(checkVisibility(x, c)[0]!.attention).toBe(sev);
  });
  it('is an advisory when no visibility is given', () => {
    const { c, ctx: x } = cond('24010KT SKC');
    expect(checkVisibility(x, c)[0]!.attention).toBe('note');
  });
});

describe('checkCrosswind', () => {
  it('passes a light wind on the best runway with all three citations', () => {
    const { c, ctx: x } = cond('24010KT P6SM SKC');
    const [f] = checkCrosswind(x, c);
    expect(f!.attention).toBe('routine');
    expect(f!.values['bestRunway']).toBe('24');
    expect(f!.citations.map((k) => k.kind)).toEqual(['taf', 'airport', 'profile']);
    expect(f!.citations[0]!.text).toBe('24010KT');
  });
  it('fails on the gust when the profile includes gusts, and cites the demonstrated figure too', () => {
    // 330° at 15 gusting 28 on CYSN: best is runway 01 (358°T), 28° off → gust crosswind ≈ 13; sustained ≈ 7.
    // Use a worse angle: 290°: best of 01 (68° off → 26 kt) and 24 (57° off → 23.5 kt) and 29 (14° off → 6.8 kt).
    const { c, ctx: x } = cond('29015G28KT P6SM SKC');
    const fs = checkCrosswind(x, c);
    expect(fs.map((f) => [f.rule, f.attention])).toEqual([
      ['crosswind.personal', 'routine'],
      ['crosswind.demonstrated', 'routine'],
    ]);
    const { c: c2, ctx: x2 } = cond('34015G28KT P6SM SKC');
    // Best is 01 (24° off): gust crosswind 28·sin24° ≈ 11.4 — fine. Make it a true crosswind: 070° → best 06 (17° off) gust 8.2. Try 320°: 01 is 38° off → 17.2 → over.
    const { c: c3, ctx: x3 } = cond('32015G28KT P6SM SKC');
    expect(checkCrosswind(x2, c2)[0]!.attention).toBe('routine');
    const over = checkCrosswind(x3, c3);
    expect(over[0]!.attention).toBe('alert');
    expect(over[0]!.summary).toContain('exceeds personal limit 15 kt');
    expect(over[1]!.rule).toBe('crosswind.demonstrated');
    expect(over[1]!.attention).toBe('alert');
  });
  it('ignores the gust when the profile says so', () => {
    const p = parsePilotProfile({ ceilingAglFt: 2500, visibilitySm: 5, crosswindKt: 15, crosswindIncludesGust: false });
    const { c, ctx: x } = cond('32015G28KT P6SM SKC', { profile: p });
    expect(checkCrosswind(x, c)[0]!.attention).toBe('routine');
  });
  it('treats VRB as the full speed and says so', () => {
    const { c, ctx: x } = cond('VRB18KT P6SM SKC');
    const [f] = checkCrosswind(x, c);
    expect(f!.attention).toBe('alert');
    expect(f!.summary).toContain('variable');
  });
  it('is an advisory without an airport, a wind, or a direction', () => {
    const { c, ctx: x } = cond('P6SM SKC');
    expect(checkCrosswind(x, c)[0]!.attention).toBe('note');
    const { c: c2, ctx: x2 } = cond('/////KT P6SM SKC');
    expect(checkCrosswind(x2, c2)[0]!.attention).toBe('note');
    const { c: c3, ctx: x3 } = cond('24010KT P6SM SKC', { airport: null });
    expect(checkCrosswind(x3, c3)).toEqual([]);
  });
  it('checks gust spread when the profile limits it', () => {
    const p = parsePilotProfile({ ceilingAglFt: 2500, visibilitySm: 5, crosswindKt: 15, maxGustSpreadKt: 10 });
    const { c, ctx: x } = cond('24010G25KT P6SM SKC', { profile: p });
    const f = checkCrosswind(x, c).find((f) => f.rule === 'wind.gustSpread')!;
    expect(f.attention).toBe('alert');
    expect(f.values).toEqual({ spread: 15, limit: 10 });
  });
});

describe('checkRegulatory', () => {
  it('evaluates CARs control-zone minima: visibility, 1,000 ft ceiling, and cloud clearance at cruise', () => {
    const { c, ctx: x } = cond('24010KT 2SM BR BKN008 OVC030');
    const fs = checkRegulatory(x, c);
    expect(fs.map((f) => [f.rule, f.attention])).toEqual([
      ['vfr.visibility', 'alert'],
      ['vfr.ceiling', 'alert'],
      ['vfr.cloudClearance', 'alert'],
      ['vfr.cloudClearance', 'alert'],
    ]);
    expect(fs[0]!.summary).toContain('CARs 602.114 (control zone)');
    // BKN008 at CYSN (321 ft): base 1,121 ft MSL is 2,379 ft below a 3,500 ft cruise — the aircraft would be inside it.
    expect(fs[2]!.values['clearance']).toBe(1121 - 3500);
  });
  it('passes clear conditions', () => {
    const { c, ctx: x } = cond('24010KT P6SM FEW050 BKN100');
    const fs = checkRegulatory(x, c);
    expect(fs.every((f) => f.attention === 'routine')).toBe(true);
    // BKN100: base 10,321 ft MSL, 6,821 ft above cruise.
    expect(fs.find((f) => f.rule === 'vfr.cloudClearance')!.values['clearance']).toBe(6821);
  });
  it('says so when airspace class is unknown or the country has no table', () => {
    const { c, ctx: x } = cond('24010KT P6SM SKC', { airspace: null });
    expect(checkRegulatory(x, c)[0]).toMatchObject({ rule: 'vfr.minima', attention: 'note' });
    const mx = cond('24010KT P6SM SKC', { airport: { ...cysn, country: 'MX' } });
    expect(checkRegulatory(mx.ctx, mx.c)[0]!.summary).toContain('no VFR minima table');
  });
  it('picks night rows for uncontrolled airspace at night', () => {
    const { c, ctx: x } = cond('24010KT 2SM HZ SKC', { airspace: 'uncontrolled', night: true });
    const f = checkRegulatory(x, c)[0]!;
    expect(f.summary).toContain('night');
    expect(f.attention).toBe('alert');
    const day = cond('24010KT 2SM HZ SKC', { airspace: 'uncontrolled', night: false });
    expect(checkRegulatory(day.ctx, day.c)[0]!.attention).toBe('routine');
  });
});

describe('checkNight', () => {
  it('is silent by day, advisory at night, a violation when the profile forbids night', () => {
    expect(checkNight(ctx({ night: false }))).toEqual([]);
    expect(checkNight(ctx({ night: true }))[0]!.attention).toBe('note');
    const p = parsePilotProfile({ ceilingAglFt: 2500, visibilitySm: 5, crosswindKt: 15, nightAllowed: false });
    expect(checkNight(ctx({ night: true, profile: p }))[0]!.attention).toBe('alert');
  });
});
