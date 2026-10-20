import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeMetar } from '../../src/decode/metar/index.js';
import { readOurAirportsDirectory } from '../../src/fetch/ourairports.js';
import { analyseCrosswind, components } from '../../src/rules/crosswind.js';
import { FIXTURES } from '../helpers/http.js';

const cysn = readOurAirportsDirectory(join(FIXTURES, 'ourairports', '2026-09-07'), { snapshot: '2026-09-07' }).find((a) => a.icaoId === 'CYSN')!;
const wind = (raw: string) => decodeMetar(`CYSN 071300Z ${raw} 15SM SKC 19/15 A3023`).wind!.value;

describe('components', () => {
  it('a wind 30° off the runway gives half its speed as crosswind', () => {
    const c = components(30 as never, 20 as never, 0 as never);
    expect(c.crosswind).toBeCloseTo(10, 5);
    expect(c.headwind).toBeCloseTo(17.32, 2);
  });
  it('a direct crosswind is the whole speed; a tailwind is negative headwind', () => {
    expect(components(90 as never, 12 as never, 0 as never).crosswind).toBeCloseTo(12, 5);
    expect(components(180 as never, 12 as never, 0 as never).headwind).toBeCloseTo(-12, 5);
  });
  it('wraps around north', () => {
    expect(components(350 as never, 10 as never, 10 as never).crosswind).toBeCloseTo(10 * Math.sin((20 * Math.PI) / 180), 5);
  });
});

describe('analyseCrosswind', () => {
  it('ranks CYSN runway ends for a 240° wind: 24 is nearly straight in', () => {
    const a = analyseCrosswind(wind('24015KT'), cysn)!;
    expect(a.speed).toBe(15);
    expect(a.gust).toBeNull();
    expect(a.runways[0]!.end).toBe('24');
    expect(a.runways[0]!.crosswind).toBeCloseTo(15 * Math.sin((7.3 * Math.PI) / 180), 2);
    expect(a.runways[0]!.headwind).toBeGreaterThan(14);
    // The reciprocal has the same crosswind, so it ranks right behind — but with a tailwind.
    expect(a.runways.find((r) => r.end === '06')!.headwind).toBeLessThan(-14);
    expect(a.runways.map((r) => r.end)).toHaveLength(6);
    expect(a.unknownHeading).toEqual([]);
  });

  it('uses the gust for the gust components and sorts by them', () => {
    const a = analyseCrosswind(wind('33015G28KT'), cysn)!;
    const best = a.runways[0]!;
    expect(a.gust).toBe(28);
    expect(best.crosswindGust).toBeGreaterThan(best.crosswind);
    expect(best.crosswindGust / best.crosswind).toBeCloseTo(28 / 15, 5);
  });

  it('VRB is the full speed on every runway', () => {
    const a = analyseCrosswind(wind('VRB08KT'), cysn)!;
    expect(a.variable).toBe(true);
    expect(new Set(a.runways.map((r) => r.crosswind))).toEqual(new Set([8]));
    expect(a.runways[0]!.headwind).toBe(0);
  });

  it('calm is zero everywhere and flagged', () => {
    const a = analyseCrosswind(wind('00000KT'), cysn)!;
    expect(a.calm).toBe(true);
    expect(a.runways.every((r) => r.crosswind === 0)).toBe(true);
  });

  it('converts MPS and returns null for a missing direction or speed', () => {
    expect(analyseCrosswind(wind('24010MPS'), cysn)!.speed).toBeCloseTo(19.4, 1);
    expect(analyseCrosswind(wind('/////KT'), cysn)).toBeNull();
    expect(analyseCrosswind(wind('///12KT'), cysn)).toBeNull();
  });

  it('skips runway ends without a true heading and lists them', () => {
    const noHeadings = { ...cysn, runways: cysn.runways.map((r) => ({ ...r, ends: r.ends.map((e) => ({ ...e, trueHeading: null })) })) };
    const a = analyseCrosswind(wind('24015KT'), noHeadings)!;
    expect(a.runways).toEqual([]);
    expect(a.unknownHeading).toHaveLength(6);
  });
});
