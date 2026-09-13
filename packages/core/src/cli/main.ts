/**
 * holdshort — the terminal entry point.
 *
 *   holdshort fetch KJFK [KTEB ...] [--memory]   fetch, store and decode METAR/TAF (and NOTAMs with credentials)
 *   holdshort nasr <dir>                          load one NASR cycle's APT CSV files into the store
 *   holdshort ourairports <dir> [--country CA]    load an OurAirports snapshot (airports.csv + runways.csv)
 *   holdshort airport KJFK                        print a stored airport with its runways
 *   holdshort resolve <flight.json> [--fetch] [--as-of <ISO>] [--json]
 *                                                 conditions at each waypoint at its ETA
 *   holdshort brief <flight.json> [--fetch] [--as-of <ISO>] [--json] [--notams]
 *                                                 go / marginal / no-go per waypoint, every finding cited
 *   holdshort notams <flight.json> [--fetch] [--as-of <ISO>] [--json]
 *                                                 every NOTAM for the flight's fields, classified and (with a model) ranked
 *   holdshort diff <flight.json> [--fetch] [--notams] [--against <sha256>] [--json]
 *                                                 brief now, store it, and say what changed since the last briefing
 *   holdshort doc ingest|find|page|wb <pdf> ...   read a scanned POH into word boxes; extract weight-and-balance data
 *   holdshort wb <spec.json> --empty <lb> --empty-moment <n> [--front lb] [--rear lb] [--bag1 lb] [--fuel gal]
 *                                                 a loading against the extracted limits, every limit cited to its page
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
import { assembleBriefing } from '../brief/assemble.js';
import { diffText } from '../brief/describeDiff.js';
import { diffBriefings } from '../brief/diff.js';
import { briefingText } from '../rules/describe.js';
import { evaluateFlight } from '../rules/evaluate.js';
import { flightText } from '../resolve/describe.js';
import { resolveFlight } from '../resolve/flight.js';
import { decodeTaf } from '../decode/taf/index.js';
import { AwcClient } from '../fetch/awc.js';
import { createHttpClient } from '../fetch/http.js';
import { ingestStation, type IngestCounts } from '../fetch/ingest.js';
import { readNasrDirectory } from '../fetch/nasr.js';
import { NavCanadaClient } from '../fetch/navcanada.js';
import { readOurAirportsDirectory } from '../fetch/ourairports.js';
import { llmFromEnv } from '../llm/env.js';
import { docCommand, wbCommand } from './docs.js';
import { notamBriefingText, notamDocument } from '../notam/describe.js';
import { notamsForFlight, type NotamBriefing } from '../notam/flight.js';
import { FaaNotamClient } from '../fetch/notam.js';
import { MemoryStore } from '../store/memory.js';
import { PostgresStore } from '../store/postgres.js';
import type { Store } from '../store/types.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const USER_AGENT = process.env.HOLDSHORT_USER_AGENT ?? 'holdshort/0.1 (+https://github.com/holdshort)';

function usage(): never {
  console.error(
    'usage: holdshort fetch <ICAO...> [--memory] | holdshort nasr <dir> | holdshort ourairports <dir> [--country XX] | holdshort airport <id> | holdshort resolve|brief|notams|diff <flight.json> [--fetch] [--as-of <ISO>] [--json] [--notams] [--against <sha256>] | holdshort doc ingest|find|page|wb <pdf> ... | holdshort wb <spec.json> ... | holdshort decode "<report>"',
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

/**
 * Read the plan, optionally fetch, resolve it as of the requested instant,
 * and hand the still-open store to `body` — one connection for the whole
 * command, closed when it returns.
 */
async function withFlight<T>(args: string[], body: (ctx: { file: string; plan: FlightPlan; resolved: Awaited<ReturnType<typeof resolveFlight>>; store: Store }) => Promise<T>): Promise<T> {
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
    return await body({ file, plan, resolved: await resolveFlight(store, plan, asOf), store });
  } finally {
    await store.close();
  }
}

async function resolveCommand(args: string[]): Promise<void> {
  await withFlight(args, async ({ resolved }) => {
    console.log(args.includes('--json') ? JSON.stringify(resolved, null, 2) : flightText(resolved));
  });
}

