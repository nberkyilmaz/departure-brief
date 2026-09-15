/**
 * Build the data the public demo site shows.
 *
 * Everything here comes from recorded upstream responses committed to the
 * repository — the same fixtures the test suite runs on — so the demo is
 * reproducible, needs no network, no database and no model at run time, and
 * puts no load on NAV CANADA or the weather service. It is a real briefing
 * of a real flight over real reports, frozen at the moment they were
 * recorded.
 *
 *   npx tsx packages/core/scripts/build-demo.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleBriefing } from '../src/brief/assemble.js';
import type { BundledReport, DemoBundle } from '../src/demo/bundle.js';
import { parseFlightPlan } from '../src/domain/flight.js';
import { parseAircraftLimits, parsePilotProfile } from '../src/domain/profile.js';
import { AWC_BASE_URL, AwcClient } from '../src/fetch/awc.js';
import type { HttpClient } from '../src/fetch/http.js';
import { storeAndDecode } from '../src/store/decode.js';
import { NAVCANADA_CFPS_BASE_URL, NavCanadaClient } from '../src/fetch/navcanada.js';
import { readOurAirportsDirectory } from '../src/fetch/ourairports.js';
import { FixtureProvider, RecordingProvider } from '../src/llm/fixture.js';
import { OllamaProvider } from '../src/llm/ollama.js';
import { notamsForFlight } from '../src/notam/flight.js';
import { resolveFlight } from '../src/resolve/flight.js';
import { MemoryStore } from '../src/store/memory.js';
import type { RawReport } from '../src/store/types.js';
import { withHandbookLimits } from '../src/wb/aircraft.js';
import type { WeightBalanceSpec } from '../src/wb/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, '..');
const root = join(core, '..', '..');
const fixtures = join(core, 'test', 'fixtures');
const out = join(root, 'apps', 'web', 'public', 'demo');

/** The moment the demo is frozen at: when these reports were recorded. */
const AS_OF = new Date('2026-09-15T21:37:00Z');
/**
 * The aerodromes NOTAMs were recorded for. Not every field in Canada: that
 * would be fifteen hundred requests to an unofficial service, which is not
 * a thing to do to somebody else's endpoint. The flight's three, and the
 * three busiest fields near them so a visitor who brief something else
 * still sees NOTAMs.
 */
const NOTAM_SITES = ['CYSN', 'CYKF', 'CYHM', 'CYYZ', 'CYTZ', 'CYOW'] as const;
/** Where the recorded snapshot lives. */
const SNAPSHOT = 'canada-2026-09-15';
const MODEL = 'qwen2.5:7b';

/** Serves only what was recorded; anything else is a 204, as a quiet upstream would be. */
const snapshot = join(fixtures, 'fetch', SNAPSHOT);

const replay: HttpClient = {
  async get(url) {
    const notam = /site=([A-Z0-9]{3,4})&alpha=notam$/.exec(url);
    if (notam) {
      const p = join(snapshot, 'notam', `${notam[1]}.json`);
      return existsSync(p) ? { status: 200, body: readFileSync(p, 'utf8'), headers: {} } : { status: 204, body: '', headers: {} };
    }
    if (url.includes('alpha=upperwind')) {
      /*
       * One recorded response covers every upper wind site in the country,
       * so the answer to a request is whichever of the sites asked about
       * are in it — exactly what the live service does.
       */
      const wanted = new Set([...url.matchAll(/site=([A-Z0-9]{3,4})/g)].map((m) => m[1]!));
      const all = JSON.parse(readFileSync(join(snapshot, 'upperwind.json'), 'utf8')) as { data: { position?: { pointReference?: string }; location?: string }[] };
      const data = all.data.filter((d) => wanted.has(d.position?.pointReference ?? `C${d.location ?? ''}`));
      return { status: 200, body: JSON.stringify({ meta: { count: { upperwind: data.length } }, data }), headers: {} };
    }
    return { status: 204, body: '', headers: {} };
  },
};

/*
 * Every aerodrome in Canada, so a visitor can type any identifier and be
 * told what the tool knows about it. Heliports and seaplane bases are left
 * out: this is a tool for an aeroplane on wheels, and they would be three
 * hundred kilobytes of places it cannot take you.
 */
