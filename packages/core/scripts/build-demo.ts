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
import { parseFlightPlan } from '../src/domain/flight.js';
import { parseAircraftLimits, parsePilotProfile } from '../src/domain/profile.js';
import { AWC_BASE_URL, AwcClient } from '../src/fetch/awc.js';
import type { HttpClient } from '../src/fetch/http.js';
import { storeAndDecode } from '../src/fetch/ingest.js';
import { NAVCANADA_CFPS_BASE_URL, NavCanadaClient } from '../src/fetch/navcanada.js';
import { readOurAirportsDirectory } from '../src/fetch/ourairports.js';
import { FixtureProvider, RecordingProvider } from '../src/llm/fixture.js';
import { OllamaProvider } from '../src/llm/ollama.js';
import { notamsForFlight } from '../src/notam/flight.js';
import { resolveFlight } from '../src/resolve/flight.js';
import { MemoryStore } from '../src/store/memory.js';
import { withHandbookLimits } from '../src/wb/aircraft.js';
import type { WeightBalanceSpec } from '../src/wb/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, '..');
const root = join(core, '..', '..');
const fixtures = join(core, 'test', 'fixtures');
const out = join(root, 'apps', 'web', 'public', 'demo');

/** The moment the demo is frozen at: when these reports were recorded. */
const AS_OF = new Date('2026-09-12T20:00:00Z');
const SITES = ['CYSN', 'CYKF', 'CYHM'] as const;
const MODEL = 'qwen2.5:7b';

/** Serves only what was recorded; anything else is a 204, as a quiet upstream would be. */
const replay: HttpClient = {
  async get(url) {
    const notam = /site=([A-Z0-9]{3,4})&alpha=notam$/.exec(url);
    if (notam) {
      const p = join(fixtures, 'notam', 'navcanada', '2026-09-12', `${notam[1]}.json`);
      return existsSync(p) ? { status: 200, body: readFileSync(p, 'utf8'), headers: {} } : { status: 204, body: '', headers: {} };
    }
    return { status: 204, body: '', headers: {} };
  },
};

const store = new MemoryStore();
await store.putAirports(readOurAirportsDirectory(join(fixtures, 'fetch', 'ourairports', '2026-09-07'), { snapshot: '2026-09-07' }));

// The METARs and TAFs these fields were reporting when the corpus was taken.
const liveWeather = join(fixtures, 'fetch', 'awc', 'demo-cysn-cykf-cyhm.json');
if (existsSync(liveWeather)) {
  // The fixture holds the upstream records verbatim, so they are served as they were received.
  const recorded = JSON.parse(readFileSync(liveWeather, 'utf8')) as { metar: unknown[]; taf: unknown[] };
  const awc = new AwcClient({
    async get(url) {
      const wanted = url.startsWith(`${AWC_BASE_URL}/taf`) ? recorded.taf : recorded.metar;
      return { status: 200, body: JSON.stringify(wanted), headers: {} };
    },
  });
  const m = await awc.metars([...SITES]);
  await storeAndDecode(store, m.reports, m.request, AS_OF);
  const t = await awc.tafs([...SITES]);
  await storeAndDecode(store, t.reports, t.request, AS_OF);
}

/*
 * The owner's own flight, moved to a departure the recorded weather covers:
 * these TAFs were issued at 1940Z on 12 September and run to 0100Z on the
 * 13th, so a 15:00Z departure two days later would sit outside them and the
 * demo would show nothing but "no forecast covers this". Everything else —
 * route, aircraft, personal minimums, reports — is exactly as it is.
 */
const plan = parseFlightPlan({ ...JSON.parse(readFileSync(join(root, 'flights', 'demo-cysn-cykf.json'), 'utf8')), departureTime: '2026-09-12T22:00:00Z' });
const profile = parsePilotProfile(JSON.parse(readFileSync(join(root, 'profiles', 'default.json'), 'utf8')));
let aircraft = parseAircraftLimits(JSON.parse(readFileSync(join(root, 'aircraft', 'c172.json'), 'utf8')));
const wbPath = join(root, 'aircraft', 'c172.wb.json');
const wb = existsSync(wbPath) ? (JSON.parse(readFileSync(wbPath, 'utf8')) as WeightBalanceSpec) : null;
aircraft = withHandbookLimits(aircraft, wb);

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
  { store, navcanada: new NavCanadaClient(replay), provider, model: provider ? MODEL : null, now: () => AS_OF },
  resolved,
  aircraft.type,
);

const briefing = assembleBriefing(resolved, profile, aircraft, AS_OF, notams);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'briefing.json'), JSON.stringify(briefing, null, 2) + '\n');
if (wb) writeFileSync(join(out, 'wb.json'), JSON.stringify(wb, null, 2) + '\n');

const counts = briefing.document.notams?.counts;
console.log(`demo written to ${out}`);
console.log(`  verdict ${briefing.document.briefing.verdict}, ${briefing.document.inputs.reports.length} reports cited`);
console.log(`  NOTAMs: ${briefing.document.notams?.items.length ?? 0}${counts ? ` (${Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ')})` : ''}`);
console.log(`  ranked by ${briefing.document.notams?.model ?? 'no model'}`);
console.log(`  weight and balance: ${wb ? `${wb.figures.length} figures, ${wb.review.length} in review` : 'none'}`);
