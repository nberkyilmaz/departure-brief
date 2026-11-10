/**
 * The base map, drawn the way a VFR sectional is: paper land, blue water
 * with a darker shore, towns in yellow, roads as thin dark lines, borders
 * dashed, and the hills shaded from below. It is OpenStreetMap's data in
 * our own colours, not a chart: nothing on it is aeronautical except what
 * the briefing draws on top.
 *
 * At night the same chart is printed dark, so a briefing read in a dark
 * cockpit does not light it up.
 *
 * Plain data, so it can be read and tested without a map library.
 */
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';

export type Scheme = 'day' | 'night';

export interface ChartPalette {
  readonly land: string;
  readonly wood: string;
  readonly town: string;
  readonly water: string;
  readonly shore: string;
  readonly river: string;
  readonly runway: string;
  readonly roadMinor: string;
  readonly roadMajor: string;
  readonly rail: string;
  readonly province: string;
  readonly country: string;
  readonly waterText: string;
  readonly placeText: string;
  readonly hillShadow: string;
  readonly hillHighlight: string;
  /** What the briefing draws on it. */
  readonly route: string;
  readonly routeCasing: string;
  readonly chartBlue: string;
  readonly airport: string;
  readonly sigmet: string;
  readonly airmet: string;
  readonly airBlue: string;
  readonly airMagenta: string;
}

export const PALETTE: Readonly<Record<Scheme, ChartPalette>> = {
  day: {
    land: '#f3eedf',
    wood: '#e2e7cf',
    town: '#f1d77e',
    water: '#bad3e8',
    shore: '#6f99c1',
    river: '#7fa6cc',
    runway: '#55606e',
    roadMinor: '#a29a8c',
    roadMajor: '#857d70',
    rail: '#6b6b6b',
    province: '#a596ad',
    country: '#7e6488',
    waterText: '#4b78a6',
    placeText: '#3a4552',
    hillShadow: '#6f6250',
    hillHighlight: '#fffdf6',
    route: '#9c2a74',
    routeCasing: '#fffdf8',
    chartBlue: '#1d4f91',
    airport: '#6f7a88',
    sigmet: '#b3261e',
    airmet: '#a35c00',
    airBlue: '#1d63c7',
    airMagenta: '#a3239b',
  },
  night: {
    land: '#171c22',
    wood: '#1b241f',
    town: '#3b3420',
    water: '#10233a',
    shore: '#2f5a86',
    river: '#2f5a86',
    runway: '#7a8594',
    roadMinor: '#3a3f46',
    roadMajor: '#545a63',
    rail: '#454a52',
    province: '#5e5468',
    country: '#8b7397',
    waterText: '#7aa3cf',
    placeText: '#b8c1cb',
    hillShadow: '#000000',
    hillHighlight: '#39414b',
    route: '#e07ab8',
    routeCasing: '#171c22',
    chartBlue: '#7fb0ea',
    airport: '#8a95a3',
    sigmet: '#f0736a',
    airmet: '#e0a145',
    airBlue: '#4b95de',
    airMagenta: '#d9629f',
  },
};

/** OpenFreeMap: OpenStreetMap's data as vector tiles, with fonts, and no key. */
export const OPENFREEMAP = 'https://tiles.openfreemap.org/planet';
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
/** Elevation as Terrarium-encoded PNGs, from the terrain tiles kept on AWS's open data registry. No key. */
export const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
/**
 * Their sources ask to be named: here the ones under Canada and the United
 * States and the global models between, short enough to sit on a phone's
 * map, with the full list a tap away.
 */
const TERRAIN_CREDIT = 'Terrain <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">USGS, NOAA, ArcticDEM, Canada (OGL)</a>';

export const FONT = { regular: ['Noto Sans Regular'], bold: ['Noto Sans Bold'], italic: ['Noto Sans Italic'] } as const;

const name = ['coalesce', ['get', 'name:en'], ['get', 'name']];
const byZoom = (...stops: number[]) => ['interpolate', ['linear'], ['zoom'], ...stops];

