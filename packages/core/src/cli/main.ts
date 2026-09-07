/**
 * holdshort — the terminal entry point.
 *
 *   holdshort fetch KJFK [KTEB ...] [--memory]   fetch, store and decode METAR/TAF (and NOTAMs with credentials)
 *   holdshort nasr <dir>                          load one NASR cycle's APT CSV files into the store
 *   holdshort ourairports <dir> [--country CA]    load an OurAirports snapshot (airports.csv + runways.csv)
 *   holdshort airport KJFK                        print a stored airport with its runways
 *   holdshort resolve <flight.json> [--fetch] [--as-of <ISO>] [--json]
 *                                                 conditions at each waypoint at its ETA
 *   holdshort brief <flight.json> [--fetch] [--as-of <ISO>] [--json]
 *                                                 go / marginal / no-go per waypoint, every finding cited
 *   holdshort decode "<METAR or TAF text>"         print the decoded JSON
 *
 * Reads `.env` if present. Uses Postgres at DATABASE_URL (default: the
 * Compose database) unless `--memory` is given.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { decodeMetar } from '../decode/metar/index.js';
import { parseFlightPlan, type FlightPlan } from '../domain/flight.js';
import { parseAircraftLimits, parsePilotProfile } from '../domain/profile.js';
import { briefingText } from '../rules/describe.js';
import { evaluateFlight } from '../rules/evaluate.js';
import { flightText } from '../resolve/describe.js';
import { resolveFlight } from '../resolve/flight.js';
import { decodeTaf } from '../decode/taf/index.js';
import { AwcClient } from '../fetch/awc.js';
import { createHttpClient } from '../fetch/http.js';
import { ingestStation, type IngestCounts } from '../fetch/ingest.js';
import { readNasrDirectory } from '../fetch/nasr.js';
import { readOurAirportsDirectory } from '../fetch/ourairports.js';
import { FaaNotamClient } from '../fetch/notam.js';
import { MemoryStore } from '../store/memory.js';
import { PostgresStore } from '../store/postgres.js';
import type { Store } from '../store/types.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const USER_AGENT = process.env.HOLDSHORT_USER_AGENT ?? 'holdshort/0.1 (+https://github.com/holdshort)';

function usage(): never {
  console.error(
    'usage: holdshort fetch <ICAO...> [--memory] | holdshort nasr <dir> | holdshort ourairports <dir> [--country XX] | holdshort airport <id> | holdshort resolve|brief <flight.json> [--fetch] [--as-of <ISO>] [--json] | holdshort decode "<report>"',
  );
  process.exit(2);
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function makeAwc() {
  const http = createHttpClient({
    userAgent: USER_AGENT,
    cache: process.env.HOLDSHORT_HTTP_CACHE ? { dir: process.env.HOLDSHORT_HTTP_CACHE, ttlMs: 5 * 60_000 } : null,
  });
  return new AwcClient(http);
}

async function openStore(args: string[]): Promise<Store> {
  return args.includes('--memory') ? new MemoryStore() : PostgresStore.connect();
}

function counts(label: string, c: IngestCounts | null): string {
  if (!c) return `${label}: skipped (no credentials)`;
  return `${label}: fetched ${c.fetched}, new ${c.rawInserted}, decoded ${c.decodedInserted}`;
}

async function fetchCommand(args: string[]): Promise<void> {
  const stations = args.filter((a) => !a.startsWith('--'));
  if (stations.length === 0) usage();

  const store = await openStore(args);
  const awc = makeAwc();
  const http = createHttpClient({ userAgent: USER_AGENT });
  const notam =
    process.env.FAA_NOTAM_CLIENT_ID && process.env.FAA_NOTAM_CLIENT_SECRET
      ? new FaaNotamClient(http, {
          clientId: process.env.FAA_NOTAM_CLIENT_ID,
          clientSecret: process.env.FAA_NOTAM_CLIENT_SECRET,
        })
      : null;

  try {
    for (const station of stations) {
      const r = await ingestStation({ store, awc, notam }, station);
      console.log(`${r.station}  ${counts('METAR', r.metar)}  ${counts('TAF', r.taf)}  ${counts('NOTAM', r.notam)}`);
    }
  } finally {
    await store.close();
  }
}

async function nasrCommand(args: string[]): Promise<void> {
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) usage();
  const airports = readNasrDirectory(dir);
  const store = await openStore(args);
  try {
    const { inserted } = await store.putAirports(airports, new Date());
    console.log(`${airports.length} airports in ${airports[0]?.cycle ?? '?'} cycle, ${inserted} new`);
  } finally {
    await store.close();
  }
}

async function ourairportsCommand(args: string[]): Promise<void> {
  const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--country');
  if (!dir) usage();
  const snapshot = /(\d{4}-\d{2}-\d{2})/.exec(dir)?.[1] ?? new Date().toISOString().slice(0, 10);
  const country = option(args, '--country');
  const airports = readOurAirportsDirectory(dir, country ? { snapshot, country } : { snapshot });
  const store = await openStore(args);
  try {
    const { inserted } = await store.putAirports(airports, new Date());
    console.log(`${airports.length} airports${country ? ` in ${country.toUpperCase()}` : ''} from OurAirports ${snapshot}, ${inserted} new`);
  } finally {
    await store.close();
  }
}

async function airportCommand(args: string[]): Promise<void> {
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) usage();
  const store = await openStore(args);
  try {
    const airport = await store.getAirport(id);
    if (!airport) {
      console.error(`no airport ${id.toUpperCase()} in the store (run: holdshort nasr <dir> or holdshort ourairports <dir>)`);
      process.exit(1);
    }
    console.log(JSON.stringify(airport, null, 2));
  } finally {
    await store.close();
  }
}

/** Read the plan and, optionally fetching first, resolve it as of the requested instant. */
async function loadAndResolve(args: string[]) {
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--as-of');
  if (!file) usage();
  const plan = parseFlightPlan(JSON.parse(readFileSync(file, 'utf8')));
  const asOfText = option(args, '--as-of');
  const asOf = asOfText ? new Date(asOfText) : new Date();
  if (Number.isNaN(asOf.getTime())) usage();
  const store = await openStore(args);
  try {
    if (args.includes('--fetch')) {
      const awc = makeAwc();
      const ids = [plan.departure, ...plan.route, plan.destination, plan.alternate].filter(
        (s): s is string => s !== null && /^[A-Z0-9]{3,4}$/.test(s),
      );
      for (const id of ids) await ingestStation({ store, awc }, id);
    }
    return { file, plan, resolved: await resolveFlight(store, plan, asOf) };
  } finally {
    await store.close();
  }
}