const store = new MemoryStore();
const airports = readOurAirportsDirectory(join(snapshot, 'ourairports'), { snapshot: '2026-09-14' }).filter((a) => a.siteType === 'A');
await store.putAirports(airports);

/*
 * Everything that goes into the store also goes into the bundle the web app
 * loads, so the page can build the briefing itself rather than render one it
 * was handed. Reports are collected by hash, with the sites each was fetched
 * for: a FIR-wide NOTAM is returned for several.
 */
const bundled = new Map<string, BundledReport>();
const collect = (reports: readonly RawReport[], request: string, fetchedFor: string | null): void => {
  for (const r of reports) {
    const seen = bundled.get(r.sha256);
    const sites = new Set(seen?.fetchedFor ?? []);
    if (fetchedFor) sites.add(fetchedFor);
    bundled.set(r.sha256, {
      sha256: r.sha256,
      kind: r.kind,
      source: r.source,
      station: r.station,
      body: r.body,
      issuedAt: r.issuedAt?.toISOString() ?? null,
      // Left out on purpose; see BundledReport.upstream.
      fetchedFor: [...sites].sort(),
      request: seen?.request ?? request,
    });
  }
};

// Every Canadian station that was reporting when the snapshot was taken.
const liveWeather = join(snapshot, 'weather.json');
if (existsSync(liveWeather)) {
  // The fixture holds the upstream records verbatim, so they are served as they were received.
  const recorded = JSON.parse(readFileSync(liveWeather, 'utf8')) as { metar: unknown[]; taf: unknown[] };
  const awc = new AwcClient({
    async get(url) {
      const wanted = url.startsWith(`${AWC_BASE_URL}/taf`) ? recorded.taf : recorded.metar;
      return { status: 200, body: JSON.stringify(wanted), headers: {} };
    },
  });
  /*
   * The stations in the recorded response, asked for by name. The snapshot
   * was taken with one bounding-box request covering the country, but it
   * goes through the real client here so the demo exercises the same
   * parsing a live briefing does rather than a second copy of it.
   */
  const stationsOf = (rows: { icaoId?: unknown }[]) => [...new Set(rows.map((r) => String(r.icaoId ?? '')).filter((id) => /^[A-Z0-9]{3,4}$/.test(id)))];
  const m = await awc.metars(stationsOf(recorded.metar as { icaoId?: unknown }[]));
  await storeAndDecode(store, m.reports, m.request, AS_OF);
  collect(m.reports, m.request, null);
  const t = await awc.tafs(stationsOf(recorded.taf as { icaoId?: unknown }[]));
  await storeAndDecode(store, t.reports, t.request, AS_OF);
  collect(t.reports, t.request, null);
}

/*
 * The owner's own flight, at a departure the recorded weather covers: a
 * 12:00Z departure is eight in the morning at home, and the forecasts
 * recorded at 05:10Z run out past it. Everything else — route, aircraft,
 * personal minimums, every report — is exactly as it is.
 *
 * None of the three publishes a TAF at this hour — they are all part-time
 * stations — so the briefing borrows Toronto's at both ends and says so,
 * which is the right answer and worth a visitor seeing.
 */
const planJson = { ...JSON.parse(readFileSync(join(root, 'flights', 'demo-cysn-cykf.json'), 'utf8')), departureTime: '2026-09-16T00:00:00Z' };
const profileJson = JSON.parse(readFileSync(join(root, 'profiles', 'default.json'), 'utf8'));
const aircraftJson = JSON.parse(readFileSync(join(root, 'aircraft', 'c172.json'), 'utf8'));
const plan = parseFlightPlan(planJson);
const profile = parsePilotProfile(profileJson);
let aircraft = parseAircraftLimits(aircraftJson);
const wbPath = join(root, 'aircraft', 'c172.wb.json');
const wb = existsSync(wbPath) ? (JSON.parse(readFileSync(wbPath, 'utf8')) as WeightBalanceSpec) : null;
aircraft = withHandbookLimits(aircraft, wb);

/*
 * The NOTAMs, fetched here rather than left to the briefing so the bundle
 * carries every one the pipeline saw — including those a later NOTAM
 * replaces, which is what lets the page say "superseded by" as this build
 * does. `notamsForFlight` asks again below and the store dedupes.
 */
