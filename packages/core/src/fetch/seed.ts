/**
 * Put airport data into an empty store, over the network, without anybody
 * being at a keyboard.
 *
 * Every other way into the airports table needs a person: download two CSVs,
 * put them in a directory, run `depbrief ourairports <dir>`. That is fine
 * on a laptop and impossible on a host — a deployed instance starts with an
 * empty database and no shell, and every briefing it is asked for fails to
 * resolve its first waypoint. The airports table is not a cache that fills
 * itself as it is used, either: a briefing needs the field's position before
 * it can ask anything about it, so an empty table is not slow, it is broken.
 *
 * So: on boot, if the store holds no airports, fetch the snapshot and load
 * it. Once, into a persistent database. If it fails the instance still
 * serves — it says what is missing and why, which is more use than a process
 * that will not start.
 */
import type { Airport } from '../domain/airport.js';
import type { AirportStore } from '../store/types.js';
import type { HttpClient } from './http.js';
import { parseOurAirports, parseOurAirportsRunways } from './ourairports.js';

/**
 * Where the snapshot comes from: the OurAirports project's own nightly
 * publication of its database, public domain, no key and no terms to accept.
 */
export const OURAIRPORTS_BASE = 'https://davidmegginson.github.io/ourairports-data';

/**
 * What a hosted instance loads. Canada because that is the jurisdiction this
 * tool is about, and the United States because a Canadian field near the
 * border borrows its weather from across it — CYSN reads KIAG when St.
 * Catharines has gone quiet, and it cannot do that for a field it has never
 * heard of. Together about 26,000 aerodromes; the whole world is 80,000 and
 * most of it is of no use to a Cessna in Ontario.
 */
export const SEED_COUNTRIES: readonly string[] = ['CA', 'US'];

export type SeedState =
  /** The store already held airports; nothing was fetched. */
  | 'present'
  /** Fetched and loaded during this call. */
  | 'loaded'
  /** Nothing was loaded, and `reason` says what went wrong. */
  | 'failed';

export interface SeedResult {
  readonly state: SeedState;
  readonly inserted: number;
  /** The snapshot loaded or already present, when known. */
  readonly snapshot: string | null;
  /** Why the store has no airport data, in words a log line can carry. */
  readonly reason: string | null;
}

export interface SeedOptions {
  /** ISO 3166-1 alpha-2 codes; omit for {@link SEED_COUNTRIES}. */
  readonly countries?: readonly string[];
  readonly base?: string;
  /** Used for the snapshot label when the server sends no `last-modified`. */
  readonly now?: () => Date;
  /** Progress, for a boot log. Called with a sentence, not a format string. */
  readonly onProgress?: (message: string) => void;
}

/** A store that can say whether it has been loaded, which is all seeding needs. */
export type SeedStore = Pick<AirportStore, 'countAirports' | 'putAirports'>;

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * The snapshot label. OurAirports publishes no version inside the files, so
 * the date the server last changed them is the best available answer, and
 * the date it was fetched is the fallback. It matters because `cycle` is
 * part of the airports table's key: two loads labelled the same date are the
 * same snapshot and the second is a no-op, which is the behaviour wanted.
 */
function snapshotOf(headers: Readonly<Record<string, string>>, now: Date): string {
  const modified = headers['last-modified'];
  if (modified !== undefined) {
    const parsed = new Date(modified);
    if (!Number.isNaN(parsed.getTime())) return isoDate(parsed);
  }
  return isoDate(now);
}

/**
 * Download one country's slice of the current OurAirports snapshot.
 *
 * Both files are fetched whole — they are published as two CSVs and there is
 * no per-country endpoint — and filtered here. About 17 MB over the wire,
 * once per database.
 */
export async function downloadOurAirports(
  http: HttpClient,
  options: SeedOptions = {},
): Promise<{ airports: Airport[]; snapshot: string }> {
  const base = options.base ?? OURAIRPORTS_BASE;
  const now = options.now?.() ?? new Date();
  const countries = options.countries ?? SEED_COUNTRIES;

  options.onProgress?.(`fetching ${base}/runways.csv`);
  const runwaysResponse = await http.get(`${base}/runways.csv`);
  options.onProgress?.(`fetching ${base}/airports.csv`);
  const airportsResponse = await http.get(`${base}/airports.csv`);

  const snapshot = snapshotOf(airportsResponse.headers, now);
  const runways = parseOurAirportsRunways(runwaysResponse.body);
  const airports: Airport[] = [];
  for (const country of countries) {
    airports.push(...parseOurAirports(airportsResponse.body, runways, { snapshot, country }));
  }
  return { airports, snapshot };
}

/**
 * Load the airport snapshot if the store has none.
 *
 * Never replaces what is there. A store with airports in it was loaded
 * deliberately — an NASR cycle, a curated set, a snapshot from last week —
 * and quietly fetching over that on every restart would be both a surprise
 * and 17 MB a time.
 */
export async function ensureAirportData(store: SeedStore, http: HttpClient, options: SeedOptions = {}): Promise<SeedResult> {
  const held = await store.countAirports();
  if (held > 0) {
    return { state: 'present', inserted: 0, snapshot: null, reason: null };
  }

  options.onProgress?.('no airport data in the store; loading the OurAirports snapshot');
  let airports: Airport[];
  let snapshot: string;
  try {
    ({ airports, snapshot } = await downloadOurAirports(http, options));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { state: 'failed', inserted: 0, snapshot: null, reason: `could not download the airport snapshot: ${reason}` };
  }

  if (airports.length === 0) {
    return { state: 'failed', inserted: 0, snapshot, reason: 'the airport snapshot parsed to nothing, which means its format has changed' };
  }

  options.onProgress?.(`loading ${airports.length.toLocaleString('en')} aerodromes from the ${snapshot} snapshot`);
  try {
    const { inserted } = await store.putAirports(airports, options.now?.() ?? new Date());
    return { state: 'loaded', inserted, snapshot, reason: null };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { state: 'failed', inserted: 0, snapshot, reason: `could not write the airport snapshot: ${reason}` };
  }
}
