/**
 * The airspace a route goes through, for the map and the side view.
 *
 * Nothing here is a judgement, and it is kept out of the briefing for the
 * same reason the terrain is: it is a picture to plan with, it arrives from
 * a service that may not answer, and a briefing must not wait for it. The
 * rules still go by the airspace class the pilot states for each field.
 *
 * The FAA writes one record per shape with its own limits, so a Class B is a
 * dozen records of different floors. A limit is feet above sea level, a
 * flight level, or feet above the ground, and the last of those is written
 * as a height "above SFC".
 *
 * Some records say what an area leaves out. Where the limits are real, as
 * with the Class B either side of San Diego's VFR corridor, the record is
 * the airspace that remains and is drawn. A record running from the surface
 * to the surface is the hole itself ("EXCLUDES R-2512") and is not airspace.
 */
import { distanceNm, type LatLon } from '../domain/geo.js';
import { areaIsTestable, legInsideArea } from '../domain/polygon.js';
import type { AirspaceClient, AirspaceRecord } from '../fetch/airspace.js';

/** How far above the cruise to look: the most the side view reaches, and anything higher is not this flight's. */
const ABOVE_CRUISE_FT = 3_000;
/** Two stretches this close together are one that happened to cross a joint in the line. */
const JOIN_NM = 1e-6;

export type AirspaceKind = 'class-b' | 'class-c' | 'class-d' | 'prohibited' | 'restricted' | 'warning' | 'danger' | 'moa' | 'alert';

const CLASS_KINDS: Readonly<Record<string, AirspaceKind>> = { B: 'class-b', C: 'class-c', D: 'class-d' };
const SPECIAL_KINDS: Readonly<Record<string, AirspaceKind>> = { P: 'prohibited', R: 'restricted', W: 'warning', D: 'danger', MOA: 'moa', A: 'alert' };

export interface AirspaceLimit {
  /** In feet of whatever `reference` says, a flight level as feet. `null` when no limit is published. */
  readonly ft: number | null;
  readonly reference: 'surface' | 'msl' | 'agl' | 'fl' | 'none';
  /** The limit is not part of the area: above it, or below it. */
  readonly excluded: boolean;
}

export interface AirspaceStretch {
  readonly fromNm: number;
  readonly toNm: number;
}

export interface AirspaceArea {
  readonly kind: AirspaceKind;
  readonly name: string;
  readonly floor: AirspaceLimit;
  readonly ceiling: AirspaceLimit;
  /** The times of use as published, which say nothing about whether it is in use on the day. */
  readonly hours: string | null;
  /** What the FAA says this shape leaves out. */
  readonly excludes: string | null;
  /** The outline, then any holes. */
  readonly rings: readonly (readonly LatLon[])[];
  /** Where the line is inside it, first reached first. */
  readonly stretches: readonly AirspaceStretch[];
}

