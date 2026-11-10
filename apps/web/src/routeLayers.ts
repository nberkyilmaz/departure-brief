/**
 * What the route map draws, as data: the shapes for the map library to
 * fill and stroke, and the marks that sit on top of it. Nothing here needs
 * a browser that can draw a map, so all of it is tested; `RouteMap` only
 * hands it over.
 *
 * Shapes are what the chart is printed with: airspace under everything, the
 * strip searched for reports, the advisories, then the route in magenta,
 * dashed on to the alternate. Marks are what can be tapped: the fields, the
 * stations, the advisories' letters and the pilot reports, each a real
 * button with the same words a screen reader or the list uses.
 */
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';
import type { LayerSpecification } from 'maplibre-gl';
import { FONT, PALETTE, type Scheme } from './chartStyle.js';
import { AIRSPACE_STYLE, airspaceLines, columnLabel, columnsOf, hazardKey, hazardLetter, isPosition, labelOf, pirepWords, type Column } from './picture.js';
import { openColumn, opens } from './stationLink.js';
import { aerodromeHref } from './router.js';
import { CATEGORY_LETTER, fieldCards } from './summary.js';
import type { AirspaceArea, FlightCategory, RoutePicture, StoredBriefing } from './types.js';

type LatLon = { readonly lat: number; readonly lon: number };
const position = (p: LatLon): [number, number] => [p.lon, p.lat];

/** Drawn on top of one another in this order, so a red dot is never hidden under a green one. */
const DRAW_ORDER: Readonly<Record<string, number>> = { unknown: 0, vfr: 1, mvfr: 2, ifr: 3, lifr: 4 };
/** Past this many, the stations are drawn smaller: they still overlap on a phone until the map is zoomed, but less. */
export const CROWDED_AT = 16;

export interface MarkPopup {
  readonly title: string;
  readonly text: string;
  /** The report itself, when the mark is one. */
  readonly code: string | null;
}

/** One thing on the map that can be read or tapped. */
export interface Mark {
  readonly kind: 'field' | 'station' | 'hazard' | 'pirep';
  readonly lat: number;
  readonly lon: number;
  /** The classes the mark is drawn with: `rm-dot vfr hollow`, `rm-tag airmet`, `rm-pirep`. */
  readonly className: string;
  /** What is printed on it: a category letter, an advisory letter, a report number. */
  readonly text: string;
  readonly title: string;
  /** A field's identifier and name, printed under its symbol. */
  readonly label: string | null;
  readonly name: string | null;
  readonly z: number;
  /** Advisory letters on one stretch stand side by side. */
  readonly shiftPx: number;
  readonly popup: MarkPopup | null;
  readonly open: (() => void) | null;
}

function dotClass(category: FlightCategory | null, from: 'forecast' | 'now' | null, extra: string): string {
  return `rm-dot ${(category ?? 'unknown').toLowerCase()}${from === 'forecast' ? '' : ' hollow'}${extra}`;
}

/** A field's name as a chart prints it: short enough to sit under its symbol. */
export function chartName(name: string | null): string | null {
  if (!name) return null;
  return name
    .replace(/\bInternational\b/gi, 'Intl')
    .replace(/\bRegional\b/gi, 'Rgnl')
    .replace(/\bMunicipal\b/gi, 'Muni')
    .replace(/\s+(Airport|Aerodrome|Airfield|Airpark)$/i, '')
    .trim();
}

function columnMark(c: Column, crowded: boolean, nameOf: (id: string) => string | null): Mark {
  const named = c.station.role !== 'along';
  const category = (c.category ?? 'unknown').toLowerCase();
  return {
    kind: named ? 'field' : 'station',
    lat: c.station.lat,
    lon: c.station.lon,
    className: dotClass(c.category, c.from, named ? ' named' : crowded ? ' crowded' : ''),
    text: c.category ? CATEGORY_LETTER[c.category] : '–',
    title: columnLabel(c),
    // A station beside the route is named beside its letter, until there are too many to read.
    label: named || !crowded ? labelOf(c.station.id) : null,
    name: named ? chartName(nameOf(c.station.id)) : null,
    // The fields you named stay on top of what lies between them.
    z: (DRAW_ORDER[category] ?? 0) * 100 + (named ? 1000 : 0),
    shiftPx: 0,
    popup: null,
    open: opens(c) ? () => openColumn(c) : null,
  };
}

