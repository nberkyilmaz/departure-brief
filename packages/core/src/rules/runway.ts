/**
 * Whether a runway at the field is long enough, by the handbook.
 *
 * Every runway end is read on its own: the handbook's distance to clear
 * 50 ft for the field's pressure altitude and temperature, with the wind
 * along that end and its surface, then your margin on top, against the
 * length that end has. The field is fine when one end fits within your
 * crosswind limit too; otherwise each end says what stopped it.
 *
 * The wind is the forecast's or the observation's, whichever the line is
 * about. A headwind earns nothing, since the forecast wind need not be
 * the one you meet; a tailwind costs what the handbook's note says,
 * worked on the gust when that is the stronger. Temperature and altimeter
 * setting are the latest observation's, at the field or the one borrowed
 * for it, and the line says when that was.
 */
import type { Conditions } from '../decode/conditions.js';
import type { WeatherPhenomenon } from '../decode/groups/weather.js';
import { windKnots } from '../decode/metar/derive.js';
import { sliceSpan, type Span } from '../decode/span.js';
import type { Runway, RunwayEnd } from '../domain/airport.js';
import { toZulu } from '../domain/time.js';
import { pressureAltitudeFt, readDistance, type DistanceCellRef } from '../perf/read.js';
import type { NoteFigure, PerformanceSpec } from '../perf/types.js';
import type { WaypointObservation } from '../resolve/observation.js';
import { profileCitation, weatherText, type CheckContext } from './checks.js';
import { components } from './crosswind.js';
import { ATTENTION_ORDER, type Attention, type Citation, type Finding } from './types.js';

export interface RunwayContext {
  readonly what: 'takeoff' | 'landing';
  readonly handbook: PerformanceSpec;
  /** The latest observation at or near the field, for its temperature and altimeter setting. */
  readonly observation: WaypointObservation | null;
}

/** One runway end, read for this takeoff or landing. */
export interface RunwayDistance {
  readonly runway: string;
  readonly end: string;
  readonly surface: string | null;
  readonly kind: 'paved' | 'grass' | null;
  /** What a takeoff or landing has from this end: the declared distance where one is published, else the length, less a displaced threshold to land. */
  readonly availableFt: number | null;
  readonly declared: boolean;
  /** Along the runway, the worse of the steady wind and the gust: positive is a headwind. Null when the wind is not known. */
  readonly alongKt: number | null;
  readonly crosswindKt: number | null;
  readonly windPercent: number | null;
  readonly grassFt: number | null;
  readonly groundRollFt: number | null;
  /** The handbook's distance to clear 50 ft, corrected for wind and surface. */
  readonly totalFt: number | null;
  /** The same with your margin. */
  readonly neededFt: number | null;
  /**
   * `fits` long enough with your margin and within your crosswind limit;
   * `over` read and not, for the `reasons`; `beyond` past what the handbook
   * prints; `unknown` the record lacks what reading it takes.
   */
  readonly status: 'fits' | 'over' | 'beyond' | 'unknown';
  readonly reasons: readonly ('short' | 'margin' | 'crosswind')[];
  readonly problem: string | null;
}

/*
 * The surface as recorded is free text: 245 spellings across the fields
 * this covers. It is read word by word, and a runway is paved when every
 * word is a paving and grass when every word is a paving or a grass; a
 * mix of the two is read as grass, the longer. Anything else, gravel and
 * dirt and snow and water and misspellings among it, has no figure.
 */
const PAVED: ReadonlySet<string> = new Set(['ASP', 'ASPH', 'ASPHALT', 'CON', 'CONC', 'CONCRETE', 'PEM', 'PAVED', 'GRVD', 'GROOVED']);
const GRASS: ReadonlySet<string> = new Set(['TURF', 'GRS', 'GRASS', 'GRAS', 'SOD']);
/** The FAA's condition after a surface: excellent, good, fair, poor. */
const CONDITION: ReadonlySet<string> = new Set(['E', 'G', 'F', 'P']);

export function surfaceKind(surface: string | null): 'paved' | 'grass' | null {
  if (!surface) return null;
  const words = surface
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter((w) => w !== '' && !CONDITION.has(w));
  if (words.length === 0) return null;
  if (words.every((w) => PAVED.has(w))) return 'paved';
  if (words.every((w) => PAVED.has(w) || GRASS.has(w))) return 'grass';
  return null;
}

