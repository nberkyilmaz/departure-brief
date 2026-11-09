/**
 * Pilot reports as the AWC's cache file carries them.
 *
 * A PIREP is a line of slashed groups somebody typed in a hurry:
 *
 *   ITH UA /OV ITH210045/TM 0522/FL095/TP S22T/TA M07/IC MOD RIME
 *
 * The service has already worked out where ITH210045 is and split the groups
 * into fields. Those are what is read here, for the reason the SIGMET area
 * is: free text is where a second parser would be wrong in new ways. The
 * fields do lose things, a turbulence report written `/TB LGT-250-220` has
 * none at all, so the line itself travels with them and is always shown.
 *
 * The one correction is the height. A report saying `/FLUNKN`, or only that
 * it was climbing or descending, is filed at 0 ft, and that is not the
 * ground.
 */
import { sourced, type Sourced } from '../span.js';
import type { DecodedPirep } from './types.js';

export const PIREP_DECODER_VERSION = 1;

const child = (raw: string, name: string): string | null => new RegExp(`<${name}>([^<]*)</${name}>`).exec(raw)?.[1] ?? null;
const tagsOf = (raw: string, name: string): string[] => [...raw.matchAll(new RegExp(`<${name}\\b[^>]*/>`, 'g'))].map((m) => m[0]);
const attr = (tag: string, name: string): string | null => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
const feet = (text: string | null): number | null => (text && /^\d+$/.test(text) ? Number(text) : null);

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescaped = (text: string): string => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ENTITIES[name]!);

function textOf(raw: string): Sourced<string> | null {
  const open = '<raw_text>';
  const m = /<raw_text>([^<]*)<\/raw_text>/.exec(raw);
  if (!m || m[1]!.trim() === '') return null;
  const lead = m[1]!.length - m[1]!.trimStart().length;
  const start = m.index + open.length + lead;
  return sourced(unescaped(m[1]!.trim()), { start, end: start + m[1]!.trim().length });
}

export function decodePirep(raw: string): DecodedPirep {
  const unparsed: string[] = [];
  const text = textOf(raw);
  if (!text) unparsed.push('raw_text');

  const lat = Number(child(raw, 'latitude') ?? NaN);
  const lon = Number(child(raw, 'longitude') ?? NaN);
  const placed = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  if (!placed) unparsed.push('position');

  const level = /\/FL\s*([A-Z0-9-]+)/.exec(text?.value ?? '')?.[1] ?? null;
  const noHeight = level !== null && /^(UNKN|DUR)/.test(level);
  const given = noHeight ? null : feet(child(raw, 'altitude_ft_msl'));
  const temp = child(raw, 'temp_c');

  return {
    text,
    position: placed ? { lat, lon } : null,
    // No flight level in the line at all, and filed at 0, is the same thing.
    altitudeFt: given === 0 && level === null ? null : given,
    phase: level === 'DURC' ? 'climbing' : level === 'DURD' ? 'descending' : null,
    aircraft: child(raw, 'aircraft_ref'),
    urgent: /^\S+\s+UUA\b/.test(text?.value ?? '') || child(raw, 'report_type') === 'Urgent PIREP',
    tempC: temp !== null && Number.isFinite(Number(temp)) ? Number(temp) : null,
    clouds: tagsOf(raw, 'sky_condition').map((t) => ({ cover: attr(t, 'sky_cover'), baseFt: feet(attr(t, 'cloud_base_ft_msl')), topFt: feet(attr(t, 'cloud_top_ft_msl')) })),
    turbulence: tagsOf(raw, 'turbulence_condition').map((t) => ({
      intensity: attr(t, 'turbulence_intensity'),
      type: attr(t, 'turbulence_type'),
      frequency: attr(t, 'turbulence_freq'),
      baseFt: feet(attr(t, 'turbulence_base_ft_msl')),
      topFt: feet(attr(t, 'turbulence_top_ft_msl')),
    })),
    icing: tagsOf(raw, 'icing_condition').map((t) => ({ intensity: attr(t, 'icing_intensity'), type: attr(t, 'icing_type'), baseFt: feet(attr(t, 'icing_base_ft_msl')), topFt: feet(attr(t, 'icing_top_ft_msl')) })),
    unparsed,
  };
}