/** Every mark, in the order they are drawn. */
export function routeMarks(stored: StoredBriefing, picture: RoutePicture, nameOf: (id: string) => string | null = () => null): Mark[] {
  const columns = columnsOf(stored, picture);
  const crowded = columns.length > CROWDED_AT;
  const marks: Mark[] = [];

  picture.hazards.forEach((h, i) => {
    for (const s of h.stretches) {
      marks.push({
        kind: 'hazard',
        lat: s.middle.lat,
        lon: s.middle.lon,
        className: `rm-tag ${h.kind}`,
        text: hazardLetter(i),
        title: hazardKey(h),
        label: null,
        name: null,
        z: 2000,
        shiftPx: i * 20,
        popup: { title: hazardLetter(i), text: hazardKey(h), code: null },
        open: null,
      });
    }
  });

  marks.push(...columns.map((c) => columnMark(c, crowded, nameOf)));

  const alternate = picture.alternate;
  if (alternate) {
    // The alternate is not a column of the side view; its card says what it is at the time you would get there.
    const card = fieldCards(stored).find((c) => c.role === 'Alternate');
    const end = alternate.line[alternate.line.length - 1]!;
    marks.push({
      kind: 'field',
      lat: end.lat,
      lon: end.lon,
      className: dotClass(card?.category ?? null, card?.from ?? null, ' named'),
      text: card?.category ? CATEGORY_LETTER[card.category] : '–',
      title: `${labelOf(alternate.id)}, the alternate, ${Math.round(alternate.nm)} nm on from the destination${card?.category ? `, ${card.category}` : ''}`,
      label: labelOf(alternate.id),
      name: chartName(nameOf(alternate.id)),
      z: 1000,
      shiftPx: 0,
      popup: null,
      open: isPosition(alternate.id) ? null : () => (window.location.hash = aerodromeHref(alternate.id)),
    });
  }

  picture.pireps.forEach((p, i) => {
    marks.push({
      kind: 'pirep',
      lat: p.lat,
      lon: p.lon,
      className: `rm-pirep${p.speaksForThen ? '' : ' hollow'}`,
      text: String(i + 1),
      title: pirepWords(p),
      label: null,
      name: null,
      z: 3000,
      shiftPx: 0,
      popup: { title: String(i + 1), text: pirepWords(p), code: p.text },
      open: null,
    });
  });
  return marks;
}

/* ------------------------------------------------------------------ shapes */

const line = (points: readonly LatLon[], properties: Record<string, unknown>): Feature<LineString> => ({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates: points.map(position) } });
const ring = (points: readonly LatLon[]) => {
  const r = points.map(position);
  const [first, last] = [r[0], r[r.length - 1]];
  return first && last && (first[0] !== last[0] || first[1] !== last[1]) ? [...r, first] : r;
};
const collection = <G extends Polygon | LineString | Point>(features: Feature<G>[]): FeatureCollection<G> => ({ type: 'FeatureCollection', features });

/**
 * Where a line's distance is printed: once, at the middle of its length,
 * turned to run along it and kept the right way up. Placed by the map
 * library, a long line is labelled once in every tile it crosses.
 */
function middleLabel(points: readonly LatLon[], label: string, kind: 'route' | 'alternate'): Feature<Point> | null {
  if (points.length < 2) return null;
  // Web Mercator, which is how the map is drawn, so the angle is the one on screen.
  const mercator = (p: LatLon): [number, number] => [p.lon, (Math.log(Math.tan(Math.PI / 4 + (p.lat * Math.PI) / 360)) * 180) / Math.PI];
  const xy = points.map(mercator);
  const steps = xy.slice(1).map((q, i) => Math.hypot(q[0] - xy[i]![0], q[1] - xy[i]![1]));
  const half = steps.reduce((a, b) => a + b, 0) / 2;
  let i = 0;
  let gone = 0;
  while (i < steps.length - 1 && gone + steps[i]! < half) gone += steps[i++]!;
  const t = steps[i]! > 0 ? (half - gone) / steps[i]! : 0;
  const [a, b] = [points[i]!, points[i + 1]!];
  const [pa, pb] = [xy[i]!, xy[i + 1]!];
  // Clockwise from east on screen, where north is up.
  let rotate = (Math.atan2(-(pb[1] - pa[1]), pb[0] - pa[0]) * 180) / Math.PI;
  if (rotate > 90) rotate -= 180;
  if (rotate < -90) rotate += 180;
  return {
    type: 'Feature',
    properties: { label, kind, rotate: Math.round(rotate * 10) / 10 },
    geometry: { type: 'Point', coordinates: [a.lon + (b.lon - a.lon) * t, a.lat + (b.lat - a.lat) * t] },
  };
}

