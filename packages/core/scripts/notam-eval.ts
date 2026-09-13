/**
 * Score the NOTAM relevance model against the labelled set for the demo
 * flight. Runs the pipeline over the recorded NAV CANADA corpus (no
 * network) with whatever HOLDSHORT_LLM configures; `--record` wraps a
 * live provider so the answers become fixtures the test suite can replay.
 *
 *   HOLDSHORT_LLM=ollama OLLAMA_MODEL=qwen2.5:7b npx tsx packages/core/scripts/notam-eval.ts --record
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlightPlan } from '../src/domain/flight.js';
import { AwcClient } from '../src/fetch/awc.js';
import { storeAndDecode } from '../src/fetch/ingest.js';
import type { HttpClient } from '../src/fetch/http.js';
import { NAVCANADA_CFPS_BASE_URL, NavCanadaClient } from '../src/fetch/navcanada.js';
import { readOurAirportsDirectory } from '../src/fetch/ourairports.js';
import { llmFromEnv } from '../src/llm/env.js';
import { RecordingProvider } from '../src/llm/fixture.js';
import { PROMPT_VERSION } from '../src/notam/assess.js';
import { notamBriefingText, notamDocument } from '../src/notam/describe.js';
import { scoreAssessments, type LabelledSet } from '../src/notam/eval.js';
import { notamsForFlight } from '../src/notam/flight.js';
import { resolveFlight } from '../src/resolve/flight.js';
import { MemoryStore } from '../src/store/memory.js';

const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, '..');
const root = join(core, '..', '..');
const fixtures = join(core, 'test', 'fixtures');
for (const env of [join(root, '.env')]) if (existsSync(env)) process.loadEnvFile(env);

const record = process.argv.includes('--record');
const llm = llmFromEnv();
if (!llm) {
  console.error('no model configured: set HOLDSHORT_LLM=ollama (and OLLAMA_MODEL) or HOLDSHORT_LLM=fixture with HOLDSHORT_LLM_FIXTURE_DIR');
  process.exit(2);
}
const fixtureDir = process.env['HOLDSHORT_LLM_FIXTURE_DIR'] ?? join(fixtures, 'llm', llm.model.replace(/[^a-z0-9.-]/gi, '_'));
const provider = record ? new RecordingProvider(llm.provider, fixtureDir) : llm.provider;

const replay: HttpClient = {
  async get(url) {
    const m = /site=([A-Z0-9]{3,4})&alpha=notam$/.exec(url);
    if (!m) return { status: 204, body: '', headers: {} };
    return { status: 200, body: readFileSync(join(fixtures, 'notam', 'navcanada', '2026-09-12', `${m[1]}.json`), 'utf8'), headers: {} };
  },
};

const store = new MemoryStore();
await store.putAirports(readOurAirportsDirectory(join(fixtures, 'fetch', 'ourairports', '2026-09-07'), { snapshot: '2026-09-07' }));
const awc = new AwcClient(replay);
for (const s of ['CYSN', 'CYKF', 'CYHM']) {
  const m = await awc.metars([s]);
  await storeAndDecode(store, m.reports, m.request, new Date('2026-09-12T12:00Z'));
}
const plan = { ...parseFlightPlan(JSON.parse(readFileSync(join(root, 'flights', 'demo-cysn-cykf.json'), 'utf8'))), departureTime: '2026-09-14T15:00:00.000Z' };
const resolved = await resolveFlight(store, plan, new Date('2026-09-12T20:00:00Z'));
const nb = await notamsForFlight(
  { store, navcanada: new NavCanadaClient(replay), provider, model: llm.model, now: () => new Date('2026-09-12T20:00:00Z') },
  resolved,
  'C172',
);
const set = JSON.parse(readFileSync(join(fixtures, 'notam', 'labelled', 'demo-cysn-cykf-2026-09-14.json'), 'utf8')) as LabelledSet;
const score = scoreAssessments(set, nb.items);

console.log(notamBriefingText(notamDocument(nb)));
console.log('');
console.log(`model ${llm.model} (${llm.description}), prompt v${PROMPT_VERSION}${record ? `, recorded to ${fixtureDir}` : ''}`);
console.log(`agreement ${(score.agreement * 100).toFixed(1)}% on ${score.total - score.missing - score.filtered} assessed of ${score.total} labelled (${score.filtered} filtered out of scope deterministically, ${score.missing} unverified or failed)`);
for (const [cls, s] of Object.entries(score.perClass)) console.log(`  ${cls.padEnd(10)} precision ${(s.precision * 100).toFixed(0)}%  recall ${(s.recall * 100).toFixed(0)}%  support ${s.support}`);
console.log(`  category agreement ${score.categoryAgreement === null ? 'n/a' : (score.categoryAgreement * 100).toFixed(0) + '%'}`);
for (const d of score.disagreements) console.log(`  ${d.notamId}: expected ${d.expected}, got ${d.actual ?? 'nothing'}`);
console.log(`  ${JSON.stringify(nb.counts)}`);
