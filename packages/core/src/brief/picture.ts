/**
 * The flight as a picture: what the side view and the map draw.
 *
 * Nothing here is a judgement. It is the resolved flight laid out along the
 * route, in the feet and the clock a chart needs, so it is kept beside the
 * briefing rather than inside its hashed document: drawing a flight
 * differently must not make it a different briefing.
 *
 * Three things a picture could easily get wrong are settled here.
 *
 * A TAF and a METAR give cloud above their own station, so a base is put on
 * the altitude scale with the elevation of the station that issued the
 * report. Where a named field borrows a neighbour's forecast that is the
 * neighbour.
 *
 * Most stations beside a route have no TAF. What they observed is drawn as
 * an observation, and only while it says anything about the time you pass:
 * past the same ninety minutes the rules stop treating an observation as
 * hard evidence, the sky is left out and only the category remains.
 *
 * An advisory is placed where the route is inside its area at the moment
 * you would be there. One that is over before you reach it, or not yet
 * begun, is not drawn, and is listed so the page can say why.
 */
import type { Conditions } from '../decode/conditions.js';
import type { CloudAmount, CloudType, SkyCondition } from '../decode/groups/sky.js';
import { sliceSpan, type Sourced } from '../decode/span.js';
import { freezingLevel, type FreezingLevel } from '../decode/upperwind/interpolate.js';
import type { Airport } from '../domain/airport.js';
import { initialCourse, pointAlong, pointOnCourse, type LatLon } from '../domain/geo.js';
import { areaIsTestable, legInsideArea } from '../domain/polygon.js';
import { CORRIDOR_NM, type EnrouteStation } from '../resolve/enroute.js';
import type { ResolvedFlight, ResolvedPoint } from '../resolve/flight.js';
import type { Leg } from '../resolve/route.js';
import type { Overlay } from '../resolve/taf.js';
import { upperWindFor } from '../resolve/wind.js';
import { fmtVis } from '../rules/checks.js';
import { metarConditions, OBSERVATION_WINDOW_MS } from '../rules/evaluate.js';
import { HAZARD_TEXT } from '../rules/hazards.js';
import type { Store } from '../store/types.js';

export interface PictureLayer {
  readonly kind: 'layer' | 'vertical-visibility';
  readonly amount: CloudAmount | null;
  readonly type: CloudType | null;
  /** Null when the report gave no height, or the issuing station has no known elevation. */
  readonly baseMsl: number | null;
}

export interface PictureSky {
  readonly layers: readonly PictureLayer[];
  /** As the briefing says it: `>6 SM`. */
  readonly visibility: string | null;
  /** The groups as written in the report: `-SHRA`, `BR`. */
  readonly weather: readonly string[];
}

/** A TEMPO, PROB or BECMG in its window, drawn apart because it is less certain than what prevails. */
export interface PictureOverlay {
  /** `TEMPO`, `PROB30`, `PROB40 TEMPO`, `BECMG`. */
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly sky: PictureSky;
}

export interface PictureReading {
  /** A forecast for the time you pass, or an observation from now. */
  readonly from: 'forecast' | 'observed';
  /** Whose report: its own, or a neighbour's when a named field borrows one. */
  readonly station: string;
  readonly distanceNm: number;
  readonly issuedAt: string | null;
  /** Null for an observation too far from the time you pass to say anything about it. */
  readonly sky: PictureSky | null;
  readonly overlays: readonly PictureOverlay[];
}

export interface PictureStation {
  readonly id: string;
  readonly role: 'departure' | 'via' | 'destination' | 'along';
  readonly lat: number;
  readonly lon: number;
  /** From the departure, along the track, to the point abeam it. */
  readonly nm: number;
  /** Off the track, positive to the right. Zero for the fields the route names. */
  readonly offsetNm: number;
  /** When you pass it: distance over planned speed, the same as every other ETA. */
  readonly at: string;
  readonly elevationFt: number | null;
  readonly reading: PictureReading | null;
}

/** One stretch of the route inside an advisory's area, while it is in force. */
export interface PictureStretch {
  readonly fromNm: number;
  readonly toNm: number;
  readonly fromAt: string;
  readonly toAt: string;
  /** The advisory begins part way along, so this is where it starts rather than where the area does. */
  readonly startsInside: boolean;
  /** Likewise where it ends. */
  readonly endsInside: boolean;
  /** Half way along the stretch: where a map puts the advisory's letter. */
  readonly middle: LatLon;
}