/** What falls and leaves a runway wet. Ice crystals do not. */
const PRECIPITATION: ReadonlySet<WeatherPhenomenon> = new Set(['DZ', 'RA', 'SN', 'SG', 'PL', 'GR', 'GS', 'UP']);

const ft = (n: number): string => `${n.toLocaleString('en')} ft`;
const hhmm = (d: Date): string => toZulu(d).slice(11, 16) + 'Z';

type SurfaceWind =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'calm' }
  | { readonly kind: 'variable'; readonly speed: number; readonly gust: number | null }
  | { readonly kind: 'from'; readonly direction: number; readonly speed: number; readonly gust: number | null };

function surfaceWind(c: Conditions): SurfaceWind {
  if (!c.wind) return { kind: 'unknown' };
  const { speed, gust } = windKnots(c.wind.value);
  const direction = c.wind.value.direction;
  if (speed === null || direction === null) return { kind: 'unknown' };
  if (speed === 0 && !gust) return { kind: 'calm' };
  if (direction === 'VRB') return { kind: 'variable', speed, gust };
  return { kind: 'from', direction, speed, gust };
}

/**
 * The wind along and across one end. A variable wind may blow from
 * behind on any of them, so it is a tailwind of its full speed on every
 * end, and its full speed across, as the crosswind check takes it.
 */
function windOn(end: RunwayEnd, wind: SurfaceWind, useGust: boolean): { alongKt: number; crosswindKt: number } | { unknown: true } | null {
  switch (wind.kind) {
    case 'unknown':
      return null;
    case 'calm':
      return { alongKt: 0, crosswindKt: 0 };
    case 'variable':
      return { alongKt: -(wind.gust ?? wind.speed), crosswindKt: useGust && wind.gust !== null ? wind.gust : wind.speed };
    case 'from': {
      if (end.trueHeading === null) return { unknown: true };
      const steady = components(wind.direction as never, wind.speed as never, end.trueHeading);
      const gusting = wind.gust === null ? steady : components(wind.direction as never, wind.gust as never, end.trueHeading);
      return { alongKt: Math.min(steady.headwind, gusting.headwind), crosswindKt: useGust ? gusting.crosswind : steady.crosswind };
    }
  }
}

const unknownEnd = (runway: Runway, end: RunwayEnd, kind: 'paved' | 'grass' | null, availableFt: number | null, declared: boolean, problem: string): RunwayDistance => ({
  runway: runway.id,
  end: end.id,
  surface: runway.surface,
  kind,
  availableFt,
  declared,
  alongKt: null,
  crosswindKt: null,
  windPercent: null,
  grassFt: null,
  groundRollFt: null,
  totalFt: null,
  neededFt: null,
  status: 'unknown',
  reasons: [],
  problem,
});

const louder = (a: Attention, b: Attention): Attention => (ATTENTION_ORDER.indexOf(a) <= ATTENTION_ORDER.indexOf(b) ? a : b);

/** The handbook's corrections to one end's figure, in words: "+15% for 3 kt of tailwind, +117 ft for grass". */
function corrections(r: RunwayDistance): string {
  const parts = [
    r.windPercent ? `+${r.windPercent}% for ${Math.round(-(r.alongKt ?? 0) * 10) / 10} kt of tailwind` : null,
    r.grassFt ? `+${ft(r.grassFt)} for grass` : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? `, ${parts.join(', ')}` : '';
}

/** What one end needs and has, or why it has no figure; without its name, so ends that say the same can share a line. */
function endWords(r: RunwayDistance, margin: number, limit: number): string {
  if (r.status === 'beyond' || r.status === 'unknown') return r.problem!;
  const length = r.reasons.includes('short')
    ? `needs ${ft(r.totalFt!)} by the handbook${corrections(r) ? ` (${corrections(r).slice(2)})` : ''}, has ${ft(r.availableFt!)}`
    : r.reasons.includes('margin')
      ? `needs ${ft(r.neededFt!)} with your ${margin}% margin (${ft(r.totalFt!)} by the handbook${corrections(r)}), has ${ft(r.availableFt!)}`
      : null;
  const across = r.reasons.includes('crosswind') ? `${Math.round(r.crosswindKt!)} kt across, over your ${limit} kt limit` : null;
  return length && across ? `${length}, and ${across}` : (length ?? `${ft(r.availableFt!)} is enough, but ${across}`);
}

/** Ends saying the same thing, said once: "15 and 33: …". */
function byReason(ends: readonly RunwayDistance[], margin: number, limit: number): string {
  const groups = new Map<string, string[]>();
  for (const r of ends) {
    const words = endWords(r, margin, limit);
    groups.set(words, [...(groups.get(words) ?? []), r.end]);
  }
  return [...groups].map(([words, ids]) => `${ids.length > 1 ? `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}` : ids[0]}: ${words}`).join('; ');
}

