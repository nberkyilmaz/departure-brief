/**
 * The route picture read for drawing: which letter each station gets, where
 * it goes across the chart, how high the chart reaches, and what has to be
 * said under it. Arithmetic and words only, so it can be tested without a
 * browser; `SideView` turns it into marks.
 */
import { alongTheWay, fieldCards } from './summary.js';
import { clock24, hhmmZ } from './time.js';
import type { TerrainState } from './terrain.js';
import type { FlightCategory, PictureFreezing, PictureHazard, PictureHazardBase, PictureHazardMissed, PictureLayer, PictureStation, RoutePicture, RouteTerrain, StoredBriefing } from './types.js';

export interface Column {
  readonly station: PictureStation;
  /** The same letter the list and the field cards show, from the same code. */
  readonly category: FlightCategory | null;
  readonly from: 'forecast' | 'now' | null;
}

/** Each column's category, read from what the page already says about that station rather than worked out a second time. */
export function columnsOf(stored: StoredBriefing, picture: RoutePicture): Column[] {
  const along = new Map(alongTheWay(stored).flatMap((leg) => leg.stations.map((s) => [s.review.station, s] as const)));
  const cards = fieldCards(stored).filter((c) => c.role !== 'Alternate');
  let field = 0;
  return picture.stations.map((station) => {
    const said = station.role === 'along' ? along.get(station.id) : cards[field++];
    return { station, category: said?.category ?? null, from: said?.from ?? null };
  });
}

/** Wide enough to read a cloud label, and to put a thumb on. */
export const COLUMN_PX = 58;

export interface Spread {
  /** Each column's centre, left to right. */
  readonly xs: readonly number[];
  readonly width: number;
  /** Some stations were pushed further apart than the distance between them would put them. */
  readonly spreadApart: boolean;
}

/**
 * Where each column goes. True to the distance while that leaves every
 * column room, which is most routes, so a long empty stretch looks long; a
 * crowded corridor is given the room it needs and scrolls. Half of all
 * neighbouring stations on the routes measured are under 8 nm apart, and no
 * scale that kept those true would leave them readable.
 */
export function spread(miles: readonly number[], availablePx: number): Spread {
  const first = miles[0] ?? 0;
  const span = (miles[miles.length - 1] ?? 0) - first;
  const perNm = span > 0 ? Math.max(0, availablePx - COLUMN_PX) / span : 0;
  const xs = [COLUMN_PX / 2];
  let spreadApart = false;
  for (let i = 1; i < miles.length; i++) {
    const natural = (miles[i]! - miles[i - 1]!) * perNm;
    if (natural < COLUMN_PX) spreadApart = true;
    xs.push(xs[i - 1]! + Math.max(COLUMN_PX, natural));
  }
  return { xs, width: xs[xs.length - 1]! + COLUMN_PX / 2, spreadApart };
}

/** Across the chart for any distance along the route: straight between the columns on either side of it. */
export function xOfNm(nm: number, miles: readonly number[], xs: readonly number[]): number {
  for (let i = 1; i < miles.length; i++) {
    if (nm > miles[i]!) continue;
    const span = miles[i]! - miles[i - 1]!;
    return span > 0 ? xs[i - 1]! + ((xs[i]! - xs[i - 1]!) * (nm - miles[i - 1]!)) / span : xs[i]!;
  }
  return xs[xs.length - 1] ?? 0;
}

const MIN_CHART_TOP_FT = 8_000;

/** How high the chart reaches: three thousand feet over the cruise or the highest ground. Anything above is written at the top, not drawn. */
export function chartTop(picture: RoutePicture, terrain: RouteTerrain | null = null): number {
  const highest = Math.max(picture.cruiseFt, terrain?.highest.ft ?? 0, ...picture.stations.map((s) => s.elevationFt ?? 0));
  return Math.max(MIN_CHART_TOP_FT, Math.ceil((highest + 3_000) / 1_000) * 1_000);
}

export function altitudeTicks(top: number): number[] {
  const step = top <= 16_000 ? 2_000 : 5_000;
  const out: number[] = [];
  for (let ft = 0; ft <= top; ft += step) out.push(ft);
  return out;
}

const feet = (ft: number): string => ft.toLocaleString('en');

/** The ground as one SVG path, down to the baseline at each end. */
export function terrainPath(terrain: RouteTerrain, xAt: (nm: number) => number, yOf: (ft: number) => number): string {
  const px = (n: number) => n.toFixed(1);
  const first = terrain.samples[0]!;
  const last = terrain.samples[terrain.samples.length - 1]!;
  const base = px(yOf(0));
  return `M${px(xAt(first.nm))} ${base}${terrain.samples.map((s) => `L${px(xAt(s.nm))} ${px(yOf(Math.max(0, s.ft)))}`).join('')}L${px(xAt(last.nm))} ${base}Z`;
}