interface PictureHazardBase {
  readonly kind: 'sigmet' | 'airmet';
  /** In words: `mountain wave`. */
  readonly what: string;
  /** `SEV`, `MOD`, as the advisory has it. */
  readonly qualifier: string | null;
  readonly region: string | null;
  readonly baseFt: number | null;
  readonly topFt: number | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
}

export interface PictureHazard extends PictureHazardBase {
  readonly area: readonly LatLon[];
  readonly stretches: readonly PictureStretch[];
}

/** On the route and in force during the flight, but not while you are inside its area. */
export interface PictureHazardMissed extends PictureHazardBase {
  readonly why: 'over-before-you-reach-it' | 'not-begun-when-you-leave-it';
  readonly nm: number;
  /** When you would reach it, or leave it, whichever the reason turns on. */
  readonly at: string;
}

export interface PictureFreezing extends FreezingLevel {
  /** The upper wind site the temperatures are from. */
  readonly station: string;
  readonly nm: number;
  readonly at: string;
  /** How far the site is from this point on the route. */
  readonly distanceNm: number;
}

export interface RoutePicture {
  /** The track as a map draws it: the great circle of each leg, close enough together to follow it. */
  readonly line: readonly LatLon[];
  /** One outline per leg, the strip searched for stations either side of the track. */
  readonly corridor: readonly (readonly LatLon[])[];
  readonly totalNm: number;
  readonly cruiseFt: number;
  readonly tasKt: number;
  /** The named fields and every station beside the track, in the order they are passed. */
  readonly stations: readonly PictureStation[];
  /** The advisories the route is inside while they are in force, the first reached first. */
  readonly hazards: readonly PictureHazard[];
  readonly hazardsMissed: readonly PictureHazardMissed[];
  /** In force during the flight, with an area that cannot be tested against a route. */
  readonly hazardsUntestable: number;
  readonly freezing: readonly PictureFreezing[];
}

function layersOf(sky: readonly Sourced<SkyCondition>[], elevation: number | null): PictureLayer[] {
  return sky.flatMap(({ value: v }): PictureLayer[] => {
    if (v.kind === 'layer') return [{ kind: 'layer', amount: v.amount, type: v.type, baseMsl: v.base === null || elevation === null ? null : v.base + elevation }];
    if (v.kind === 'verticalVisibility') return [{ kind: 'vertical-visibility', amount: null, type: null, baseMsl: v.height === null || elevation === null ? null : v.height + elevation }];
    return [];
  });
}

function skyOf(raw: string, c: Conditions, elevation: number | null): PictureSky {
  return {
    layers: layersOf(c.sky, elevation),
    visibility: c.visibility ? fmtVis(c.visibility.value) : null,
    weather: c.weather.map((w) => sliceSpan(raw, w.span)),
  };
}

const overlayLabel = (o: Overlay): string => (o.probability ? `PROB${o.probability}${o.kind === 'PROB' ? '' : ` ${o.kind}`}` : o.kind);

/** The elevation under a report's heights: its own station's, whoever's column it is drawn in. */
async function elevationOf(store: Store, station: string, own: Airport | null): Promise<number | null> {
  const id = station.toUpperCase();
  if (own && (own.icaoId?.toUpperCase() === id || own.faaId.toUpperCase() === id)) return own.elevation;
  return (await store.getAirport(station))?.elevation ?? null;
}

type Forecast = ResolvedPoint['forecast'];
type Observation = ResolvedPoint['metar'];

/** The forecast for the time you pass when one covers it, the observation otherwise, and nothing when there is neither. */
async function readingOf(store: Store, forecast: Forecast, metar: Observation, passing: Date, own: Airport | null): Promise<PictureReading | null> {
  const prevailing = forecast?.resolved.prevailing;
  if (forecast && prevailing) {
    const raw = forecast.resolved.raw;
    const elevation = await elevationOf(store, forecast.station, own);
    return {
      from: 'forecast',
      station: forecast.station,
      distanceNm: forecast.distance,
      issuedAt: forecast.report.issuedAt?.toISOString() ?? null,
      sky: skyOf(raw, prevailing.conditions, elevation),
      overlays: forecast.resolved.overlays.map((o) => ({
        label: overlayLabel(o),
        from: o.window.from.toISOString(),
        to: o.window.to.toISOString(),
        sky: skyOf(raw, o.conditions, elevation),
      })),
    };
  }
  if (!metar) return null;
  const issued = metar.report.issuedAt;
  const speaksForThen = issued !== null && Math.abs(passing.getTime() - issued.getTime()) <= OBSERVATION_WINDOW_MS;
  const elevation = speaksForThen ? await elevationOf(store, metar.station, own) : null;
  return {
    from: 'observed',
    station: metar.station,
    distanceNm: metar.distance,
    issuedAt: issued?.toISOString() ?? null,
    sky: speaksForThen ? skyOf(metar.report.body, metarConditions(metar.decoded), elevation) : null,
    overlays: [],
  };
}

