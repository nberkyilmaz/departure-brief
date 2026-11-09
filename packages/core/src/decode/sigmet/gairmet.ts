/**
 * American AIRMETs, which are graphical now: the G-AIRMET.
 *
 * The AWC's cache file holds every one in force as XML, a record per area
 * per forecast hour. It is read by pattern for the reason the TAF cache is:
 * a published schema, and no XML parser in a package that also runs in a
 * browser. The CSV of the same file has no altitudes or severity in it.
 *
 * A record does not describe a stretch of time. It is a picture of where the
 * hazard is forecast at one instant, with the next picture three hours on,
 * so the part of the day it speaks for is half way to its neighbours either
 * side. Heights are in feet and written four ways: a number, `SFC`, `FZL`
 * for "starting at the freezing level", and `null00` or `-1` for none given.
 */
import type { LatLon } from '../../domain/geo.js';
import { sourced, type Sourced } from '../span.js';
import type { DecodedSigmet, SigmetHazard } from './types.js';

/** Half of the three hours between one picture and the next. */
export const GAIRMET_HALF_WINDOW_MS = 90 * 60_000;

const HAZARDS: Readonly<Record<string, SigmetHazard>> = {
  ICE: 'icing',
  IFR: 'ifr',
  MT_OBSC: 'mountain-obscuration',
  'TURB-LO': 'turbulence',
  'TURB-HI': 'turbulence',
  LLWS: 'low-level-wind-shear',
  SFC_WND: 'surface-wind',
};

const child = (raw: string, name: string): string | null => new RegExp(`<${name}>([^<]*)</${name}>`).exec(raw)?.[1] ?? null;
const instant = (text: string | null): Date | null => {
  const d = text ? new Date(text) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};
const feet = (text: string | null | undefined): number | null => (text && /^\d+$/.test(text) ? Number(text) : null);

export function decodeGairmet(raw: string): DecodedSigmet {
  const unparsed: string[] = [];
  const hazardTag = /<hazard type="([^"]*)" severity="([^"]*)"\/>/.exec(raw);
  const code = hazardTag?.[1] ?? null;
  const hazard = code ? (HAZARDS[code] ?? null) : null;
  if (code && !hazard) unparsed.push(`hazard ${code}`);

  const valueSpan = (value: string, from: number): Sourced<string> => {
    const start = raw.indexOf(`"${value}"`, from) + 1;
    return sourced(value, { start, end: start + value.length });
  };
  const hazardCode = hazardTag && code ? valueSpan(code, hazardTag.index) : null;
  const severity = hazardTag?.[2] ?? '';
  const qualifier = hazardTag && severity !== '' ? valueSpan(severity, hazardTag.index + hazardTag[0].indexOf('severity=')) : null;

  const altitude = /<altitude min_ft_msl="([^"]*)" max_ft_msl="([^"]*)"\/>/.exec(raw);
  // "From the freezing level" comes with the range that level is forecast in; the lowest of it is the cautious reading.
  const lowestFreezing = feet(/<fzl_altitude><min_ft_msl>([^<]*)</.exec(raw)?.[1]);
  const baseFt = altitude?.[1] === 'SFC' ? 0 : altitude?.[1] === 'FZL' ? lowestFreezing : feet(altitude?.[1]);

  const area: LatLon[] = [];
  for (const point of raw.matchAll(/<longitude>([^<]*)<\/longitude><latitude>([^<]*)<\/latitude>/g)) {
    const lat = Number(point[2]);
    const lon = Number(point[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) unparsed.push(point[0]);
    else area.push({ lat, lon });
  }

  const snapshotAt = instant(child(raw, 'valid_time'));
  if (!snapshotAt) unparsed.push('valid_time');
  const product = child(raw, 'product');
  const tag = child(raw, 'tag');
  return {
    kind: 'airmet',
    hazard,
    hazardCode,
    qualifier,
    baseFt,
    topFt: feet(altitude?.[2]),
    validFrom: snapshotAt && new Date(snapshotAt.getTime() - GAIRMET_HALF_WINDOW_MS),
    validTo: snapshotAt && new Date(snapshotAt.getTime() + GAIRMET_HALF_WINDOW_MS),
    region: null,
    regionName: null,
    series: product && tag ? `${product} ${tag}` : product,
    bulletin: null,
    area,
    snapshotAt,
    dueTo: hazard === 'ifr' || hazard === 'mountain-obscuration' ? child(raw, 'due_to') : null,
    unparsed,
  };
}
