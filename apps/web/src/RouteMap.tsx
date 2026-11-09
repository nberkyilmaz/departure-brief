/**
 * The flight on a map: where it goes, the strip beside it that was searched
 * for reports, every station in that strip at the time you would pass it,
 * and the advisories you would be inside while they are in force.
 *
 * Loaded only once there is a flight to draw. Every station is shown, worst
 * on top, each with its letter so the category never rests on colour. A
 * hollow letter is an observation from now, as on the side view, and comes
 * from the same code as the list below.
 *
 * On a phone this sits in the middle of a long page, so one finger scrolls
 * the page and two move the map. A map that caught every thumb passing over
 * it would make the rest of the briefing hard to reach.
 */
import L from 'leaflet';
import { useEffect, useMemo, useRef, useState } from 'react';
import { baseMap, isTouch } from './mapBase.js';
import { columnLabel, columnsOf, hazardKey, hazardLetter, labelOf, type Column } from './picture.js';
import { openColumn, opens } from './stationLink.js';
import { CATEGORY_LETTER } from './summary.js';
import type { RoutePicture, StoredBriefing } from './types.js';

/** Drawn on top of one another in this order, so a red dot is never hidden under a green one. */
const DRAW_ORDER: Readonly<Record<string, number>> = { unknown: 0, vfr: 1, mvfr: 2, ifr: 3, lifr: 4 };
const FIELD_PX = 28;
const STATION_PX = 22;
/** Past this many, the stations are drawn smaller: they still overlap on a phone until the map is zoomed, but less. */
const CROWDED_AT = 16;
const CROWDED_PX = 16;
const TAG_PX = 18;

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const latLng = (p: { lat: number; lon: number }): L.LatLngTuple => [p.lat, p.lon];

function dot(c: Column, crowded: boolean): L.Marker {
  const category = (c.category ?? 'unknown').toLowerCase();
  const named = c.station.role !== 'along';
  const small = crowded && !named;
  const size = named ? FIELD_PX : small ? CROWDED_PX : STATION_PX;
  const marker = L.marker(latLng(c.station), {
    icon: L.divIcon({
      className: `rm-dot ${category}${c.from === 'forecast' ? '' : ' hollow'}${named ? ' named' : ''}${small ? ' crowded' : ''}`,
      html: c.category ? CATEGORY_LETTER[c.category] : '–',
      iconSize: [size, size],
    }),
    title: columnLabel(c),
    // The fields you named stay on top of what lies between them.
    zIndexOffset: (DRAW_ORDER[category] ?? 0) * 100 + (named ? 1000 : 0),
    interactive: opens(c),
    keyboard: opens(c),
  });
  if (named) marker.bindTooltip(labelOf(c.station.id), { permanent: true, direction: 'top', offset: [0, -FIELD_PX / 2], className: 'rm-label' });
  return opens(c) ? marker.on('click', () => openColumn(c)) : marker;
}

function draw(container: HTMLElement, columns: readonly Column[], picture: RoutePicture): L.Map {
  // Drawn as shapes rather than on a canvas: there are only a handful, and each of them can be tapped.
  const map = baseMap(container, { dragging: !isTouch(), preferCanvas: false });
  const css = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const fg = token('--fg', '#16191c');
  const surface = token('--surface', '#ffffff');
  const advisory = token('--advisory', '#3f6493');

  // One outline per leg, wound the same way, so where two legs overlap at a turn the shading does not double.
  const strips: L.LatLngTuple[][][] = picture.corridor.map((strip) => [strip.map(latLng)]);
  L.polygon(strips, { color: advisory, weight: 1, opacity: 0.6, fillColor: advisory, fillOpacity: 0.12, fillRule: 'nonzero', interactive: false }).addTo(map);

  picture.hazards.forEach((h, i) => {
    const colour = token(h.kind === 'airmet' ? '--marginal' : '--nogo', '#b3261e');
    const words = `<b>${hazardLetter(i)}</b> ${escapeHtml(hazardKey(h))}`;
    L.polygon(h.area.map(latLng), { color: colour, weight: 1.5, dashArray: '5 4', fillColor: colour, fillOpacity: 0.16 }).bindPopup(words).addTo(map);
    for (const s of h.stretches) {
      L.marker(latLng(s.middle), {
        // Side by side, since two advisories on one stretch would otherwise put their letters in the same place.
        icon: L.divIcon({ className: `rm-tag ${h.kind}`, html: hazardLetter(i), iconSize: [TAG_PX, TAG_PX], iconAnchor: [TAG_PX / 2 - i * (TAG_PX + 2), TAG_PX / 2] }),
        title: hazardKey(h),
        zIndexOffset: 2000,
      })
        .bindPopup(words)
        .addTo(map);
    }
  });

  const line = picture.line.map(latLng);
  L.polyline(line, { color: surface, weight: 6, opacity: 0.85, interactive: false }).addTo(map);
  L.polyline(line, { color: fg, weight: 2.5, interactive: false }).addTo(map);

  for (const c of columns) dot(c, columns.length > CROWDED_AT).addTo(map);

  map.fitBounds(L.latLngBounds(picture.corridor.flatMap((strip) => strip.map(latLng))), { padding: [10, 10], maxZoom: 9 });
  return map;
}

export default function RouteMap({ stored, picture }: { stored: StoredBriefing; picture: RoutePicture }) {
  const el = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const columns = useMemo(() => columnsOf(stored, picture), [stored, picture]);

  useEffect(() => {
    if (!el.current) return;
    let map: L.Map | null = null;
    try {
      setFailed(false);
      map = draw(el.current, columns, picture);
    } catch {
      // A map that cannot be drawn is a missing picture, not a broken page.
      setFailed(true);
    }
    return () => {
      try {
        map?.remove();
      } catch {
        // Already gone with its container.
      }
    };
  }, [columns, picture]);

  return (
    <>
      <div ref={el} className={`wx-map route-map-canvas${failed ? ' wx-map-loading' : ''}`} role="region" aria-label="Map of your route, with every station along it at the time you would pass it">
        {failed ? 'The map could not be drawn here. The side view and the list below have every station.' : null}
      </div>
      {isTouch() && <p className="route-map-hint">One finger scrolls the page. Two move the map.</p>}
    </>
  );
}