function readJsonRelative(planFile: string, path: string | null, fallback: string): unknown {
  const target = path ? resolvePath(dirname(planFile), path) : fallback;
  if (!existsSync(target)) throw new Error(`file not found: ${target}`);
  return JSON.parse(readFileSync(target, 'utf8'));
}

/** NOTAMs for a resolved flight: fetched when asked, ranked when a model is configured. */
async function notamsFor(args: string[], store: Store, resolved: Awaited<ReturnType<typeof resolveFlight>>, aircraftType: string): Promise<NotamBriefing> {
  const llm = llmFromEnv();
  if (llm) console.error(`NOTAM relevance: ${llm.description}`);
  const http = createHttpClient({ userAgent: USER_AGENT });
  return notamsForFlight(
    {
      store,
      navcanada: args.includes('--fetch') ? new NavCanadaClient(http) : null,
      provider: llm?.provider ?? null,
      model: llm?.model ?? null,
    },
    resolved,
    aircraftType,
  );
}

function aircraftOf(file: string, plan: FlightPlan) {
  return plan.aircraft ? parseAircraftLimits(readJsonRelative(file, plan.aircraft, '')) : null;
}

async function briefCommand(args: string[]): Promise<void> {
  await withFlight(args, async ({ file, plan, resolved, store }) => {
    const profile = parsePilotProfile(readJsonRelative(file, plan.profile, 'profiles/default.json'));
    const aircraft = aircraftOf(file, plan);
    const briefing = evaluateFlight(resolved, profile, aircraft);
    const notams = args.includes('--notams') ? await notamsFor(args, store, resolved, aircraft?.type ?? 'unknown') : null;
    if (args.includes('--json')) {
      console.log(JSON.stringify({ briefing, notams: notams ? notamDocument(notams) : null }, null, 2));
      return;
    }
    console.log(briefingText(briefing));
    if (notams) console.log(notamBriefingText(notamDocument(notams)));
  });
}

async function diffCommand(args: string[]): Promise<void> {
  await withFlight(args, async ({ file, plan, resolved, store }) => {
    const profile = parsePilotProfile(readJsonRelative(file, plan.profile, 'profiles/default.json'));
    const aircraft = aircraftOf(file, plan);
    const notams = args.includes('--notams') ? await notamsFor(args, store, resolved, aircraft?.type ?? 'unknown') : null;
    const now = assembleBriefing(resolved, profile, aircraft, new Date(), notams);
    await store.putBriefing(now);

    const againstSha = option(args, '--against');
    // The *previous* briefing: newest at or before this one. `listBriefings`
    // is newest first, and a briefing must never be compared with a later one.
    const previous = againstSha
      ? await store.getBriefing(againstSha)
      : ((await store.listBriefings(now.flightKey, 50)).find((b) => b.sha256 !== now.sha256 && b.asOf.getTime() <= now.asOf.getTime()) ?? null);
    if (!previous) {
      console.error(`no earlier briefing for this flight to compare against; this one is stored as ${now.sha256.slice(0, 12)}`);
      console.log(briefingText(now.document.briefing));
      return;
    }
    const d = diffBriefings(previous, now);
    console.log(args.includes('--json') ? JSON.stringify(d, null, 2) : diffText(d));
  });
}

async function notamsCommand(args: string[]): Promise<void> {
  await withFlight(args, async ({ file, plan, resolved, store }) => {
    const aircraft = aircraftOf(file, plan);
    const doc = notamDocument(await notamsFor(args, store, resolved, aircraft?.type ?? 'unknown'));
    console.log(args.includes('--json') ? JSON.stringify(doc, null, 2) : notamBriefingText(doc));
  });
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
  case 'notams':
    await notamsCommand(rest);
    break;
  case 'diff':
    await diffCommand(rest);
    break;
  case 'doc':
    await docCommand(rest);
    break;
  case 'wb':
    await wbCommand(rest);
    break;
  case 'decode':
    decodeCommand(rest);
    break;
  default:
    usage();
}
