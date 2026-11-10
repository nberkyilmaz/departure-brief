/**
 * The flight on a chart: where it goes and on to the alternate, the strip
 * beside it that was searched for reports, every station in that strip at
 * the time you would pass it, the advisories you would be inside while they
 * are in force, the airspace the line goes through, and the aerodromes
 * around it.
 *
 * Loaded only once there is a flight to draw. What it draws is worked out
 * in `routeLayers`, where it is tested; this hands it to the map library.
 * Every station is a button with its letter, so the category never rests on
 * colour, and a hollow letter is an observation from now, as on the side
 * view and in the list.
 *
 * On a phone this sits in the middle of a long page, so one finger scrolls
 * the page and two move the map. A map that caught every thumb passing over
 * it would make the rest of the briefing hard to reach.
 */
import { Marker, type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { useAirspace } from './airspace.js';
import { baseMap, isTouch, popupWith, schemeNow } from './mapBase.js';
import { airspaceShapes, nearbyAirports, routeBounds, routeLayers, routeMarks, routeShapes, type Mark } from './routeLayers.js';
import { aerodromeHref } from './router.js';
import type { AirspaceArea, RoutePicture, StoredBriefing } from './types.js';

const SVG = 'http://www.w3.org/2000/svg';

/** A chart's symbol for an aerodrome with services: a ring with four ticks, around the field's category. */
function chartRing(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('class', 'rm-ring');
  svg.setAttribute('aria-hidden', 'true');
  const ring = document.createElementNS(SVG, 'circle');
  ring.setAttribute('cx', '20');
  ring.setAttribute('cy', '20');
  ring.setAttribute('r', '13.5');
  const ticks = document.createElementNS(SVG, 'path');
  ticks.setAttribute('d', 'M20 2.5v4M20 33.5v4M2.5 20h4M33.5 20h4');
  svg.append(ring, ticks);
  return svg;
}

function markElement(m: Mark): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `rm-mark rm-${m.kind}`;
  wrap.style.zIndex = String(m.z);
  const tappable = m.open !== null || m.popup !== null;
  const face = document.createElement(tappable ? 'button' : 'span');
  if (face instanceof HTMLButtonElement) face.type = 'button';
  face.className = m.className;
  face.textContent = m.text;
  face.title = m.title;
  face.setAttribute('aria-label', m.title);
  if (m.open) {
    const open = m.open;
    face.addEventListener('click', (e) => {
      e.stopPropagation();
      open();
    });
  }
  if (m.kind === 'field') wrap.append(chartRing());
  wrap.append(face);
  if (m.label) {
    const label = document.createElement('span');
    label.className = 'rm-label';
    label.textContent = m.label;
    if (m.name) {
      const name = document.createElement('small');
      name.textContent = m.name;
      label.append(name);
    }
    wrap.append(label);
  }
  return wrap;
}

const nothing = { type: 'FeatureCollection' as const, features: [] };

function draw(container: HTMLElement, stored: StoredBriefing, picture: RoutePicture, nameOf: (id: string) => string | null, aerodromes: readonly Aerodrome[], leaveLeft: number): MapLibreMap {
  const scheme = schemeNow();
  // Framed in the part of the map no card covers.
  const padding = leaveLeft > 0 ? { top: 32, bottom: 32, left: leaveLeft, right: 56 } : 24;
  const map = baseMap(container, { bounds: routeBounds(picture), padding }, scheme);
  const shapes = routeShapes(picture);
  map.on('load', () => {
    map.addSource('airspace', { type: 'geojson', data: nothing });
    map.addSource('corridor', { type: 'geojson', data: shapes.corridor });
    map.addSource('nearby', { type: 'geojson', data: nearbyAirports(aerodromes, picture) });
    map.addSource('hazards', { type: 'geojson', data: shapes.hazards });
    map.addSource('alternate', { type: 'geojson', data: shapes.alternate });
    map.addSource('route', { type: 'geojson', data: shapes.route });
    map.addSource('labels', { type: 'geojson', data: shapes.labels });
    for (const layer of routeLayers(scheme)) map.addLayer(layer);

    // An area says what it is when tapped: the advisory first where both are under the finger, since it is the one in force.
    map.on('click', (e) => {
      const [hit] = map.queryRenderedFeatures(e.point, { layers: ['hazard-fill', 'airspace-fill'] }).sort((a, b) => (a.layer.id === 'hazard-fill' ? -1 : 0) - (b.layer.id === 'hazard-fill' ? -1 : 0));
      if (!hit) return;
      const p = hit.properties as Record<string, string>;
      popupWith({ title: p['letter'] ?? p['title'] ?? '', text: p['words'] ?? '', code: null })
        .setLngLat(e.lngLat)
        .addTo(map);
    });
    map.on('click', 'nearby', (e) => {
      const id = e.features?.[0]?.properties?.['id'];
      if (typeof id === 'string') window.location.hash = aerodromeHref(id);
    });
    for (const id of ['hazard-fill', 'airspace-fill', 'nearby']) {
      map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
    }
  });
  for (const m of routeMarks(stored, picture, nameOf)) {
    const marker = new Marker({ element: markElement(m), offset: [m.shiftPx, 0] }).setLngLat([m.lon, m.lat]);
    if (m.popup) marker.setPopup(popupWith(m.popup));
    marker.addTo(map);
  }
  return map;
}

/** Arrives after the map is drawn, and may arrive before its style has loaded. */
function showAirspace(map: MapLibreMap, areas: readonly AirspaceArea[]): void {
  const put = () => (map.getSource('airspace') as GeoJSONSource | undefined)?.setData(airspaceShapes(areas));
  if (map.getSource('airspace')) put();
  else map.once('load', put);
}

export interface Aerodrome {
  readonly id: string;
  readonly lat: number;
  readonly lon: number;
}

// Stable, so a page that passes neither does not redraw the map on every render.
const NO_NAMES = (): string | null => null;
const NO_AERODROMES: readonly Aerodrome[] = [];

export default function RouteMap({
  stored,
  picture,
  nameOf = NO_NAMES,
  aerodromes = NO_AERODROMES,
  leaveLeft = 0,
}: {
  stored: StoredBriefing;
  picture: RoutePicture;
  nameOf?: ((id: string) => string | null) | undefined;
  aerodromes?: readonly Aerodrome[] | undefined;
  /** Pixels on the left a card covers, which the route is framed clear of. */
  leaveLeft?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const airspace = useAirspace(picture);

  useEffect(() => {
    if (!el.current) return;
    let drawn: MapLibreMap | null = null;
    try {
      setFailed(false);
      drawn = draw(el.current, stored, picture, nameOf, aerodromes, leaveLeft);
      setMap(drawn);
    } catch {
      // A map that cannot be drawn is a missing picture, not a broken page.
      setFailed(true);
    }
    return () => {
      setMap(null);
      try {
        drawn?.remove();
      } catch {
        // Already gone with its container.
      }
    };
  }, [stored, picture, nameOf, aerodromes, leaveLeft]);

  useEffect(() => {
    if (map && typeof airspace === 'object' && airspace.areas.length > 0) showAirspace(map, airspace.areas);
  }, [map, airspace]);

  return (
    <>
      <div ref={el} className={`wx-map route-map-canvas${failed ? ' wx-map-loading' : ''}`} role="region" aria-label="Map of your route, with every station along it at the time you would pass it">
        {failed ? 'The map could not be drawn here. The side view and the list below have every station.' : null}
      </div>
      {isTouch() && <p className="route-map-hint">One finger scrolls the page. Two move the map.</p>}
    </>
  );
}