export function checkRunway(ctx: CheckContext, c: Conditions, rc: RunwayContext): Finding[] {
  const airport = ctx.airport;
  if (!airport) return [];
  const { what, handbook } = rc;
  const table = handbook[what];
  const obs = rc.observation;
  const margin = ctx.profile.runwayMargin;
  const limit = ctx.profile.crosswind;

  const metarCite = (span: Span): Citation => ({
    kind: 'metar',
    station: obs!.station,
    raw: obs!.report.body,
    span,
    text: sliceSpan(obs!.report.body, span),
    sha256: obs!.report.sha256,
  });
  const reportCite = (span: Span): Citation => ({ kind: ctx.source.kind, station: ctx.source.station, raw: ctx.source.raw, span, text: sliceSpan(ctx.source.raw, span), sha256: ctx.source.sha256 });
  const handbookCite = (text: string): Citation => ({ kind: 'aircraft', station: null, raw: null, span: null, text: `${handbook.source.filename} ${text}`, sha256: handbook.source.documentSha256 });
  const page = `p.${table.page} (${table.printedPage})`;
  const unscanned = (scanned: boolean) => (scanned ? '' : ' — read from the page image; the scan does not show it, so check it against your handbook');
  const noteScanned = (n: NoteFigure) => n.scan !== null && n.scan.unconfirmed.length === 0;

  const citations: Citation[] = [];
  if (c.wind) citations.push(reportCite(c.wind.span));

  /*
   * Pressure altitude from the field's elevation and the observation's
   * altimeter setting, as the fuel plan reads its tables; with no setting
   * the elevation is used as it is, and the line says so.
   */
  const elevation = airport.elevation ?? null;
  const temperature = obs?.decoded.temperature?.value.temperature ?? null;
  const altimeter = obs?.decoded.altimeter ?? null;
  const pressureAltitude = elevation === null ? null : (pressureAltitudeFt(elevation, altimeter?.value ?? null) ?? elevation);
  if (obs && temperature !== null) citations.push(metarCite(obs.decoded.temperature!.span));
  if (obs && altimeter && altimeter.value.value !== null) citations.push(metarCite(altimeter.span));
  // With no temperature, the hottest column: every distance is longest there.
  const hottest = table.columnsC[table.columnsC.length - 1]!;
  const tempC = temperature ?? hottest;

  const observedAt = obs?.report.issuedAt ? `${obs.station}, observed ${hhmm(obs.report.issuedAt)}` : (obs?.station ?? null);
  const conditionsWords =
    pressureAltitude === null
      ? ''
      : ` — at ${ft(pressureAltitude)} pressure altitude${
          altimeter && altimeter.value.value !== null ? '' : `, the field's elevation as no altimeter setting was reported`
        }${temperature !== null ? ` and ${temperature} °C (${observedAt})` : `; no temperature reported${obs ? ` by ${obs.station}` : ''}, so read at the table's hottest, ${hottest} °C`}`;

  // Read once at the field's conditions, still air on a paved runway: the printed cell every end starts from.
  const base = pressureAltitude === null ? { problem: `no elevation recorded for ${ctx.waypoint}` } : readDistance(table, what, { pressureAltitudeFt: pressureAltitude, tempC, windKt: 0, surface: 'paved' });
  const cell: DistanceCellRef | null = 'cell' in base ? base.cell : null;
  if (cell) {
    const missed = [cell.scanned.groundRoll ? null : 'ground roll', cell.scanned.total ? null : 'distance to clear 50 ft'].filter((m): m is string => m !== null);
    const check =
      missed.length === 0
        ? ''
        : ` — the ${missed.join(' and the ')} ${missed.length > 1 ? 'are' : 'is'} read from the page image; the scan does not show ${missed.length > 1 ? 'them' : 'it'}, so check ${missed.length > 1 ? 'them' : 'it'} against your handbook`;
    citations.push(
      handbookCite(
        `${page}, ${table.figure}, ${table.weightLb.toLocaleString('en')} lb (${table.conditions.join(', ')}): ${cell.pressureAltitudeFt === 0 ? 'sea level' : ft(cell.pressureAltitudeFt)}, ${cell.columnC} °C: ${ft(cell.groundRollFt)} ground roll, ${ft(cell.totalFt)} to clear 50 ft${check}`,
      ),
    );
  }

  const wind = surfaceWind(c);
  const useGust = ctx.profile.crosswindIncludesGust;
  const runways: RunwayDistance[] = [];
  for (const runway of airport.runways) {
    const kind = surfaceKind(runway.surface);
    for (const end of runway.ends) {
      const declaredFt = what === 'takeoff' ? end.tora : end.lda;
      const displaced = what === 'landing' ? (end.displacedThreshold ?? 0) : 0;
      const availableFt = declaredFt ?? (runway.length === null ? null : runway.length - displaced);
      const declared = declaredFt !== null;
      if (kind === null) {
        const recorded = runway.surface ? `surface "${runway.surface}"` : 'no surface recorded';
        runways.push(unknownEnd(runway, end, kind, availableFt, declared, `${recorded}, and the handbook gives figures for paved and dry grass runways only`));
        continue;
      }
      if (availableFt === null) {
        runways.push(unknownEnd(runway, end, kind, availableFt, declared, 'no length recorded'));
        continue;
      }
      const w = windOn(end, wind, useGust);
      if (w && 'unknown' in w) {
        runways.push(unknownEnd(runway, end, kind, availableFt, declared, 'no heading recorded, so the wind along it is not known'));
        continue;
      }
      const alongKt = w ? w.alongKt : null;
      const crosswindKt = w ? w.crosswindKt : null;
      const read = 'problem' in base ? base : readDistance(table, what, { pressureAltitudeFt: pressureAltitude!, tempC, windKt: Math.min(0, alongKt ?? 0), surface: kind });
      if ('problem' in read) {
        // Past the table is something the handbook says; no elevation to read it at is a gap in the record.
        runways.push({ ...unknownEnd(runway, end, kind, availableFt, declared, read.problem), alongKt, crosswindKt, status: pressureAltitude === null ? 'unknown' : 'beyond' });
        continue;
      }
      const neededFt = Math.ceil(read.totalFt * (1 + margin / 100) - 1e-9);
      const reasons: ('short' | 'margin' | 'crosswind')[] = [];
      if (read.totalFt > availableFt) reasons.push('short');
      else if (neededFt > availableFt) reasons.push('margin');
      if (crosswindKt !== null && crosswindKt > limit) reasons.push('crosswind');
      runways.push({
        runway: runway.id,
        end: end.id,
        surface: runway.surface,
        kind,
        availableFt,
        declared,
        alongKt,
        crosswindKt,
        windPercent: read.windPercent,
        grassFt: read.grassFt,
        groundRollFt: read.groundRollFt,
        totalFt: read.totalFt,
        neededFt,
        status: reasons.length === 0 ? 'fits' : 'over',
        reasons,
        problem: null,
      });
    }
  }
  if (runways.length === 0) return [];

  const fits = runways.filter((r) => r.status === 'fits').sort((a, b) => b.availableFt! - b.neededFt! - (a.availableFt! - a.neededFt!));
  const judged = runways.some((r) => r.status === 'over' || r.status === 'beyond');
  const best = fits[0] ?? null;

  // The handbook's notes behind what was added, each once.
  if (runways.some((r) => (r.windPercent ?? 0) > 0)) citations.push(handbookCite(`${page}, note: "${table.tailwindKtPer10Percent.printed}"${unscanned(noteScanned(table.tailwindKtPer10Percent))}`));
  if (runways.some((r) => (r.grassFt ?? 0) > 0)) citations.push(handbookCite(`${page}, note: "${table.grassPercentOfGroundRoll.printed}"${unscanned(noteScanned(table.grassPercentOfGroundRoll))}`));
  if (table.dashClimbBelowFpm && runways.some((r) => r.problem?.includes('prints no distance'))) {
    citations.push(handbookCite(`${page}, note: "${table.dashClimbBelowFpm.printed}"${unscanned(noteScanned(table.dashClimbBelowFpm))}`));
  }

  // The handbook's figures are for a dry runway, and says nothing of a wet one.
  const falling = c.weather.filter((g) => !g.value.vicinity && g.value.phenomena.some((ph) => PRECIPITATION.has(ph)));
  if (runways.some((r) => r.totalFt !== null)) for (const g of falling) citations.push(reportCite(g.span));
  citations.push({ kind: 'airport', station: airport.icaoId ?? airport.faaId, raw: null, span: null, text: `${airport.source} ${airport.cycle}`, sha256: null }, profileCitation(ctx.profile));

  let attention: Attention = best ? 'routine' : judged ? ctx.violation : 'note';
  // Wet only matters where there is a dry figure to doubt.
  const wet = falling.length > 0 && runways.some((r) => r.totalFt !== null);
  if (wet) attention = louder(attention, ctx.violation === 'alert' ? 'caution' : 'note');

  const fitting = (r: RunwayDistance): string => {
    const how = margin > 0 ? ` with your ${margin}% margin (${ft(r.totalFt!)} by the handbook${corrections(r)})` : ` by the handbook${corrections(r) ? ` (${corrections(r).slice(2)})` : ''}`;
    return `${what} on ${r.end}: ${ft(r.neededFt!)} needed${how}, ${ft(r.availableFt!)} available`;
  };
  // A field that fits still says which of its runways do not, since the wind on the day may put you on one of them.
  const others = runways.filter((r) => r.status === 'over' || r.status === 'beyond');
  let summary = best
    ? `${fitting(best)}${others.length > 0 ? `; ${byReason(others, margin, limit)}` : ''}`
    : judged
      ? `no runway fits your ${what}: ${byReason(runways, margin, limit)}`
      : `no handbook ${what} figure for any runway here: ${byReason(runways, margin, limit)}`;
  summary += conditionsWords;
  if (wind.kind === 'unknown') summary += '; no wind given, so read for still air and crosswind not judged';
  if (wet) {
    const words = [...new Set(falling.map((g) => weatherText(g.value)))].join(', ');
    summary += `; ${words} ${ctx.basisKind === 'observed' ? 'observed' : 'forecast'}, and the handbook's figures are for a dry runway`;
  }

  return [
    {
      rule: `runway.${what}`,
      attention,
      summary,
      waypoint: ctx.waypoint,
      basis: ctx.basis,
      basisKind: ctx.basisKind,
      at: ctx.at.toISOString(),
      values: {
        what,
        elevationFt: elevation,
        pressureAltitudeFt: pressureAltitude,
        altimeterFrom: altimeter && altimeter.value.value !== null ? obs!.station : null,
        tempC: temperature,
        tempFrom: obs && temperature !== null ? { station: obs.station, at: obs.report.issuedAt?.toISOString() ?? null } : null,
        cell: cell ? { pressureAltitudeFt: cell.pressureAltitudeFt, columnC: cell.columnC, groundRollFt: cell.groundRollFt, totalFt: cell.totalFt } : null,
        problem: 'problem' in base ? base.problem : null,
        marginPercent: margin,
        crosswindLimit: limit,
        windKnown: wind.kind !== 'unknown',
        wet: wet ? falling.map((g) => weatherText(g.value)) : [],
        best: best?.end ?? null,
        runways,
      },
      citations,
    },
  ];
}

/** When the aircraft has no tables to read: said once at the field, so nobody takes silence for a runway that fits. */
export function noRunwayHandbook(waypoint: string, at: Date, what: 'takeoff' | 'landing', aircraftType: string): Finding {
  return {
    rule: `runway.${what}`,
    attention: 'note',
    summary: `no handbook ${what} table for the ${aircraftType}, so runway lengths were not checked`,
    waypoint,
    basis: 'aircraft',
    basisKind: 'plan',
    at: at.toISOString(),
    values: { what, runways: [] },
    citations: [{ kind: 'aircraft', station: null, raw: null, span: null, text: aircraftType, sha256: null }],
  };
}
