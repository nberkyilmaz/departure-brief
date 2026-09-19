/**
 * depbrief — the terminal entry point.
 *
 *   depbrief fetch KJFK [KTEB ...] [--memory]   fetch, store and decode METAR/TAF (and NOTAMs with credentials)
 *   depbrief nasr <dir>                          load one NASR cycle's APT CSV files into the store
 *   depbrief ourairports <dir> [--country CA]    load an OurAirports snapshot (airports.csv + runways.csv)
 *   depbrief airport KJFK                        print a stored airport with its runways
 *   depbrief resolve <flight.json> [--fetch] [--as-of <ISO>] [--json]
 *                                                 conditions at each waypoint at its ETA
 *   depbrief brief <flight.json> [--fetch] [--as-of <ISO>] [--json] [--notams]
 *                                                 go / marginal / no-go per waypoint, every finding cited
 *   depbrief notams <flight.json> [--fetch] [--as-of <ISO>] [--json]
 *                                                 every NOTAM for the flight's fields, classified and (with a model) ranked
 *   depbrief diff <flight.json> [--fetch] [--notams] [--against <sha256>] [--json]
 *                                                 brief now, store it, and say what changed since the last briefing
 *   depbrief verify [--fetch] [--station CYSN] [--since <ISO>] [--json]
 *                                                 did the forecasts your briefings relied on turn out to be right?
 *   depbrief doc ingest|find|page|wb <pdf> ...   read a scanned POH into word boxes; extract weight-and-balance data
 *   depbrief wb <spec.json> --empty <lb> --empty-moment <n> [--front lb] [--rear lb] [--bag1 lb] [--fuel gal]
 *                                                 a loading against the extracted limits, every limit cited to its page
 *   depbrief decode "<METAR or TAF text>"         print the decoded JSON
 *
 * Reads `.env` if present. Uses Postgres at DATABASE_URL (default: the
 * Compose database) unless `--memory` is given.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { ingestStation } from '../fetch/ingest.js';
import { type IngestCounts } from '../store/decode.js';
import { readNasrDirectory } from '../fetch/nasr.js';
import { NavCanadaClient } from '../fetch/navcanada.js';
import { readOurAirportsDirectory } from '../fetch/ourairports.js';
import { toZulu } from '../domain/time.js';
import { llmFromEnv } from '../llm/env.js';
import { matchOutstanding, outstandingChecks, recordForecastChecks } from '../verify/run.js';
import { reliabilityOf, reliabilityText, scorePair } from '../verify/score.js';
import { withHandbookLimits } from '../wb/aircraft.js';
import type { WeightBalanceSpec } from '../wb/types.js';
import { docCommand, wbCommand } from './docs.js';
import { notamBriefingText, notamDocument } from '../notam/describe.js';
import { notamsForFlight, type NotamBriefing } from '../notam/flight.js';
import { FaaNotamClient } from '../fetch/notam.js';
import { MemoryStore } from '../store/memory.js';
import { PostgresStore } from '../store/postgres.js';
import type { Store } from '../store/types.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const USER_AGENT = process.env.DEPBRIEF_USER_AGENT ?? 'depbrief/0.1 (+https://github.com/nberkyilmaz/departure-brief)';

function usage(): never {
  console.error(
    'usage: depbrief fetch <ICAO...> [--memory] | depbrief nasr <dir> | depbrief ourairports <dir> [--country XX] | depbrief airport <id> | depbrief verify [--fetch] [--station X] | depbrief resolve|brief|notams|diff <flight.json> [--fetch] [--as-of <ISO>] [--json] [--notams] [--against <sha256>] | depbrief doc ingest|find|page|wb <pdf> ... | depbrief wb <spec.json> ... | depbrief decode "<report>"',
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
    cache: process.env.DEPBRIEF_HTTP_CACHE ? { dir: process.env.DEPBRIEF_HTTP_CACHE, ttlMs: 5 * 60_000 } : null,
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
      console.error(`no airport ${id.toUpperCase()} in the store (run: depbrief nasr <dir> or depbrief ourairports <dir>)`);
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

/**
 * The aeroplane's limits, with anything the aircraft file leaves out filled
 * in from its handbook data — so the crosswind check can cite the page the
 * figure was read from instead of taking it on trust.
 */
function aircraftOf(file: string, plan: FlightPlan) {
  if (!plan.aircraft) return null;
  const limits = parseAircraftLimits(readJsonRelative(file, plan.aircraft, ''));
  const wb = join('aircraft', `${limits.type.toLowerCase().replace(/[^a-z0-9-]/g, '')}.wb.json`);
  return existsSync(wb) ? withHandbookLimits(limits, JSON.parse(readFileSync(wb, 'utf8')) as WeightBalanceSpec) : limits;
}

async function briefCommand(args: string[]): Promise<void> {
  await withFlight(args, async ({ file, plan, resolved, store }) => {
    const profile = parsePilotProfile(readJsonRelative(file, plan.profile, 'profiles/default.json'));
    const aircraft = aircraftOf(file, plan);
    const briefing = evaluateFlight(resolved, profile, aircraft);
    // Record what the forecasts assert, so `depbrief verify` can check them once their moment passes.
    const recorded = await recordForecastChecks(store, resolved);
    if (recorded.recorded > 0) console.error(`recording ${recorded.recorded} forecast${recorded.recorded === 1 ? '' : 's'} to check later`);
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

/**
 * Pair every forecast a past briefing relied on with what actually arrived,
 * then say what that means for each station.
 *
 *   depbrief verify [--fetch] [--station CYSN] [--since 2026-01-01] [--json]
 */
async function verifyCommand(args: string[]): Promise<void> {
  const store = await openStore(args);
  try {
    const station = option(args, '--station')?.toUpperCase() ?? null;
    const sinceText = option(args, '--since');
    const since = sinceText ? new Date(sinceText) : null;
    if (since && Number.isNaN(since.getTime())) usage();

    const report = await matchOutstanding({ store, awc: args.includes('--fetch') ? makeAwc() : null }, { station });
    const pairs = await store.listVerificationPairs({ station, since, limit: 1000 });
    const stations = [...new Set(pairs.map((p) => p.check.station))].sort();
    const reliability = stations.map((s) => reliabilityOf(s, pairs.filter((p) => p.check.station === s)));

    if (args.includes('--json')) {
      console.log(JSON.stringify({ matching: report, stations: reliability, pairs: pairs.map(scorePair) }, null, 2));
      return;
    }
    console.error(
      `checked ${report.considered} forecast${report.considered === 1 ? '' : 's'} whose moment has passed: ${report.matched} newly paired with an observation, ${report.noObservation.length} with none close enough yet`,
    );
    for (const e of report.fetchErrors) console.error(`  ! ${e.station}: ${e.error}`);
    if (reliability.length === 0) {
      console.log('Nothing verified yet. Brief a flight, wait for its ETA to pass, then run this again with --fetch.');
      const waiting = await outstandingChecks(store);
      if (waiting.length > 0) console.log(`${waiting.length} forecast${waiting.length === 1 ? '' : 's'} waiting, the earliest for ${waiting[0]!.station} at ${toZulu(waiting[0]!.validAt)}.`);
      return;
    }
    for (const r of reliability) console.log(reliabilityText(r) + '\n');
    console.log('Study aid only — this measures one station over the flights you have briefed, not the forecaster.');
  } finally {
    await store.close();
  }
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
  case 'verify':
    await verifyCommand(rest);
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