/**
 * What a layer is called on the chart: its type when it has one, since CB
 * and TCU are the point, or its amount. To the nearest hundred feet, which
 * is as finely as a report gives a height; the rest is only the elevation.
 */
export function layerText(l: PictureLayer): string {
  const name = l.kind === 'vertical-visibility' ? 'VV' : (l.type ?? l.amount ?? 'Cloud');
  return l.baseMsl === null ? name : `${name} ${heightText(l)}`;
}

export const heightText = (l: PictureLayer): string => (l.baseMsl === null ? '' : feet(Math.round(l.baseMsl / 100) * 100));

const isCeiling = (l: PictureLayer): boolean => l.kind === 'vertical-visibility' || l.amount === 'BKN' || l.amount === 'OVC';

/**
 * Which of a column's layers get their words, given how far apart a label
 * needs to be. Thunderstorm cloud first, then the lowest ceiling, then the
 * lowest cloud, then upward while there is room. The rest are still drawn,
 * and all of them are in the list a tap away.
 */
export function layersToLabel(layers: readonly PictureLayer[], yOf: (ft: number) => number, gapPx: number): ReadonlySet<PictureLayer> {
  const placed = layers.filter((l) => l.baseMsl !== null).sort((a, b) => a.baseMsl! - b.baseMsl!);
  const order = [...placed.filter((l) => l.type === 'CB'), ...placed.filter(isCeiling).slice(0, 1), ...placed];
  const chosen = new Set<PictureLayer>();
  for (const l of order) {
    if (chosen.has(l)) continue;
    if ([...chosen].every((c) => Math.abs(yOf(c.baseMsl!) - yOf(l.baseMsl!)) >= gapPx)) chosen.add(l);
  }
  return chosen;
}

/** Long enough with nothing reporting that the chart should say so on the empty stretch itself. */
export const EMPTY_STRETCH_NM = 60;

export function emptyStretches(columns: readonly Column[]): { index: number; from: string; to: string; nm: number }[] {
  return columns.flatMap((c, i) => {
    const next = columns[i + 1];
    if (!next) return [];
    const nm = next.station.nm - c.station.nm;
    return nm > EMPTY_STRETCH_NM ? [{ index: i, from: c.station.id, to: next.station.id, nm }] : [];
  });
}

const both = (iso: string): string => `${clock24(iso)} (${hhmmZ(iso)})`;

function nameOf(h: PictureHazardBase): string {
  return `${h.kind === 'airmet' ? 'AIRMET' : 'SIGMET'}${h.region ? ` ${h.region}` : ''}, ${h.qualifier ? `${h.qualifier} ` : ''}${h.what}`;
}

/** A missing base is the surface and a missing top is open-ended: the rules' own reading. */
function bandText(h: PictureHazardBase): string {
  if (h.baseFt === null && h.topFt === null) return 'no altitude given';
  const base = !h.baseFt ? 'surface' : `${feet(h.baseFt)} ft`;
  return `${base} to ${h.topFt === null ? 'no stated top' : `${feet(h.topFt)} ft`}`;
}

/** One advisory on the chart, in words, beside its letter. */
export function hazardKey(h: PictureHazard): string {
  const where = h.stretches.map((s) => `${Math.round(s.fromNm)} to ${Math.round(s.toNm)} nm`).join(' and ');
  const ends = h.stretches.some((s) => s.endsInside) && h.validTo ? `, ending ${both(h.validTo)} while you are in it` : h.validTo ? `, in force to ${both(h.validTo)}` : '';
  const starts = h.stretches.some((s) => s.startsInside) && h.validFrom ? `, beginning ${both(h.validFrom)} while you are in it` : '';
  return `${nameOf(h)}, ${bandText(h)}, ${where}${starts}${ends}.`;
}

function missedText(h: PictureHazardMissed): string {
  const why =
    h.why === 'over-before-you-reach-it'
      ? `it ends ${h.validTo ? both(h.validTo) : ''}, before you reach it at ${both(h.at)}`
      : `it begins ${h.validFrom ? both(h.validFrom) : ''}, after you have left it at ${both(h.at)}`;
  return `Not drawn: ${nameOf(h)}. It is on your route, but ${why.replace(/\s+/g, ' ')}.`;
}

