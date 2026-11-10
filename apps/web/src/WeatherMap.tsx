/**
 * Every reporting station on a map, coloured by flight category.
 *
 * Loaded only when the start page is shown, so the map library costs the
 * briefing page nothing. The colours are read from the same CSS variables
 * the briefing uses, so a station that is IFR here is the same red as an
 * IFR point on a route, in either colour scheme.
 *
 * A station is a link: tapping it opens the field's own page, where the
 * report is read back line by line. The map shows where to look; the field
 * page shows why.
 *
 * Canada and the United States together are a few thousand stations, which
 * at the scale of a continent would be a carpet of overlapping dots. So
 * until the map is zoomed in far enough to show every one, each small patch
 * of screen shows only its worst station: the overview never hides an IFR
 * field under a VFR one beside it.
 */
import { Popup, type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import type { Feature, FeatureCollection, Point } from 'geojson';
import { useEffect, useRef, useState } from 'react';
import type { StationWeather } from './engine.js';
import { baseMap, isTouch, schemeNow } from './mapBase.js';
import { aerodromeHref } from './router.js';
import { hhmmZ } from './time.js';

/** Drawn last, so a red dot is never hidden under a green one. */
const DRAW_ORDER: Readonly<Record<string, number>> = { unknown: 0, VFR: 1, MVFR: 2, IFR: 3, LIFR: 4 };
const orderOf = (s: StationWeather): number => DRAW_ORDER[s.category ?? 'unknown'] ?? 0;

/** From this zoom on, every station is drawn: about a county on screen, where they no longer crowd. */
const EVERY_STATION_FROM_ZOOM = 7;

/**
 * The stations to draw at a zoom: the worst in each square of `spacing`
 * pixels, or every one when `spacing` is zero.
 */
function declutter(map: MapLibreMap, stations: readonly StationWeather[], spacing: number): StationWeather[] {
  if (spacing === 0) return [...stations];
  const taken = new Set<string>();
  const kept: StationWeather[] = [];
  for (const s of [...stations].sort((a, b) => orderOf(b) - orderOf(a))) {
    const p = map.project([s.lon, s.lat]);
    const square = `${Math.floor(p.x / spacing)},${Math.floor(p.y / spacing)}`;
    if (taken.has(square)) continue;
    taken.add(square);
    kept.push(s);
  }
  return kept;
}

const asFeatures = (stations: readonly StationWeather[]): FeatureCollection<Point> => ({
  type: 'FeatureCollection',
  features: stations.map(
    (s): Feature<Point> => ({ type: 'Feature', properties: { id: s.id, category: s.category ?? 'unknown', order: orderOf(s) }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } }),
  ),
});

function draw(container: HTMLElement, stations: readonly StationWeather[], centre: { lat: number; lon: number } | null): MapLibreMap {
  const scheme = schemeNow();
  // Both countries, when there is no home field to start from.
  const map = baseMap(container, centre ? { center: [centre.lon, centre.lat], zoom: 5 } : { center: [-98, 47], zoom: 2.6 }, scheme);
  const css = getComputedStyle(document.documentElement);
  const colour = (category: string) => css.getPropertyValue(`--${category.toLowerCase()}`).trim() || '#888888';
  const radius = isTouch() ? 7 : 6;
  const byId = new Map(stations.map((s) => [s.id, s]));

  map.on('load', () => {
    map.addSource('stations', { type: 'geojson', data: asFeatures([]) });
    map.addLayer({
      id: 'stations',
      type: 'circle',
      source: 'stations',
      layout: { 'circle-sort-key': ['get', 'order'] },
      paint: {
        'circle-radius': radius,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': scheme === 'night' ? '#0d0d10' : '#ffffff',
        'circle-color': ['match', ['get', 'category'], 'VFR', colour('VFR'), 'MVFR', colour('MVFR'), 'IFR', colour('IFR'), 'LIFR', colour('LIFR'), colour('unknown')],
      },
    });
    const plot = () => (map.getSource('stations') as GeoJSONSource | undefined)?.setData(asFeatures(declutter(map, stations, map.getZoom() >= EVERY_STATION_FROM_ZOOM ? 0 : radius * 2 + 3)));
    map.on('zoomend', plot);
    plot();

    const hover = new Popup({ closeButton: false, closeOnClick: false, offset: 10, maxWidth: '16rem' });
    map.on('mousemove', 'stations', (e) => {
      const s = byId.get(String(e.features?.[0]?.properties?.['id']));
      if (!s) return;
      map.getCanvas().style.cursor = 'pointer';
      const box = document.createElement('div');
      const id = document.createElement('b');
      id.textContent = s.id;
      box.append(id, ` ${s.category ?? 'unclassified'}${s.issuedAt ? ` · ${hhmmZ(s.issuedAt)}` : ''}`, document.createElement('br'), s.name);
      hover.setLngLat([s.lon, s.lat]).setDOMContent(box).addTo(map);
    });
    map.on('mouseleave', 'stations', () => {
      map.getCanvas().style.cursor = '';
      hover.remove();
    });
    map.on('click', 'stations', (e) => {
      const id = e.features?.[0]?.properties?.['id'];
      if (typeof id === 'string') window.location.hash = aerodromeHref(id);
    });
  });
  return map;
}

export default function WeatherMap({ stations, centre }: { stations: readonly StationWeather[]; centre: { lat: number; lon: number } | null }) {
  const el = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!el.current) return;
    let map: MapLibreMap | null = null;
    try {
      map = draw(el.current, stations, centre);
    } catch {
      // A map that cannot be drawn is a missing picture, not a broken page: every station is still a search away.
      setFailed(true);
    }
    return () => {
      try {
        map?.remove();
      } catch {
        // Already gone with its container.
      }
    };
    // The centre is compared by value: the page builds a new object for the same place on every render.
  }, [stations, centre?.lat, centre?.lon]);

  return (
    <div ref={el} className={failed ? 'wx-map wx-map-loading' : 'wx-map'} role="region" aria-label="Map of reporting stations, coloured by flight category">
      {failed ? 'The map could not be drawn here. Every station is still one search away.' : null}
    </div>
  );
}