async function fieldColumn(store: Store, p: ResolvedPoint, index: number, last: number): Promise<PictureStation> {
  const w = p.point.waypoint;
  return {
    id: w.id,
    role: index === 0 ? 'departure' : index === last ? 'destination' : 'via',
    lat: w.position.lat,
    lon: w.position.lon,
    nm: p.point.cumulative,
    offsetNm: 0,
    at: p.point.eta.toISOString(),
    elevationFt: w.airport?.elevation ?? null,
    reading: await readingOf(store, p.forecast, p.metar, p.point.eta, w.airport),
  };
}

async function alongColumn(store: Store, s: EnrouteStation): Promise<PictureStation> {
  return {
    id: s.station,
    role: 'along',
    lat: s.airport.lat,
    lon: s.airport.lon,
    nm: s.cumulative,
    offsetNm: s.offset,
    at: s.eta.toISOString(),
    elevationFt: s.airport.elevation,
    reading: await readingOf(store, s.forecast, s.metar, s.eta, s.airport),
  };
}

/** Every stretch of the route inside an area, in miles along it. Two legs meeting inside the area are one stretch. */
function stretchesInside(flight: ResolvedFlight, area: readonly LatLon[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  flight.route.legs.forEach((leg, i) => {
    const start = flight.route.points[i]!.cumulative;
    for (const part of legInsideArea(leg.from.position, leg.to.position, area)) {
      const from = start + part.from * leg.distance;
      const to = start + part.to * leg.distance;
      const last = out[out.length - 1];
      if (last && Math.abs(last.to - from) < 1e-6) last.to = to;
      else out.push({ from, to });
    }
  });
  return out;
}

/** Where the route is, some distance along it. */
function positionAt(flight: ResolvedFlight, nm: number): LatLon {
  const at = Math.max(0, flight.route.legs.findIndex((_, n) => nm <= flight.route.points[n + 1]!.cumulative));
  const leg = flight.route.legs[at]!;
  return pointAlong(leg.from.position, leg.to.position, nm - flight.route.points[at]!.cumulative);
}

function hazardsOf(flight: ResolvedFlight): Pick<RoutePicture, 'hazards' | 'hazardsMissed' | 'hazardsUntestable'> {
  const departs = flight.route.points[0]!.eta.getTime();
  const tas = flight.plan.cruise.tas;
  const clock = (nm: number) => departs + (nm / tas) * 3_600_000;
  const milesAt = (t: number) => ((t - departs) / 3_600_000) * tas;
  const arrives = clock(flight.route.total);
  const iso = (t: number) => new Date(t).toISOString();

  const hazards: PictureHazard[] = [];
  const hazardsMissed: PictureHazardMissed[] = [];
  let hazardsUntestable = 0;
  for (const { decoded: d } of flight.hazards) {
    const validFrom = d.validFrom?.getTime() ?? -Infinity;
    const validTo = d.validTo?.getTime() ?? Infinity;
    if (validFrom > arrives || validTo < departs) continue;
    if (areaIsTestable(d.area)) {
      hazardsUntestable++;
      continue;
    }
    const inside = stretchesInside(flight, d.area);
    if (inside.length === 0) continue;
    const base: PictureHazardBase = {
      kind: d.kind ?? 'sigmet',
      what: d.hazard ? HAZARD_TEXT[d.hazard] : (d.hazardCode?.value ?? 'a hazard'),
      qualifier: d.qualifier?.value ?? null,
      region: d.region,
      baseFt: d.baseFt,
      topFt: d.topFt,
      validFrom: d.validFrom?.toISOString() ?? null,
      validTo: d.validTo?.toISOString() ?? null,
    };
    const stretches = inside.flatMap((s): PictureStretch[] => {
      const reach = clock(s.from);
      const leave = clock(s.to);
      const from = Math.max(reach, validFrom);
      const to = Math.min(leave, validTo);
      if (from > to) return [];
      return [{ fromNm: milesAt(from), toNm: milesAt(to), fromAt: iso(from), toAt: iso(to), startsInside: from > reach, endsInside: to < leave, middle: positionAt(flight, milesAt((from + to) / 2)) }];
    });
    if (stretches.length > 0) {
      hazards.push({ ...base, area: d.area, stretches });
      continue;
    }
    const first = inside[0]!;
    const last = inside[inside.length - 1]!;
    const over = validTo < clock(first.from);
    hazardsMissed.push({ ...base, why: over ? 'over-before-you-reach-it' : 'not-begun-when-you-leave-it', nm: over ? first.from : last.to, at: iso(clock(over ? first.from : last.to)) });
  }
  return { hazards: hazards.sort((a, b) => a.stretches[0]!.fromNm - b.stretches[0]!.fromNm), hazardsMissed, hazardsUntestable };
}

/**
 * The freezing level wherever there are upper-air temperatures: at each
 * field the route names, from the site its wind came from, and at any
 * station beside the track that is itself an upper wind site. A field's
 * site is left to speak at its own place if it is along the way anyway.
 */
async function freezingOf(store: Store, flight: ResolvedFlight): Promise<PictureFreezing[]> {
  const out: PictureFreezing[] = [];
  const cruise = flight.plan.cruise.altitude;
  const alongside = new Set<string>();
  for (const s of flight.enroute) {
    const found = await upperWindFor(store, s.station, cruise, s.eta, flight.asOf);
    const level = found && freezingLevel(found.forecast.levels);
    if (!level) continue;
    alongside.add(s.station);
    out.push({ ...level, station: s.station, nm: s.cumulative, at: s.eta.toISOString(), distanceNm: Math.abs(s.offset) });
  }
  for (const p of flight.points) {
    const level = p.wind && freezingLevel(p.wind.forecast.levels);
    if (!p.wind || !level || alongside.has(p.wind.station)) continue;
    out.push({ ...level, station: p.wind.station, nm: p.point.cumulative, at: p.point.eta.toISOString(), distanceNm: p.wind.distance });
  }
  return out.sort((a, b) => a.nm - b.nm);
}

/** Near enough together that a line drawn straight between them follows the great circle at any zoom the map allows. */
const LINE_STEP_NM = 25;

function pathOf(leg: Leg): LatLon[] {
  const steps = Math.max(1, Math.ceil(leg.distance / LINE_STEP_NM));
  return Array.from({ length: steps + 1 }, (_, i) => (i === 0 ? leg.from.position : i === steps ? leg.to.position : pointAlong(leg.from.position, leg.to.position, (leg.distance * i) / steps)));
}

/**
 * The strip beside a leg that stations are read from: out to either side,
 * square to the track, and ending at the ends of the leg, because only what
 * lies between them counts as on the way.
 */
function stripOf(leg: Leg): LatLon[] {
  const path = pathOf(leg);
  const courseAt = (i: number): number => (i < path.length - 1 ? initialCourse(path[i]!, path[i + 1]!) : initialCourse(path[i]!, path[i - 1]!) + 180);
  const side = (turn: number) => path.map((p, i) => pointOnCourse(p, courseAt(i) + turn, CORRIDOR_NM));
  return [...side(90), ...side(-90).reverse()];
}

export async function routePicture(store: Store, flight: ResolvedFlight): Promise<RoutePicture> {
  const last = flight.points.length - 1;
  const fields = await Promise.all(flight.points.map((p, i) => fieldColumn(store, p, i, last)));
  const along = await Promise.all(flight.enroute.map((s) => alongColumn(store, s)));
  return {
    line: flight.route.legs.flatMap((leg, i) => (i === 0 ? pathOf(leg) : pathOf(leg).slice(1))),
    corridor: flight.route.legs.map(stripOf),
    totalNm: flight.route.total,
    cruiseFt: flight.plan.cruise.altitude,
    tasKt: flight.plan.cruise.tas,
    stations: [...fields, ...along].sort((a, b) => a.nm - b.nm),
    ...hazardsOf(flight),
    freezing: await freezingOf(store, flight),
  };
}
