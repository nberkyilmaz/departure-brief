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
import { useAirspace } from './airspace.js';
import { baseMap, isTouch } from './mapBase.js';
import { AIRSPACE_STYLE, airspaceLines, columnLabel, columnsOf, hazardKey, hazardLetter, labelOf, pirepWords, type Column } from './picture.js';
import { openColumn, opens } from './stationLink.js';
import { CATEGORY_LETTER } from './summary.js';
import type { AirspaceArea, RoutePicture, StoredBriefing } from './types.js';

/** Drawn on top of one another in this order, so a red dot is never hidden under a green one. */
const DRAW_ORDER: Readonly<Record<string, number>> = { unknown: 0, vfr: 1, mvfr: 2, ifr: 3, lifr: 4 };
const FIELD_PX = 28;
const STATION_PX = 22;
/** Past this many, the stations are drawn smaller: they still overlap on a phone until the map is zoomed, but less. */
const CROWDED_AT = 16;
const CROWDED_PX = 16;
const TAG_PX = 18;
const PIREP_PX = 20;

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
    for (const area of [h.area, ...h.laterAreas]) L.polygon(area.map(latLng), { color: colour, weight: 1.5, dashArray: '5 4', fillColor: colour, fillOpacity: 0.16 }).bindPopup(words).addTo(map);
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

  picture.pireps.forEach((p, i) => {
    L.marker(latLng(p), {
      icon: L.divIcon({ className: `rm-pirep${p.speaksForThen ? '' : ' hollow'}`, html: String(i + 1), iconSize: [PIREP_PX, PIREP_PX] }),
      title: pirepWords(p),
      zIndexOffset: 3000,
    })
      .bindPopup(`<b>${i + 1}</b> ${escapeHtml(pirepWords(p))}<br><code>${escapeHtml(p.text)}</code>`)
      .addTo(map);
  });

  // Reports reach further from the line than the stations do, and one off the edge of the map might as well not be there.
  map.fitBounds(L.latLngBounds([...picture.corridor.flatMap((strip) => strip.map(latLng)), ...picture.pireps.map(latLng)]), { padding: [10, 10], maxZoom: 9 });
  return map;
}

const AIRSPACE_DASH: Readonly<Record<'solid' | 'dashed' | 'dotted', string | undefined>> = { solid: undefined, dashed: '7 5', dotted: '2 5' };

/** Under the advisories and the route, which are what the map is for, in a layer of its own because it arrives after them. */
function drawAirspace(map: L.Map, areas: readonly AirspaceArea[]): L.LayerGroup {
  const pane = map.getPane('airspace') ?? map.createPane('airspace');
  pane.style.zIndex = '350';
  const css = getComputedStyle(document.documentElement);
  const group = L.layerGroup();
  for (const line of airspaceLines(areas)) {
    const style = AIRSPACE_STYLE[line.kind];
    const colour = css.getPropertyValue(`--air-${style.hue}`).trim() || '#1d63c7';
    const words = `<b>${style.tag}</b> ${escapeHtml(line.name)}<br>${escapeHtml(line.words)}`;
    for (const area of line.areas) {
      L.polygon(area.rings.map((ring) => ring.map(latLng)), { pane: 'airspace', color: colour, weight: 1.5, dashArray: AIRSPACE_DASH[style.line], fillColor: colour, fillOpacity: 0.07 }).bindPopup(words).addTo(group);
    }
  }
  return group.addTo(map);
}

export default function RouteMap({ stored, picture }: { stored: StoredBriefing; picture: RoutePicture }) {
  const el = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [map, setMap] = useState<L.Map | null>(null);
  const columns = useMemo(() => columnsOf(stored, picture), [stored, picture]);
  const airspace = useAirspace(picture);

  useEffect(() => {
    if (!el.current) return;
    let drawn: L.Map | null = null;
    try {
      setFailed(false);
      drawn = draw(el.current, columns, picture);
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
  }, [columns, picture]);

  useEffect(() => {
    if (!map || typeof airspace !== 'object' || airspace.areas.length === 0) return;
    const layer = drawAirspace(map, airspace.areas);
    return () => {
      layer.remove();
    };
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
