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
 */
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import type { StationWeather } from './engine.js';
import { aerodromeHref } from './router.js';
import { hhmmZ } from './time.js';

/** Drawn last, so a red dot is never hidden under a green one. */
const DRAW_ORDER: Readonly<Record<string, number>> = { unknown: 0, VFR: 1, MVFR: 2, IFR: 3, LIFR: 4 };

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function draw(container: HTMLElement, stations: readonly StationWeather[], centre: { lat: number; lon: number } | null): L.Map {
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  // Scrolling the page past the map should scroll the page; the wheel zooms only once the map has been clicked.
  const map = L.map(container, { scrollWheelZoom: false, minZoom: 3, maxZoom: 11 });
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
  const ordered = [...stations].sort((a, b) => (DRAW_ORDER[a.category ?? 'unknown'] ?? 0) - (DRAW_ORDER[b.category ?? 'unknown'] ?? 0));
  for (const s of ordered) {
    L.circleMarker([s.lat, s.lon], {
      radius: touch ? 7 : 6,
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
      })
      .addTo(map);
  }
  map.setView(centre ? [centre.lat, centre.lon] : [52, -95], centre ? 6 : 4);
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
