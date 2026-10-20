/**
 * Whether a route goes through an area, tested on squares anyone can check
 * by eye, and then on the real polygons the weather service published for
 * live SIGMETs on 14 September 2026.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LatLon } from '../../src/domain/geo.js';
import { areaIsTestable, pointInArea, routeCrossesArea, routeDistanceToAreaNm, segmentsCross } from '../../src/domain/polygon.js';

/** A square degree over southern Ontario, near enough to home to picture. */
const SQUARE: LatLon[] = [
  { lat: 43, lon: -80 },
  { lat: 44, lon: -80 },
  { lat: 44, lon: -79 },
  { lat: 43, lon: -79 },
];

interface SigmetRecord {
  readonly hazard: string;
  readonly coords: { readonly lat: number; readonly lon: number }[];
}

const REAL: SigmetRecord[] = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'fetch', 'awc', 'sigmet-2026-09-14', 'isigmet.json'), 'utf8'),
) as SigmetRecord[];

describe('pointInArea', () => {
  it('knows inside from outside', () => {
    expect(pointInArea({ lat: 43.5, lon: -79.5 }, SQUARE)).toBe(true);
    expect(pointInArea({ lat: 45, lon: -79.5 }, SQUARE)).toBe(false);
    expect(pointInArea({ lat: 43.5, lon: -70 }, SQUARE)).toBe(false);
  });

  it('handles a concave area, where a bounding box would be wrong', () => {
    // A C shape: the notch is outside, though it is inside the box.
    const c: LatLon[] = [
      { lat: 43, lon: -80 },
      { lat: 44, lon: -80 },
      { lat: 44, lon: -79 },
      { lat: 43.7, lon: -79 },
      { lat: 43.7, lon: -79.8 },
      { lat: 43.3, lon: -79.8 },
      { lat: 43.3, lon: -79 },
      { lat: 43, lon: -79 },
    ];
    expect(pointInArea({ lat: 43.5, lon: -79.4 }, c)).toBe(false);
    expect(pointInArea({ lat: 43.5, lon: -79.9 }, c)).toBe(true);
  });
});

describe('routeCrossesArea', () => {
  it('catches a route that passes through without stopping in it', () => {
    // Both ends well outside, straight through the middle.
    const through = [
      { lat: 43.5, lon: -82 },
      { lat: 43.5, lon: -77 },
    ];
    expect(through.some((p) => pointInArea(p, SQUARE))).toBe(false);
    expect(routeCrossesArea(through, SQUARE)).toBe(true);
  });

  it('leaves a route that goes round it alone', () => {
    const around = [
      { lat: 42, lon: -82 },
      { lat: 42, lon: -77 },
    ];
    expect(routeCrossesArea(around, SQUARE)).toBe(false);
  });

  it('counts a route that merely touches an edge, which is the cautious reading', () => {
    const touching = [
      { lat: 43, lon: -82 },
      { lat: 43, lon: -77 },
    ];
    expect(routeCrossesArea(touching, SQUARE)).toBe(true);
  });

  it('agrees with itself on the real areas the service published', () => {
    const areas = REAL.filter((r) => areaIsTestable(r.coords) === null);
    expect(areas.length).toBeGreaterThan(50);
    for (const area of areas.slice(0, 40)) {
      // A route between two of the area's own corners is inside it by
      // construction, whatever shape the service drew.
      const corners = [area.coords[0]!, area.coords[1]!];
      expect(routeCrossesArea(corners, area.coords)).toBe(true);
      expect(routeDistanceToAreaNm(corners, area.coords)).toBe(0);
      // And a route in the opposite hemisphere is not.
      const far = [
        { lat: -area.coords[0]!.lat, lon: area.coords[0]!.lon > 0 ? area.coords[0]!.lon - 120 : area.coords[0]!.lon + 120 },
        { lat: -area.coords[1]!.lat, lon: area.coords[1]!.lon > 0 ? area.coords[1]!.lon - 120 : area.coords[1]!.lon + 120 },
      ];
      expect(routeCrossesArea(far, area.coords)).toBe(false);
    }
  });
});

describe('areaIsTestable', () => {
  it('refuses what flat geometry cannot answer', () => {
    expect(areaIsTestable([{ lat: 43, lon: -80 }])).not.toBeNull();
    expect(
      areaIsTestable([
        { lat: 60, lon: 179 },
        { lat: 61, lon: -179 },
        { lat: 62, lon: 178 },
      ])!.reason,
    ).toContain('antimeridian');
    expect(
      areaIsTestable([
        { lat: 88, lon: 10 },
        { lat: 89, lon: 20 },
        { lat: 87, lon: 30 },
      ])!.reason,
    ).toContain('pole');
    expect(areaIsTestable(SQUARE)).toBeNull();
  });

  it('accepts nearly all of what the service actually publishes', () => {
    const refused = REAL.filter((r) => areaIsTestable(r.coords) !== null);
    // A handful of polar and Pacific areas; the rest are ordinary.
    expect(refused.length / REAL.length).toBeLessThan(0.15);
  });
});

describe('routeDistanceToAreaNm', () => {
  it('measures how far outside the route stays', () => {
    // A degree of latitude south of the square's bottom edge: 60 nm.
    const below = [
      { lat: 42, lon: -79.5 },
      { lat: 42, lon: -79.4 },
    ];
    expect(routeDistanceToAreaNm(below, SQUARE)).toBeCloseTo(60, 0);
    // Longitude is narrower this far north, so a degree east is less than 60 nm.
    const east = [
      { lat: 43.5, lon: -78 },
      { lat: 43.5, lon: -77.9 },
    ];
    expect(routeDistanceToAreaNm(east, SQUARE)).toBeLessThan(50);
    expect(routeDistanceToAreaNm(east, SQUARE)).toBeGreaterThan(40);
  });
});

describe('segmentsCross', () => {
  it('is true for an X and false for parallel lines', () => {
    const a = { lat: 0, lon: 0 };
    const b = { lat: 1, lon: 1 };
    const c = { lat: 0, lon: 1 };
    const d = { lat: 1, lon: 0 };
    expect(segmentsCross(a, b, c, d)).toBe(true);
    expect(segmentsCross(a, c, b, d)).toBe(false);
  });
});
