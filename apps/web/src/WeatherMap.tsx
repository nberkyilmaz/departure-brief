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
 * they are drawn on a canvas, and until the map is zoomed in far enough to
 * show every one, each small patch of screen shows only its worst station:
 * the overview never hides an IFR field under a VFR one beside it.
 */
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import type { StationWeather } from './engine.js';
import { aerodromeHref } from './router.js';
import { hhmmZ } from './time.js';

/** Drawn last, so a red dot is never hidden under a green one. */
const DRAW_ORDER: Readonly<Record<string, number>> = { unknown: 0, VFR: 1, MVFR: 2, IFR: 3, LIFR: 4 };
const orderOf = (s: StationWeather): number => DRAW_ORDER[s.category ?? 'unknown'] ?? 0;

/** From this zoom on, every station is drawn: about a county on screen, where they no longer crowd. */
const EVERY_STATION_FROM_ZOOM = 8;

/**
 * The stations to draw at a zoom: the worst in each square of `spacing`
 * pixels, or every one when `spacing` is zero. Best first, so the worst are
 * drawn last and on top.
 */
function declutter(map: L.Map, stations: readonly StationWeather[], spacing: number): StationWeather[] {
  const worstFirst = [...stations].sort((a, b) => orderOf(b) - orderOf(a));
  if (spacing === 0) return worstFirst.reverse();
  const zoom = map.getZoom();
  const taken = new Set<string>();
  const kept: StationWeather[] = [];
  for (const s of worstFirst) {
    const p = map.project([s.lat, s.lon], zoom);
    const square = `${Math.floor(p.x / spacing)},${Math.floor(p.y / spacing)}`;
    if (taken.has(square)) continue;
    taken.add(square);
    kept.push(s);
  }
  return kept.reverse();
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function draw(container: HTMLElement, stations: readonly StationWeather[], centre: { lat: number; lon: number } | null): L.Map {
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  // Scrolling the page past the map should scroll the page; the wheel zooms only once the map has been clicked.
  const map = L.map(container, { scrollWheelZoom: false, minZoom: 3, maxZoom: 11, preferCanvas: true });
  map.once('click', () => map.scrollWheelZoom.enable());
  /*
   * OpenStreetMap's own tiles: no key, attribution shown, and light use like
   * this is within their policy. They come in one style only, so the dark
   * scheme inverts them in CSS rather than asking a second provider.
   */
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 11,
  }).addTo(map);

  const css = getComputedStyle(document.documentElement);
  const colour = (category: string | null) => css.getPropertyValue(`--${(category ?? 'unknown').toLowerCase()}`).trim() || '#888';
  const touch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const radius = touch ? 7 : 6;
  const layer = L.layerGroup().addTo(map);
  const plot = () => {
    layer.clearLayers();
    for (const s of declutter(map, stations, map.getZoom() >= EVERY_STATION_FROM_ZOOM ? 0 : radius * 2 + 3)) marker(s).addTo(layer);
  };
  const marker = (s: StationWeather) =>
    L.circleMarker([s.lat, s.lon], {
      radius,
      weight: 1.5,
      color: dark ? '#0d0d10' : '#ffffff',
      fillColor: colour(s.category),
      fillOpacity: 0.95,
    })
      .bindTooltip(`<b>${escapeHtml(s.id)}</b> ${s.category ?? 'unclassified'}${s.issuedAt ? ` · ${hhmmZ(s.issuedAt)}` : ''}<br>${escapeHtml(s.name)}`, {
        direction: 'top',
        offset: [0, -6],
      })
      .on('click', () => {
        window.location.hash = aerodromeHref(s.id);
      });
  map.on('zoomend', plot);
  // Both countries, when there is no home field to start from.
  map.setView(centre ? [centre.lat, centre.lon] : [47, -98], centre ? 6 : 4);
  plot();
  return map;
}

export default function WeatherMap({ stations, centre }: { stations: readonly StationWeather[]; centre: { lat: number; lon: number } | null }) {
  const el = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!el.current) return;
    let map: L.Map | null = null;
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
