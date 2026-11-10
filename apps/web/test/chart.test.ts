/**
 * The base map: OpenStreetMap's data from OpenFreeMap, the hills from the
 * terrain tiles on AWS, drawn in a sectional's colours by day and darker by
 * night, with the briefing's own layers printed on top.
 */
import { describe, expect, it } from 'vitest';
import { chartStyle, OPENFREEMAP, PALETTE, TERRAIN_TILES } from '../src/chartStyle.js';
import { routeLayers, SOURCES } from '../src/routeLayers.js';

const ids = (scheme: 'day' | 'night') => chartStyle(scheme).layers.map((l) => l.id);
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

describe('the base map', () => {
  it('reads OpenFreeMap and the terrain tiles, and nothing else', () => {
    const style = chartStyle('day');
    expect(style.sources).toEqual({
      omt: { type: 'vector', url: OPENFREEMAP },
      terrain: expect.objectContaining({ type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium' }),
    });
    expect(style.glyphs).toMatch(/^https:\/\/tiles\.openfreemap\.org\/fonts\//);
    for (const layer of style.layers) if ('source' in layer) expect(['omt', 'terrain']).toContain(layer.source);
  });

  it('names where the terrain comes from, as its sources ask', () => {
    const terrain = chartStyle('day').sources['terrain'] as { attribution?: string };
    expect(terrain.attribution).toContain('USGS, NOAA, ArcticDEM, Canada (OGL)');
    expect(terrain.attribution).toContain('https://github.com/tilezen/joerd/blob/master/docs/attribution.md');
  });

  it('shades the hills over the land and under the towns, water and labels', () => {
    for (const scheme of ['day', 'night'] as const) {
      const order = ids(scheme);
      expect(order.indexOf('hills')).toBeGreaterThan(order.indexOf('land'));
      expect(order.indexOf('hills')).toBeLessThan(order.indexOf('town'));
      expect(order.indexOf('hills')).toBeLessThan(order.indexOf('water'));
      expect(order.indexOf('place')).toBe(order.length - 1);
    }
  });

  it('prints the same chart darker at night', () => {
    expect(ids('night')).toEqual(ids('day'));
    for (const key of ['land', 'water', 'town'] as const) expect(luminance(PALETTE.night[key])).toBeLessThan(luminance(PALETTE.day[key]));
  });
});

describe('what the briefing prints on it', () => {
  it('reads only the sources the route map gives it', () => {
    for (const layer of routeLayers('day')) if ('source' in layer) expect(SOURCES).toContain(layer.source);
  });

  it('draws the route on top, in magenta, with the way to the alternate dashed', () => {
    const layers = routeLayers('day');
    const route = layers.find((l) => l.id === 'route')!;
    const alternate = layers.find((l) => l.id === 'alternate')!;
    expect(route.paint).toMatchObject({ 'line-color': PALETTE.day.route });
    expect(alternate.paint).toHaveProperty('line-dasharray');
    expect(layers.map((l) => l.id).slice(-4)).toEqual(['route-casing', 'route', 'route-label', 'alternate-label']);
    // Each distance once, from a point at the middle of its line, not once in every map tile the line crosses.
    expect(layers.filter((l) => l.id.endsWith('-label')).every((l) => 'source' in l && l.source === 'labels')).toBe(true);
  });
});
