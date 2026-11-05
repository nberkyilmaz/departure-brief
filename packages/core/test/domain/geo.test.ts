/**
 * Where a station lies against a track: how far along, how far off, and
 * which side. Ottawa to Toronto is the leg, because the answers can be
 * checked against a chart.
 */
import { describe, expect, it } from 'vitest';
import { distanceNm, pointAlong, trackPosition } from '../../src/domain/geo.js';

const CYOW = { lat: 45.3225, lon: -75.6692 };
const CYYZ = { lat: 43.6772, lon: -79.6306 };
const CYTR = { lat: 44.1189, lon: -77.5281 };

describe('pointAlong', () => {
  it('walks the great circle: the start, the end, and the distance between', () => {
    const total = distanceNm(CYOW, CYYZ);
    const start = pointAlong(CYOW, CYYZ, 0);
    const end = pointAlong(CYOW, CYYZ, total);
    expect(distanceNm(start, CYOW)).toBeLessThan(0.01);
    expect(distanceNm(end, CYYZ)).toBeLessThan(0.01);
    const half = pointAlong(CYOW, CYYZ, total / 2);
    expect(distanceNm(CYOW, half)).toBeCloseTo(total / 2, 6);
    expect(distanceNm(half, CYYZ)).toBeCloseTo(total / 2, 6);
  });
});

describe('trackPosition', () => {
  it('puts a point on the track on the track, as far along as it is', () => {
    const p = pointAlong(CYOW, CYYZ, 80);
    const { alongNm, offsetNm } = trackPosition(CYOW, CYYZ, p);
    expect(alongNm).toBeCloseTo(80, 6);
    expect(Math.abs(offsetNm)).toBeLessThan(1e-6);
  });

  it('says which side: Trenton is to the left of a flight from Ottawa to Toronto, and to the right on the way back', () => {
    const out = trackPosition(CYOW, CYYZ, CYTR);
    const back = trackPosition(CYYZ, CYOW, CYTR);
    expect(out.offsetNm).toBeLessThan(-20);
    expect(out.offsetNm).toBeGreaterThan(-30);
    expect(back.offsetNm).toBeCloseTo(-out.offsetNm, 6);
    // Abeam about half way, either way round.
    expect(out.alongNm + back.alongNm).toBeCloseTo(distanceNm(CYOW, CYYZ), 0);
  });

  it('gives a point behind the start a negative distance along', () => {
    const behind = trackPosition(CYYZ, CYOW, { lat: 43.4, lon: -80.4 });
    expect(behind.alongNm).toBeLessThan(0);
  });

  it('answers the start itself without dividing by nothing', () => {
    expect(trackPosition(CYOW, CYYZ, CYOW)).toEqual({ alongNm: 0, offsetNm: 0 });
  });
});