export interface RouteAirspace {
  /** Those the line goes through, first reached first. */
  readonly areas: readonly AirspaceArea[];
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' && v !== '<Null>' ? v.trim() : null);

function limitOf(p: Readonly<Record<string, unknown>>, side: 'LOWER' | 'UPPER'): AirspaceLimit {
  const raw = p[`${side}_VAL`];
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  const code = p[`${side}_CODE`];
  const excluded = p[`${side}_DESC`] === 'ANI' || p[`${side}_DESC`] === 'TNI';
  // -9998 is the FAA's way of writing that there is no number.
  if (!Number.isFinite(value) || value < 0 || code === 'UNLTD') return { ft: null, reference: 'none', excluded: false };
  if (p[`${side}_UOM`] === 'FL') return { ft: value * 100, reference: 'fl', excluded };
  if (code === 'SFC') return value === 0 ? { ft: 0, reference: 'surface', excluded: false } : { ft: value, reference: 'agl', excluded };
  return code === 'MSL' ? { ft: value, reference: 'msl', excluded } : { ft: null, reference: 'none', excluded: false };
}

/** What is left of some stretches of a leg once others are taken out. */
function without(kept: readonly { from: number; to: number }[], hole: readonly { from: number; to: number }[]): { from: number; to: number }[] {
  return hole.reduce<{ from: number; to: number }[]>(
    (left, cut) => left.flatMap((s) => [...(cut.from > s.from ? [{ from: s.from, to: Math.min(s.to, cut.from) }] : []), ...(cut.to < s.to ? [{ from: Math.max(s.from, cut.to), to: s.to }] : [])]),
    [...kept],
  );
}

function stretchesAlong(line: readonly LatLon[], miles: readonly number[], rings: readonly (readonly LatLon[])[]): AirspaceStretch[] {
  const [outline, ...holes] = rings;
  const out: { fromNm: number; toNm: number }[] = [];
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1]!, line[i]!];
    const length = miles[i]! - miles[i - 1]!;
    const inside = holes.reduce((left, hole) => without(left, legInsideArea(a, b, hole)), legInsideArea(a, b, outline!));
    for (const s of inside) {
      const fromNm = miles[i - 1]! + s.from * length;
      const toNm = miles[i - 1]! + s.to * length;
      const last = out[out.length - 1];
      if (last && Math.abs(last.toNm - fromNm) < JOIN_NM) last.toNm = toNm;
      else out.push({ fromNm, toNm });
    }
  }
  return out;
}

function areaOf(record: AirspaceRecord, kind: AirspaceKind | undefined, hours: string | null, line: readonly LatLon[], miles: readonly number[], cruiseFt: number): AirspaceArea | null {
  const { properties: p, rings } = record;
  const name = text(p['NAME']);
  if (!kind || !name || !rings[0] || areaIsTestable(rings[0])) return null;
  const floor = limitOf(p, 'LOWER');
  const ceiling = limitOf(p, 'UPPER');
  if (ceiling.reference === 'surface' || (floor.ft ?? 0) > cruiseFt + ABOVE_CRUISE_FT) return null;
  const stretches = stretchesAlong(line, miles, rings);
  if (stretches.length === 0) return null;
  const remark = text(p['REMARKS']);
  return { kind, name, floor, ceiling, hours, excludes: remark && /^EXCLUD/i.test(remark) ? remark : null, rings, stretches };
}

/** The times of use as written, without the marks the FAA leaves in them for its own line breaks. */
const specialHours = (p: Readonly<Record<string, unknown>>): string | null => text(p['TIMESOFUSE'])?.replace(/\s*%\s*/g, ' ').replace(/\s+/g, ' ') ?? null;

/** A Class D is often only there while its tower is open, and the shape says only that a NOTAM sets when. */
function classHours(p: Readonly<Record<string, unknown>>): string | null {
  if (p['WKHR_CODE'] === 'NOTAM') return 'BY NOTAM';
  const remark = text(p['WKHR_RMK']);
  return p['WKHR_CODE'] === 'RMK' && remark !== 'Continuous' ? remark : null;
}

export async function routeAirspace(client: AirspaceClient, line: readonly LatLon[], cruiseFt: number): Promise<RouteAirspace> {
  const { classes, specialUse } = await client.along(line);
  const miles = line.reduce<number[]>((sum, p, i) => [...sum, i === 0 ? 0 : sum[i - 1]! + (distanceNm(line[i - 1]!, p) as number)], []);
  const areas = [
    ...classes.map((r) => areaOf(r, CLASS_KINDS[String(r.properties['CLASS'])], classHours(r.properties), line, miles, cruiseFt)),
    ...specialUse.map((r) => areaOf(r, SPECIAL_KINDS[String(r.properties['TYPE_CODE'])], specialHours(r.properties), line, miles, cruiseFt)),
  ].filter((a): a is AirspaceArea => a !== null);
  return { areas: areas.sort((a, b) => a.stretches[0]!.fromNm - b.stretches[0]!.fromNm) };
}
