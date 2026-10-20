import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Airport, Runway, RunwayEnd } from '../domain/airport.js';
import { degTrue, feet, type Feet } from '../domain/units.js';
import { parseCsv } from './csv.js';

/**
 * OurAirports — community-maintained, public-domain (Unlicense) worldwide
 * airport and runway data. The source for everything NASR does not cover,
 * which for this project means Canada. Runway headings are true
 * (`le_heading_degT`); there is no magnetic variation, so `magneticVariation`
 * is `null` — crosswind maths is true-on-true and does not need it.
 *
 * Downloading (two files, ~17 MB total, updated nightly):
 *   https://davidmegginson.github.io/ourairports-data/airports.csv
 *   https://davidmegginson.github.io/ourairports-data/runways.csv
 * into `data/raw/ourairports/<YYYY-MM-DD>/` and run
 * `depbrief ourairports <that directory> [--country CA]`.
 *
 * Verified against the 2026-09-07 snapshot; the fixture under
 * `test/fixtures/fetch/ourairports/` is a verbatim slice of it.
 */

const num = (s: string | undefined): number | null => {
  if (s === undefined || s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const ft = (s: string | undefined): Feet | null => {
  const n = num(s);
  return n === null ? null : feet(n);
};
const str = (s: string | undefined): string | null => (s === undefined || s.trim() === '' ? null : s.trim());

/** OurAirports `type` → the NASR-style site type used across the store. */
const SITE_TYPES: Record<string, string> = {
  small_airport: 'A',
  medium_airport: 'A',
  large_airport: 'A',
  seaplane_base: 'S',
  heliport: 'H',
  balloonport: 'B',
};

export interface OurAirportsOptions {
  /** ISO 3166-1 alpha-2, e.g. `CA`. Omit for the whole world. */
  readonly country?: string;
  /** The snapshot date, used as the `cycle`. */
  readonly snapshot: string;
}

function runwayEnd(r: Record<string, string>, side: 'le' | 'he'): RunwayEnd | null {
  const id = str(r[`${side}_ident`]);
  if (!id) return null;
  const heading = num(r[`${side}_heading_degT`]);
  return {
    id,
    trueHeading: heading === null ? null : degTrue(heading),
    lat: num(r[`${side}_latitude_deg`]),
    lon: num(r[`${side}_longitude_deg`]),
    elevation: ft(r[`${side}_elevation_ft`]),
    displacedThreshold: ft(r[`${side}_displaced_threshold_ft`]),
    rightHandPattern: false,
    ils: null,
    tora: null,
    toda: null,
    asda: null,
    lda: null,
  };
}

export function parseOurAirportsRunways(csv: string): Map<string, Runway[]> {
  const byAirport = new Map<string, Runway[]>();
  for (const r of parseCsv(csv)) {
    if (r['closed'] === '1') continue;
    const ends = [runwayEnd(r, 'le'), runwayEnd(r, 'he')].filter((e): e is RunwayEnd => e !== null);
    const runway: Runway = {
      id: ends.map((e) => e.id).join('/'),
      length: ft(r['length_ft']),
      width: ft(r['width_ft']),
      surface: str(r['surface']),
      condition: null,
      lighting: r['lighted'] === '1' ? 'LIGHTED' : null,
      ends,
    };
    const key = r['airport_ref'] ?? '';
    const list = byAirport.get(key) ?? [];
    list.push(runway);
    byAirport.set(key, list);
  }
  return byAirport;
}

export function parseOurAirports(csv: string, runways: Map<string, Runway[]>, options: OurAirportsOptions): Airport[] {
  const airports: Airport[] = [];
  const country = options.country?.toUpperCase();
  for (const r of parseCsv(csv)) {
    const siteType = SITE_TYPES[r['type'] ?? ''];
    if (!siteType) continue; // closed airports and unknown types
    if (country && r['iso_country'] !== country) continue;
    const lat = num(r['latitude_deg']);
    const lon = num(r['longitude_deg']);
    if (lat === null || lon === null) continue;
    const ident = r['ident'] ?? '';
    // Canadian idents are alphanumeric (`CNC3`); OurAirports' own placeholders (`CA-0123`) are not ICAO-shaped.
    const icao = str(r['icao_code']) ?? (/^[A-Z][A-Z0-9]{3}$/.test(ident) ? ident : null);
    airports.push({
      source: 'ourairports',
      cycle: options.snapshot,
      siteNo: r['id'] ?? '',
      siteType,
      faaId: str(r['local_code']) ?? ident,
      icaoId: icao,
      name: r['name'] ?? '',
      city: r['municipality'] ?? '',
      state: (r['iso_region'] ?? '').replace(/^[A-Z]{2}-/, ''),
      country: r['iso_country'] ?? '',
      lat,
      lon,
      elevation: ft(r['elevation_ft']),
      magneticVariation: null,
      magneticVariationYear: null,
      patternAltitude: null,
      runways: runways.get(r['id'] ?? '') ?? [],
    });
  }
  return airports;
}

/** Read one snapshot's `airports.csv` and `runways.csv` from a directory. */
export function readOurAirportsDirectory(dir: string, options: OurAirportsOptions): Airport[] {
  const read = (name: string) => readFileSync(join(dir, name), 'utf8');
  const runways = parseOurAirportsRunways(read('runways.csv'));
  return parseOurAirports(read('airports.csv'), runways, options);
}