function freezingText(f: PictureFreezing): string {
  const away = f.distanceNm >= 1 ? `, ${Math.round(f.distanceNm)} nm away` : '';
  const heights = [
    ...(f.belowFt !== null ? [`below ${feet(f.belowFt)} ft`] : []),
    ...(f.crossingsFt.length > 0 ? [`${f.belowFt !== null ? 'again at ' : ''}${f.crossingsFt.map((ft) => `${feet(ft)} ft`).join(' and ')}`] : []),
    ...(f.aboveFt !== null && f.crossingsFt.length === 0 && f.belowFt === null ? [`above ${feet(f.aboveFt)} ft`] : []),
  ];
  return `${heights.join(', ')} at ${f.station}${away}`;
}

/** How the highest ground compares with the cruise, in feet either way: a fact to read, not a verdict. */
function againstCruise(highestFt: number, cruiseFt: number): string {
  const gap = Math.abs(cruiseFt - highestFt);
  if (gap < 50) return 'level with your cruise';
  return `${feet(Math.round(gap / 100) * 100)} ft ${highestFt > cruiseFt ? 'above' : 'below'} your cruise`;
}

/** What the ground on the chart is, once there is any, and how far to trust it. */
function groundNote(picture: RoutePicture, terrain: TerrainState, empty: readonly string[]): string {
  const stations = `Ground is known only at the stations, at each one's own elevation. Between them the chart shows nothing, which does not mean flat.${empty.join('')}`;
  if (terrain === 'loading') return stations;
  if (terrain === 'failed') return `${stations} The terrain along your line could not be fetched just now.`;
  const { ft, nm } = terrain.highest;
  return `The shaded ground is the terrain under your line, every ${terrain.spacingNm < 3 ? Math.round(terrain.spacingNm) : terrain.spacingNm.toFixed(1)} nm. Its highest point is ${feet(ft)} ft at ${Math.round(nm)} nm, ${againstCruise(ft, picture.cruiseFt)}. These are spot heights on the centre line, so a peak between them or beside the line is not on it: this is not a clearance.${empty.join('')}`;
}

/** Everything the chart cannot show and will not pretend to, in the order a pilot would want to be told. */
export function notesOf(picture: RoutePicture, columns: readonly Column[], spreadApart: boolean, terrain: TerrainState = 'loading'): string[] {
  const empty = emptyStretches(columns).map((g) => ` Nothing reports for ${Math.round(g.nm)} nm between ${g.from} and ${g.to}.`);
  const freezing = picture.freezing;
  const bound = freezing.some((f) => f.belowFt !== null);
  const untestable = picture.hazardsUntestable;
  return [
    'Cloud bases only: METARs and TAFs do not give tops, so each cloud fades out above its base.',
    groundNote(picture, terrain, empty),
    freezing.length > 0
      ? `Freezing level, forecast for the time you pass: ${freezing.map(freezingText).join('; ')}. Between those points it is not known.${bound ? ' "Below" is as far as that forecast goes: it has no temperature under that height.' : ''}`
      : 'No upper-air temperatures reach this route, so no freezing level is drawn.',
    `Times are at your planned ${picture.tasKt} kt with no wind, as in Along the way, by this device's clock.`,
    ...(spreadApart ? ['Stations close together are spread apart so each can be read: go by the miles printed, not the gaps.'] : []),
    ...picture.hazardsMissed.map(missedText),
    ...(untestable > 0 ? [`${untestable} ${untestable === 1 ? 'advisory' : 'advisories'} in force during the flight ${untestable === 1 ? 'gives an area' : 'give areas'} that cannot be tested against a route, so ${untestable === 1 ? 'it is' : 'they are'} not drawn.`] : []),
  ];
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The letter an advisory goes by, the same on the map and the side view. */
export const hazardLetter = (index: number): string => LETTERS[index] ?? '?';

/** A waypoint typed as a position rather than an aerodrome. */
export const isPosition = (id: string): boolean => id.includes(',');
export const labelOf = (id: string): string => (isPosition(id) ? 'WPT' : id);

/** One station, as a screen reader or a hover says it. */
export function columnLabel(c: Column): string {
  const s = c.station;
  const what = c.category ? `${c.category}, ${c.from === 'now' ? 'observed now, no forecast for your time' : 'forecast for your time'}` : 'no category';
  return `${labelOf(s.id)}, ${Math.round(s.nm)} nm along, passing ${clock24(s.at)}, ${what}`;
}

/** Where a station's row in "Along the way" can be found. */
export const alongRowId = (station: string): string => `along-${station}`;
