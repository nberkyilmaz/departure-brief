/**
 * One test per row of each regulatory table. The expectations are the
 * regulation text, not the implementation.
 */
import { describe, expect, it } from 'vitest';
import { jurisdictionOf, vfrMinima, type VfrMinimaQuery } from '../../src/rules/vfrMinima.js';

const q = (o: Partial<VfrMinimaQuery>): VfrMinimaQuery => ({
  jurisdiction: 'CA',
  airspace: 'uncontrolled',
  altitudeMsl: 3500 as never,
  altitudeAgl: 3000 as never,
  night: false,
  ...o,
});

describe('CARs 602.114 / 602.115', () => {
  it('control zone: 3 SM, 500 ft / 1 SM from cloud, 1,000 ft ceiling for VFR', () => {
    const m = vfrMinima(q({ airspace: 'control-zone' }));
    expect(m.visibility).toBe(3);
    expect(m.cloudClearance).toEqual({ below: 500, above: 500, horizontal: { statuteMiles: 1 } });
    expect(m.ceiling).toBe(1000);
    expect(m.rule).toContain('602.114');
  });
  it('controlled airspace: 3 SM, 500 ft / 1 SM from cloud, no ceiling rule', () => {
    const m = vfrMinima(q({ airspace: 'controlled' }));
    expect(m.visibility).toBe(3);
    expect(m.cloudClearance).toEqual({ below: 500, above: 500, horizontal: { statuteMiles: 1 } });
    expect(m.ceiling).toBeNull();
  });
  it('US letter classes map onto the controlled row when used in Canada', () => {
    for (const a of ['B', 'C', 'D', 'E'] as const) expect(vfrMinima(q({ airspace: a })).rule).toContain('controlled airspace');
    expect(vfrMinima(q({ airspace: 'G' })).rule).toContain('602.115');
  });
  it('uncontrolled, ≥1,000 ft AGL, day: 1 SM, 500 ft / 2,000 ft from cloud', () => {
    const m = vfrMinima(q({ altitudeAgl: 1000 as never }));
    expect(m.visibility).toBe(1);
    expect(m.cloudClearance).toEqual({ below: 500, above: 500, horizontal: { feet: 2000 } });
  });
  it('uncontrolled, ≥1,000 ft AGL, night: 3 SM, 500 ft / 2,000 ft from cloud', () => {
    const m = vfrMinima(q({ altitudeAgl: 1000 as never, night: true }));
    expect(m.visibility).toBe(3);
    expect(m.cloudClearance).toEqual({ below: 500, above: 500, horizontal: { feet: 2000 } });
  });
  it('uncontrolled, <1,000 ft AGL, day: 2 SM, clear of cloud', () => {
    const m = vfrMinima(q({ altitudeAgl: 999 as never }));
    expect(m.visibility).toBe(2);
    expect(m.cloudClearance).toBeNull();
  });
  it('uncontrolled, <1,000 ft AGL, night: 3 SM, clear of cloud', () => {
    const m = vfrMinima(q({ altitudeAgl: 999 as never, night: true }));
    expect(m.visibility).toBe(3);
    expect(m.cloudClearance).toBeNull();
  });
});

describe('FAR 91.155', () => {
  const us = (o: Partial<VfrMinimaQuery>) => vfrMinima(q({ jurisdiction: 'US', ...o }));
  const std = { below: 500, above: 1000, horizontal: { feet: 2000 } };
  const high = { below: 1000, above: 1000, horizontal: { statuteMiles: 1 } };
  it('Class B: 3 SM, clear of clouds', () => {
    expect(us({ airspace: 'B' })).toMatchObject({ visibility: 3, cloudClearance: null });
  });
  it('Class C: 3 SM, 500 / 1,000 / 2,000', () => {
    expect(us({ airspace: 'C' })).toMatchObject({ visibility: 3, cloudClearance: std });
  });
  it('Class D: 3 SM, 500 / 1,000 / 2,000', () => {
    expect(us({ airspace: 'D' })).toMatchObject({ visibility: 3, cloudClearance: std });
  });
  it('Class E below 10,000 ft MSL: 3 SM, 500 / 1,000 / 2,000', () => {
    expect(us({ airspace: 'E', altitudeMsl: 9999 as never })).toMatchObject({ visibility: 3, cloudClearance: std });
  });
  it('Class E at or above 10,000 ft MSL: 5 SM, 1,000 / 1,000 / 1 SM', () => {
    expect(us({ airspace: 'E', altitudeMsl: 10000 as never })).toMatchObject({ visibility: 5, cloudClearance: high });
  });
  it('Class G ≤1,200 ft AGL, day: 1 SM, clear of clouds', () => {
    expect(us({ airspace: 'G', altitudeAgl: 1200 as never })).toMatchObject({ visibility: 1, cloudClearance: null });
  });
  it('Class G ≤1,200 ft AGL, night: 3 SM, 500 / 1,000 / 2,000', () => {
    expect(us({ airspace: 'G', altitudeAgl: 1200 as never, night: true })).toMatchObject({ visibility: 3, cloudClearance: std });
  });
  it('Class G >1,200 ft AGL, <10,000 ft MSL, day: 1 SM, 500 / 1,000 / 2,000', () => {
    expect(us({ airspace: 'G', altitudeAgl: 1201 as never, altitudeMsl: 9999 as never })).toMatchObject({ visibility: 1, cloudClearance: std });
  });
  it('Class G >1,200 ft AGL, <10,000 ft MSL, night: 3 SM, 500 / 1,000 / 2,000', () => {
    expect(us({ airspace: 'G', altitudeAgl: 1201 as never, altitudeMsl: 9999 as never, night: true })).toMatchObject({ visibility: 3, cloudClearance: std });
  });
  it('Class G >1,200 ft AGL, ≥10,000 ft MSL: 5 SM, 1,000 / 1,000 / 1 SM', () => {
    expect(us({ airspace: 'G', altitudeAgl: 1201 as never, altitudeMsl: 10000 as never })).toMatchObject({ visibility: 5, cloudClearance: high });
    expect(us({ airspace: 'G', altitudeAgl: 1201 as never, altitudeMsl: 10000 as never, night: true })).toMatchObject({ visibility: 5, cloudClearance: high });
  });
  it('Canadian terms map onto the nearest US row', () => {
    expect(us({ airspace: 'control-zone' }).rule).toContain('Class D');
    expect(us({ airspace: 'uncontrolled', altitudeAgl: 1200 as never }).rule).toContain('Class G');
  });
});

describe('jurisdictionOf', () => {
  it('knows Canada and the US and nothing else', () => {
    expect(jurisdictionOf('CA')).toBe('CA');
    expect(jurisdictionOf('US')).toBe('US');
    expect(jurisdictionOf('MX')).toBeNull();
    expect(jurisdictionOf(null)).toBeNull();
  });
});