export interface RouteShapes {
  /** One strip per leg, the 25 nm either side searched for reports. */
  readonly corridor: FeatureCollection<Polygon>;
  readonly route: FeatureCollection<LineString>;
  readonly alternate: FeatureCollection<LineString>;
  /** The distance of each, printed once along its middle. */
  readonly labels: FeatureCollection<Point>;
  /** Every area of every advisory you would be inside, the later pictures of a G-AIRMET included. */
  readonly hazards: FeatureCollection<Polygon>;
}

export function routeShapes(picture: RoutePicture): RouteShapes {
  return {
    corridor: collection(picture.corridor.map((strip) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring(strip)] } }))),
    route: collection([line(picture.line, {})]),
    alternate: collection(picture.alternate ? [line(picture.alternate.line, {})] : []),
    labels: collection(
      [
        middleLabel(picture.line, `${Math.round(picture.totalNm)} NM`, 'route'),
        picture.alternate ? middleLabel(picture.alternate.line, `${Math.round(picture.alternate.nm)} NM`, 'alternate') : null,
      ].filter((f): f is Feature<Point> => f !== null),
    ),
    hazards: collection(
      picture.hazards.flatMap((h, i) =>
        [h.area, ...h.laterAreas].map((area): Feature<Polygon> => ({ type: 'Feature', properties: { kind: h.kind, letter: hazardLetter(i), words: hazardKey(h) }, geometry: { type: 'Polygon', coordinates: [ring(area)] } })),
      ),
    ),
  };
}

/** The airspace the route goes through, one polygon per shape, each knowing how it is drawn and what to say when tapped. */
export function airspaceShapes(areas: readonly AirspaceArea[]): FeatureCollection<Polygon> {
  return collection(
    airspaceLines(areas).flatMap((l) => {
      const style = AIRSPACE_STYLE[l.kind];
      return l.areas.map((a): Feature<Polygon> => ({
        type: 'Feature',
        properties: { kind: l.kind, tag: style.tag, hue: style.hue, line: style.line, title: `${style.tag} ${l.name}`, words: l.words },
        geometry: { type: 'Polygon', coordinates: a.rings.map(ring) },
      }));
    }),
  );
}

/** The aerodromes near the route that the flight does not name, drawn small so a pilot can see what is around. */
export function nearbyAirports(aerodromes: readonly { id: string; lat: number; lon: number }[], picture: RoutePicture): FeatureCollection<Point> {
  const [[west, south], [east, north]] = routeBounds(picture, 0.5);
  const named = new Set([...picture.stations.map((s) => s.id), ...(picture.alternate ? [picture.alternate.id] : [])]);
  return collection(
    aerodromes
      .filter((a) => !named.has(a.id) && a.lat >= south && a.lat <= north && a.lon >= west && a.lon <= east)
      .map((a): Feature<Point> => ({ type: 'Feature', properties: { id: a.id }, geometry: { type: 'Point', coordinates: [a.lon, a.lat] } })),
  );
}

/** Everything worth seeing: the strip, the way to the alternate and the reports beside the route. `margin` is in degrees. */
export function routeBounds(picture: RoutePicture, margin = 0): [[number, number], [number, number]] {
  const points: LatLon[] = [...picture.corridor.flat(), ...picture.line, ...(picture.alternate?.line ?? []), ...picture.pireps];
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  return [
    [Math.min(...lons) - margin, Math.min(...lats) - margin],
    [Math.max(...lons) + margin, Math.max(...lats) + margin],
  ];
}