async function resolveCommand(args: string[]): Promise<void> {
  const { resolved } = await loadAndResolve(args);
  console.log(args.includes('--json') ? JSON.stringify(resolved, null, 2) : flightText(resolved));
}

function readJsonRelative(planFile: string, path: string | null, fallback: string): unknown {
  const target = path ? resolvePath(dirname(planFile), path) : fallback;
  if (!existsSync(target)) throw new Error(`file not found: ${target}`);
  return JSON.parse(readFileSync(target, 'utf8'));
}

async function briefCommand(args: string[]): Promise<void> {
  const { file, plan, resolved } = await loadAndResolve(args);
  const profile = parsePilotProfile(readJsonRelative(file, (plan as FlightPlan).profile, 'profiles/default.json'));
  const aircraftPath = (plan as FlightPlan).aircraft;
  const aircraft = aircraftPath ? parseAircraftLimits(readJsonRelative(file, aircraftPath, '')) : null;
  const briefing = evaluateFlight(resolved, profile, aircraft);
  console.log(args.includes('--json') ? JSON.stringify(briefing, null, 2) : briefingText(briefing));
}

function decodeCommand(args: string[]): void {
  const text = args.join(' ').trim();
  if (!text) usage();
  const decoded = /^(TAF\b|[A-Z]{4} \d{6}Z \d{4}\/\d{4})/.test(text) ? decodeTaf(text) : decodeMetar(text);
  console.log(JSON.stringify(decoded, null, 2));
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'fetch':
    await fetchCommand(rest);
    break;
  case 'nasr':
    await nasrCommand(rest);
    break;
  case 'ourairports':
    await ourairportsCommand(rest);
    break;
  case 'airport':
    await airportCommand(rest);
    break;
  case 'resolve':
    await resolveCommand(rest);
    break;
  case 'brief':
    await briefCommand(rest);
    break;
  case 'decode':
    decodeCommand(rest);
    break;
  default:
    usage();
}