const cfps = new NavCanadaClient(replay);
for (const site of NOTAM_SITES) {
  const fetched = await cfps.notams(site);
  await storeAndDecode(store, fetched.reports, fetched.request, AS_OF, site);
  collect(fetched.reports, fetched.request, site);
}

/*
 * Upper winds for every Canadian site that publishes them — seventeen,
 * coast to coast — so a flight anywhere in the country finds one within
 * reach. None of the small fields publishes its own; they all borrow.
 */
const WIND_SITES = [...new Set(
  (JSON.parse(readFileSync(join(snapshot, 'upperwind.json'), 'utf8')) as { data: { position?: { pointReference?: string }; location?: string }[] }).data.map(
    (d) => d.position?.pointReference ?? `C${d.location ?? ''}`,
  ),
)];
const winds = await cfps.upperWinds(WIND_SITES);
for (const site of WIND_SITES) {
  const mine = winds.reports.filter((r) => r.station === site);
  await storeAndDecode(store, mine, winds.request, AS_OF, site);
  collect(mine, winds.request, site);
}

const resolved = await resolveFlight(store, plan, AS_OF);

/*
 * The recorded model answers, replayed: no model runs when the demo is
 * built from committed fixtures. With HOLDSHORT_LLM=ollama set, a missing
 * answer is fetched once and written into the same fixture directory, so
 * the next build needs nothing again.
 */
const llmDir = join(fixtures, 'llm', MODEL.replace(/[^a-z0-9.-]/gi, '_'));
const recording = process.env['HOLDSHORT_LLM'] === 'ollama';
const provider = recording
  ? new RecordingProvider(new OllamaProvider(), llmDir)
  : existsSync(llmDir)
    ? new FixtureProvider(llmDir)
    : null;
const notams = await notamsForFlight(
  { store, navcanada: cfps, provider, model: provider ? MODEL : null, now: () => AS_OF },
  resolved,
  aircraft.type,
);

const briefing = assembleBriefing(resolved, profile, aircraft, AS_OF, notams);

/*
 * The same inputs, for the page to work from. The briefing above is what
 * this build produced; the bundle is what it produced it from, so a visitor
 * changing their minimums gets a briefing built here in front of them
 * rather than a different picture of the same one.
 */
const bundle: DemoBundle = {
  recordedAt: AS_OF.toISOString(),
  asOf: AS_OF.toISOString(),
  model: notams.model,
  promptVersion: notams.promptVersion,
  plan: planJson,
  profile: profileJson,
  aircraft: aircraftJson,
  // Every aerodrome, not only the ones on this flight: the page is meant to
  // answer for whatever a visitor types.
  airports,
  reports: [...bundled.values()].sort((a, b) => a.sha256.localeCompare(b.sha256)),
  assessments: notams.items.map((i) => i.assessment).filter((a): a is NonNullable<typeof a> => a !== null),
};

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'briefing.json'), JSON.stringify(briefing, null, 2) + '\n');
writeFileSync(join(out, 'bundle.json'), JSON.stringify(bundle, null, 2) + '\n');
if (wb) writeFileSync(join(out, 'wb.json'), JSON.stringify(wb, null, 2) + '\n');

const counts = briefing.document.notams?.counts;
console.log(`demo written to ${out}`);
console.log(`  ${briefing.document.briefing.points.map((p) => `${p.waypoint} ${p.category ?? '—'}`).join(', ')}; ${briefing.document.inputs.reports.length} reports cited`);
console.log(`  NOTAMs: ${briefing.document.notams?.items.length ?? 0}${counts ? ` (${Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ')})` : ''}`);
console.log(`  ranked by ${briefing.document.notams?.model ?? 'no model'}`);
console.log(`  weight and balance: ${wb ? `${wb.figures.length} figures, ${wb.review.length} in review` : 'none'}`);
console.log(`  bundle: ${bundle.reports.length} reports, ${bundle.airports.length} aerodromes, ${bundle.assessments.length} recorded model answers`);
const kinds = new Map<string, number>();
for (const r of bundle.reports) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
console.log(`    ${[...kinds].map(([k, n]) => `${n} ${k}`).join(', ')}`);
const log = briefing.document.navlog;
console.log(`  nav log: ${log.legs.length} leg(s), ${log.totalMinutes ?? '—'} min, ${log.legs.filter((l) => l.wind).length} with a wind`);