/* ------------------------------------------------------------------ layers */

/** The source each overlay layer reads, by name. */
export const SOURCES = ['airspace', 'corridor', 'nearby', 'hazards', 'alternate', 'route', 'labels'] as const;

/**
 * What the briefing prints on the chart, bottom to top. Airspace first: it
 * arrives after everything else and must not cover the route when it does.
 */
export function routeLayers(scheme: Scheme): LayerSpecification[] {
  const p = PALETTE[scheme];
  const airColour = ['match', ['get', 'hue'], 'magenta', p.airMagenta, p.airBlue];
  const airLine = (style: 'solid' | 'dashed' | 'dotted', dash: number[] | null) => ({
    id: `airspace-${style}`,
    type: 'line',
    source: 'airspace',
    filter: ['==', ['get', 'line'], style],
    paint: { 'line-color': airColour, 'line-width': 1.5, ...(dash ? { 'line-dasharray': dash } : {}) },
  });
  const hazardColour = ['match', ['get', 'kind'], 'airmet', p.airmet, p.sigmet];
  const layers: unknown[] = [
    { id: 'airspace-fill', type: 'fill', source: 'airspace', paint: { 'fill-color': airColour, 'fill-opacity': 0.07 } },
    airLine('solid', null),
    airLine('dashed', [4, 3]),
    airLine('dotted', [1, 3]),
    { id: 'corridor-fill', type: 'fill', source: 'corridor', paint: { 'fill-color': p.route, 'fill-opacity': scheme === 'day' ? 0.06 : 0.1 } },
    { id: 'corridor-edge', type: 'line', source: 'corridor', paint: { 'line-color': p.route, 'line-opacity': 0.45, 'line-width': 1, 'line-dasharray': [3, 3] } },
    {
      id: 'nearby',
      type: 'symbol',
      source: 'nearby',
      layout: {
        'icon-image': 'chart-airport',
        'icon-allow-overlap': true,
        'text-field': ['step', ['zoom'], '', 9, ['get', 'id']],
        'text-font': FONT.regular,
        'text-size': 10,
        'text-offset': [0, 0.9],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: { 'text-color': p.airport, 'text-halo-color': p.land, 'text-halo-width': 1.2 },
    },
    { id: 'hazard-fill', type: 'fill', source: 'hazards', paint: { 'fill-color': hazardColour, 'fill-opacity': 0.16 } },
    { id: 'hazard-edge', type: 'line', source: 'hazards', paint: { 'line-color': hazardColour, 'line-width': 1.5, 'line-dasharray': [3, 2] } },
    { id: 'alternate', type: 'line', source: 'alternate', layout: { 'line-cap': 'round' }, paint: { 'line-color': p.route, 'line-width': 2.5, 'line-dasharray': [2, 1.6] } },
    { id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': p.routeCasing, 'line-width': 8, 'line-opacity': 0.9 } },
    { id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': p.route, 'line-width': 4 } },
    {
      id: 'route-label',
      type: 'symbol',
      source: 'labels',
      filter: ['==', ['get', 'kind'], 'route'],
      layout: { 'text-field': ['get', 'label'], 'text-font': FONT.bold, 'text-size': 13, 'text-rotate': ['get', 'rotate'], 'text-rotation-alignment': 'map', 'text-offset': [0, -1.1], 'text-letter-spacing': 0.06, 'text-allow-overlap': true },
      paint: { 'text-color': p.route, 'text-halo-color': p.routeCasing, 'text-halo-width': 2 },
    },
    {
      id: 'alternate-label',
      type: 'symbol',
      source: 'labels',
      filter: ['==', ['get', 'kind'], 'alternate'],
      // On the far side of its line from the route, which it leaves from.
      layout: { 'text-field': ['get', 'label'], 'text-font': FONT.bold, 'text-size': 11, 'text-rotate': ['get', 'rotate'], 'text-rotation-alignment': 'map', 'text-offset': [0, 1.1], 'text-allow-overlap': true },
      paint: { 'text-color': p.route, 'text-halo-color': p.routeCasing, 'text-halo-width': 2 },
    },
  ];
  return layers as LayerSpecification[];
}
