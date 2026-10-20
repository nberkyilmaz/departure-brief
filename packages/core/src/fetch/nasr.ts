import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Airport, Runway, RunwayEnd } from '../domain/airport.js';
import { degTrue, feet, type Feet } from '../domain/units.js';
import { parseCsv } from './csv.js';

/**
 * FAA NASR 28-day subscription, CSV distribution. Airports, runways and
 * runway ends from `APT_BASE.csv`, `APT_RWY.csv`, `APT_RWY_END.csv`.
 *
 * Downloading: the per-subject zip for a cycle is at
 * `https://nfdc.faa.gov/webContent/28DaySub/extra/DD_Mon_YYYY_APT_CSV.zip`
 * (e.g. `03_Sep_2026_APT_CSV.zip`, ~8 MB). The server answers HEAD with 503;
 * GET works. Unzip into `data/raw/nasr/<YYYY-MM-DD>/` and run
 * `depbrief nasr <that directory>`.
 *
 * Verified against the 2026-09-03 cycle; the fixture under
 * `test/fixtures/fetch/nasr/` is a verbatim slice of it.
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

/** `2026/09/03` → `2026-09-03`. */
function cycleDate(effDate: string): string {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(effDate.trim());
  if (!m) throw new Error(`unrecognised NASR EFF_DATE: ${effDate}`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** `13` + `W` → -13 (east positive). */
function magneticVariation(deg: string | undefined, hemis: string | undefined): number | null {
  const n = num(deg);
  if (n === null) return null;
  return hemis?.trim() === 'W' ? -n : n;
}

/** The key NASR files share: site number plus site type (an airport and a heliport can share a number). */
const siteKey = (r: Record<string, string>): string => `${r['SITE_NO']}|${r['SITE_TYPE_CODE']}`;

export function parseRunwayEnds(csv: string): Map<string, RunwayEnd[]> {
  const byRunway = new Map<string, RunwayEnd[]>();
  for (const r of parseCsv(csv)) {
    const key = `${siteKey(r)}|${r['RWY_ID']}`;
    const heading = num(r['TRUE_ALIGNMENT']);
    const end: RunwayEnd = {
      id: r['RWY_END_ID'] ?? '',
      trueHeading: heading === null ? null : degTrue(heading),
      lat: num(r['LAT_DECIMAL']),
      lon: num(r['LONG_DECIMAL']),
      elevation: ft(r['RWY_END_ELEV']),
      displacedThreshold: ft(r['DISPLACED_THR_LEN']),
      rightHandPattern: r['RIGHT_HAND_TRAFFIC_PAT_FLAG'] === 'Y',
      ils: str(r['ILS_TYPE']),
      tora: ft(r['TKOF_RUN_AVBL']),
      toda: ft(r['TKOF_DIST_AVBL']),
      asda: ft(r['ACLT_STOP_DIST_AVBL']),
      lda: ft(r['LNDG_DIST_AVBL']),
    };
    const list = byRunway.get(key) ?? [];
    list.push(end);
    byRunway.set(key, list);
  }
  return byRunway;
}

export function parseRunways(csv: string, ends: Map<string, RunwayEnd[]>): Map<string, Runway[]> {
  const bySite = new Map<string, Runway[]>();
  for (const r of parseCsv(csv)) {
    const site = siteKey(r);
    const id = r['RWY_ID'] ?? '';
    const runway: Runway = {
      id,
      length: ft(r['RWY_LEN']),
      width: ft(r['RWY_WIDTH']),
      surface: str(r['SURFACE_TYPE_CODE']),
      condition: str(r['COND']),
      lighting: str(r['RWY_LGT_CODE']),
      ends: ends.get(`${site}|${id}`) ?? [],
    };
    const list = bySite.get(site) ?? [];
    list.push(runway);
    bySite.set(site, list);
  }
  return bySite;
}

export function parseAirports(csv: string, runways: Map<string, Runway[]>): Airport[] {
  const airports: Airport[] = [];
  for (const r of parseCsv(csv)) {
    const lat = num(r['LAT_DECIMAL']);
    const lon = num(r['LONG_DECIMAL']);
    if (lat === null || lon === null) continue;
    airports.push({
      source: 'nasr',
      cycle: cycleDate(r['EFF_DATE'] ?? ''),
      siteNo: r['SITE_NO'] ?? '',
      siteType: r['SITE_TYPE_CODE'] ?? '',
      faaId: r['ARPT_ID'] ?? '',
      icaoId: str(r['ICAO_ID']),
      name: r['ARPT_NAME'] ?? '',
      city: r['CITY'] ?? '',
      state: r['STATE_CODE'] ?? '',
      country: r['COUNTRY_CODE'] ?? '',
      lat,
      lon,
      elevation: ft(r['ELEV']),
      magneticVariation: magneticVariation(r['MAG_VARN'], r['MAG_HEMIS']),
      magneticVariationYear: num(r['MAG_VARN_YEAR']),
      patternAltitude: ft(r['TPA']),
      runways: runways.get(siteKey(r)) ?? [],
    });
  }
  return airports;
}

/** Read one cycle's APT files from a directory. */
export function readNasrDirectory(dir: string): Airport[] {
  const read = (name: string) => readFileSync(join(dir, name), 'utf8');
  const ends = parseRunwayEnds(read('APT_RWY_END.csv'));
  const runways = parseRunways(read('APT_RWY.csv'), ends);
  return parseAirports(read('APT_BASE.csv'), runways);
}