export function chartLayers(scheme: Scheme): LayerSpecification[] {
  const p = PALETTE[scheme];
  const layers: unknown[] = [
    { id: 'land', type: 'background', paint: { 'background-color': p.land } },
    { id: 'wood', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['match', ['get', 'class'], ['wood', 'forest'], true, false], paint: { 'fill-color': p.wood, 'fill-opacity': 0.55 } },
    {
      id: 'hills',
      type: 'hillshade',
      source: 'terrain',
      paint: { 'hillshade-exaggeration': scheme === 'day' ? 0.32 : 0.45, 'hillshade-shadow-color': p.hillShadow, 'hillshade-highlight-color': p.hillHighlight, 'hillshade-accent-color': p.hillShadow },
    },
    {
      id: 'town',
      type: 'fill',
      source: 'omt',
      'source-layer': 'landuse',
      filter: ['match', ['get', 'class'], ['residential', 'suburb', 'neighbourhood', 'commercial', 'industrial', 'retail'], true, false],
      paint: { 'fill-color': p.town, 'fill-opacity': byZoom(6, 0.35, 10, 0.55) },
    },
    { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': p.water } },
    { id: 'shore', type: 'line', source: 'omt', 'source-layer': 'water', paint: { 'line-color': p.shore, 'line-width': byZoom(6, 0.5, 12, 1.2) } },
    { id: 'river', type: 'line', source: 'omt', 'source-layer': 'waterway', filter: ['match', ['get', 'class'], ['river', 'canal'], true, false], paint: { 'line-color': p.river, 'line-width': byZoom(7, 0.5, 12, 1.6) } },
    { id: 'runway', type: 'line', source: 'omt', 'source-layer': 'aeroway', minzoom: 10, filter: ['==', ['get', 'class'], 'runway'], paint: { 'line-color': p.runway, 'line-width': byZoom(10, 1.5, 14, 8) } },
    { id: 'road-minor', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 10, filter: ['match', ['get', 'class'], ['secondary', 'tertiary'], true, false], paint: { 'line-color': p.roadMinor, 'line-width': 0.6 } },
    { id: 'road-major', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], true, false], paint: { 'line-color': p.roadMajor, 'line-width': byZoom(6, 0.4, 10, 1, 13, 2) } },
    { id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 9, filter: ['==', ['get', 'class'], 'rail'], paint: { 'line-color': p.rail, 'line-width': 0.8, 'line-dasharray': [3, 2] } },
    { id: 'province', type: 'line', source: 'omt', 'source-layer': 'boundary', filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]], paint: { 'line-color': p.province, 'line-width': 1, 'line-dasharray': [1, 2] } },
    { id: 'country', type: 'line', source: 'omt', 'source-layer': 'boundary', filter: ['==', ['get', 'admin_level'], 2], paint: { 'line-color': p.country, 'line-width': 1.3, 'line-dasharray': [5, 2, 1, 2] } },
    {
      id: 'water-name',
      type: 'symbol',
      source: 'omt',
      'source-layer': 'water_name',
      layout: { 'text-field': name, 'text-font': FONT.italic, 'text-size': 13, 'text-letter-spacing': 0.12 },
      paint: { 'text-color': p.waterText, 'text-halo-color': p.water, 'text-halo-width': 1 },
    },
    {
      id: 'place',
      type: 'symbol',
      source: 'omt',
      'source-layer': 'place',
      filter: ['match', ['get', 'class'], ['city', 'town'], true, false],
      layout: { 'text-field': name, 'text-font': FONT.regular, 'text-size': byZoom(5, 10, 10, 13), 'text-max-width': 8 },
      paint: { 'text-color': p.placeText, 'text-halo-color': p.land, 'text-halo-width': 1.5 },
    },
  ];
  return layers as LayerSpecification[];
}

export function chartStyle(scheme: Scheme): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      omt: { type: 'vector', url: OPENFREEMAP },
      terrain: { type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 12, attribution: TERRAIN_CREDIT },
    },
    layers: chartLayers(scheme),
  };
}
