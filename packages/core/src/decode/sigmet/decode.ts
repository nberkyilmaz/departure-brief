/**
 * SIGMETs and AIRMETs as the weather service serves them.
 *
 * The bulletin itself is in the record, and it is what a pilot reads — but
 * the area in a bulletin is written as "WI N7800 E11445 - N7249 E11309 -
 * …", and the service has already turned that into coordinates. Re-parsing
 * the text to arrive at numbers it has published would be inventing a
 * second opinion about the same thing, so the record is what is stored and
 * the bulletin travels inside it, quoted verbatim in the decoded result.
 *
 * Two shapes come out of the same service: international SIGMETs and the
 * American domestic ones, which name their fields differently. Both are
 * read here into one shape, because a hazard is a hazard.
 */
import { sourced, type Sourced } from '../span.js';
import type { DecodedSigmet, SigmetHazard } from './types.js';

export const SIGMET_DECODER_VERSION = 1;

/** The hazards these products carry, normalised across the two shapes. */
const HAZARDS: Readonly<Record<string, SigmetHazard>> = {
  TS: 'thunderstorm',
  CONVECTIVE: 'thunderstorm',
  TURB: 'turbulence',
  ICE: 'icing',
  ICING: 'icing',
  MTW: 'mountain-wave',
  VA: 'volcanic-ash',
  TC: 'tropical-cyclone',
  IFR: 'ifr',
  'MTN OBSCN': 'mountain-obscuration',
  LLWS: 'low-level-wind-shear',
};

const numberOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Seconds since the epoch, as the service sends validity. */
function instant(v: unknown): Date | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v * 1000);
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Where a value sits in the record, so a finding can point at it. */
function spanOf(raw: string, value: unknown): Sourced<string> | null {
  if (typeof value !== 'string' || value === '') return null;
  const needle = JSON.stringify(value);
  const at = raw.indexOf(needle);
  return at === -1 ? null : sourced(value, { start: at, end: at + needle.length });
}

interface Record_ {
  readonly hazard?: unknown;
  readonly qualifier?: unknown;
  readonly severity?: unknown;
  readonly airSigmetType?: unknown;
  readonly base?: unknown;
  readonly top?: unknown;
  readonly altitudeLow1?: unknown;
  readonly altitudeHi1?: unknown;
  readonly validTimeFrom?: unknown;
  readonly validTimeTo?: unknown;
  readonly firId?: unknown;
  readonly firName?: unknown;
  readonly icaoId?: unknown;
  readonly seriesId?: unknown;
  readonly rawSigmet?: unknown;
  readonly rawAirSigmet?: unknown;
  readonly coords?: unknown;
}

/**
 * Decode one record. `raw` is the record exactly as the service sent it,
 * which is what the store holds and what the spans index into.
 */
export function decodeSigmet(raw: string): DecodedSigmet {
  const empty: DecodedSigmet = {
    kind: null,
    hazard: null,
    hazardCode: null,
    qualifier: null,
    baseFt: null,
    topFt: null,
    validFrom: null,
    validTo: null,
    region: null,
    regionName: null,
    series: null,
    bulletin: null,
    area: [],
    unparsed: [raw],
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
  const r = parsed as Record_;

  const unparsed: string[] = [];
  const code = typeof r.hazard === 'string' ? r.hazard.toUpperCase() : null;
  const hazard = code ? (HAZARDS[code] ?? null) : null;
  if (code && !hazard) unparsed.push(`hazard ${code}`);

  const coords = Array.isArray(r.coords) ? r.coords : [];
  const area: { lat: number; lon: number }[] = [];
  for (const c of coords) {
    const lat = numberOrNull((c as { lat?: unknown })?.lat);
    const lon = numberOrNull((c as { lon?: unknown })?.lon);
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      unparsed.push(JSON.stringify(c));
      continue;
    }
    area.push({ lat, lon });
  }

  /*
   * An AIRMET is advice; a SIGMET is a warning. The international feed says
   * so only in the bulletin's own header, so it is taken from there when
   * the domestic field is absent.
   */
  const bulletinText = typeof r.rawSigmet === 'string' ? r.rawSigmet : typeof r.rawAirSigmet === 'string' ? r.rawAirSigmet : null;
  const declared = typeof r.airSigmetType === 'string' ? r.airSigmetType.toUpperCase() : null;
  const kind = declared === 'AIRMET' || (declared === null && /\bAIRMET\b/.test(bulletinText ?? '')) ? 'airmet' : 'sigmet';

  return {
    kind,
    hazard,
    hazardCode: code ? spanOf(raw, r.hazard) : null,
    qualifier: typeof r.qualifier === 'string' ? spanOf(raw, r.qualifier) : null,
    // The international feed calls them base and top; the domestic one
    // numbers them, and only the first pair describes the whole area.
    baseFt: numberOrNull(r.base) ?? numberOrNull(r.altitudeLow1),
    topFt: numberOrNull(r.top) ?? numberOrNull(r.altitudeHi1),
    validFrom: instant(r.validTimeFrom),
    validTo: instant(r.validTimeTo),
    region: typeof r.firId === 'string' ? r.firId : typeof r.icaoId === 'string' ? r.icaoId : null,
    regionName: typeof r.firName === 'string' ? r.firName : null,
    series: typeof r.seriesId === 'string' ? r.seriesId : null,
    bulletin: bulletinText === null ? null : spanOf(raw, bulletinText),
    area,
    unparsed,
  };
}
