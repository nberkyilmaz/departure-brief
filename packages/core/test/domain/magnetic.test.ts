/**
 * The magnetic model against NOAA's own answers.
 *
 * WMM2025_TestValues.txt ships with the coefficients: a hundred points
 * across the globe, the five years and a range of heights, with the field
 * the reference software computes for each. Matching those is what it
 * means for an implementation of the WMM to be right.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decimalYear, magneticField, magneticVariation } from '../../src/domain/magnetic.js';

const VALUES = readFileSync(join(__dirname, '..', 'fixtures', 'wmm', 'WMM2025_TestValues.txt'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => l.trim().split(/\s+/).map(Number))
  .map(([year, heightKm, lat, lon, declination, , , x, y, z]) => ({ year: year!, heightKm: heightKm!, lat: lat!, lon: lon!, declination: declination!, x: x!, y: y!, z: z! }));

describe('magneticField', () => {
  it('has all of NOAA’s test values to check against', () => {
    expect(VALUES).toHaveLength(100);
  });

  it.each(VALUES)('matches NOAA at $lat, $lon, $heightKm km, $year', (v) => {
    const f = magneticField({ lat: v.lat, lon: v.lon }, v.heightKm, v.year)!;
    // The file prints declination to two places and the components to six.
    expect(f.declination).toBeCloseTo(v.declination, 2);
    expect(f.x).toBeCloseTo(v.x, 2);
    expect(f.y).toBeCloseTo(v.y, 2);
    expect(f.z).toBeCloseTo(v.z, 2);
  });

  it('has no answer outside the years the model is for', () => {
    expect(magneticField({ lat: 43, lon: -79 }, 0, 2024.99)).toBeNull();
    expect(magneticField({ lat: 43, lon: -79 }, 0, 2030)).toBeNull();
  });
});

describe('magneticVariation', () => {
  it('gives the variation a chart prints, west negative', () => {
    const at = new Date('2026-10-31T12:00:00Z');
    // Southern Ontario is about ten west, Florida about seven, Vancouver about fifteen east.
    expect(magneticVariation({ lat: 43.19, lon: -79.17 }, at)).toBeGreaterThan(-11);
    expect(magneticVariation({ lat: 43.19, lon: -79.17 }, at)).toBeLessThan(-9);
    expect(magneticVariation({ lat: 25.79, lon: -80.29 }, at)).toBeGreaterThan(-8);
    expect(magneticVariation({ lat: 25.79, lon: -80.29 }, at)).toBeLessThan(-5);
    expect(magneticVariation({ lat: 49.19, lon: -123.18 }, at)).toBeGreaterThan(14);
    expect(magneticVariation({ lat: 49.19, lon: -123.18 }, at)).toBeLessThan(17);
  });

  it('counts the year from the first instant of January', () => {
    expect(decimalYear(new Date('2026-01-01T00:00:00Z'))).toBe(2026);
    expect(decimalYear(new Date('2026-07-02T12:00:00Z'))).toBeCloseTo(2026.5, 2);
    expect(magneticVariation({ lat: 43, lon: -79 }, new Date('2031-01-01T00:00:00Z'))).toBeNull();
  });
});
