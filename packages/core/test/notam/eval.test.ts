/**
 * The eval gate. The labelled set is checked for integrity always. The
 * model is scored only when recorded responses exist for the current
 * prompt version (HOLDSHORT_LLM_FIXTURE_DIR, default
 * test/fixtures/llm/<model>) — without them the scoring test is skipped
 * and says so, never silently passed.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFlightPlan } from '../../src/domain/flight.js';
import { AWC_BASE_URL, AwcClient } from '../../src/fetch/awc.js';
import { storeAndDecode } from '../../src/fetch/ingest.js';
import { NAVCANADA_CFPS_BASE_URL, NavCanadaClient } from '../../src/fetch/navcanada.js';
import { readOurAirportsDirectory } from '../../src/fetch/ourairports.js';
import { FixtureProvider } from '../../src/llm/fixture.js';
import { buildAssessmentRequest, PROMPT_VERSION, RELEVANCES } from '../../src/notam/assess.js';
import { decodeNotam } from '../../src/notam/decode.js';
import { scoreAssessments, type LabelledSet } from '../../src/notam/eval.js';
import { flightContextOf, notamFactsOf, notamsForFlight } from '../../src/notam/flight.js';
import { resolveFlight } from '../../src/resolve/flight.js';
import { MemoryStore } from '../../src/store/memory.js';
import { FIXTURES, replayHttp } from '../helpers/http.js';

const ROOT = join(__dirname, '..', '..', '..', '..');
const NOTAMS = join(__dirname, '..', 'fixtures', 'notam', 'navcanada', '2026-09-12');
const set = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'notam', 'labelled', 'demo-cysn-cykf-2026-09-14.json'), 'utf8')) as LabelledSet;
const plan = { ...parseFlightPlan(JSON.parse(readFileSync(join(ROOT, 'flights', 'demo-cysn-cykf.json'), 'utf8'))), departureTime: '2026-09-14T15:00:00.000Z' };

const corpusIds = new Set(
  readdirSync(NOTAMS)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => (JSON.parse(readFileSync(join(NOTAMS, f), 'utf8')) as { data: { text: string }[] }).data)
    .map((item) => decodeNotam((JSON.parse(item.text) as { raw: string }).raw).id?.value.text),
);

describe('labelled set', () => {
  it('labels every distinct NOTAM in the corpus, once, with valid values and a cited span that is in the NOTAM', () => {
    expect(set.labels.length).toBe(corpusIds.size);
    expect(new Set(set.labels.map((l) => l.notamId)).size).toBe(set.labels.length);
    for (const l of set.labels) {
      expect(corpusIds.has(l.notamId)).toBe(true);
      expect(RELEVANCES).toContain(l.relevance);
      // The yardstick is not signed off by the owner yet, and must say so.
      expect(l.labelledBy).toContain('owner sign-off pending');
    }
  });

  it('agrees with what a pilot would expect on the clearest cases', () => {
    const by = Object.fromEntries(set.labels.map((l) => [l.notamId, l.relevance]));
    expect(by['J5067/26']).toBe('critical'); // RWY 11/29 CLSD at the departure field
    expect(by['J5069/26']).toBe('critical'); // THR 19 displaced, only runway left
    expect(by['G2675/26']).toBe('irrelevant'); // Mali airspace warning
    expect(by['G3032/26']).toBe('irrelevant'); // trigger NOTAM
    expect(by['J6015/26']).toBe('irrelevant'); // ILS U/S for a VFR flight
  });
});

async function seeded(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.putAirports(readOurAirportsDirectory(join(FIXTURES, 'ourairports', '2026-09-07'), { snapshot: '2026-09-07' }));
  const awc = new AwcClient(replayHttp(Object.fromEntries(['CYSN', 'CYKF', 'CYHM'].flatMap((s) => [[`${AWC_BASE_URL}/metar?ids=${s}&format=json`, { status: 204 }], [`${AWC_BASE_URL}/taf?ids=${s}&format=json`, { status: 204 }]]))));
  for (const s of ['CYSN', 'CYKF', 'CYHM']) {
    const m = await awc.metars([s]);
    await storeAndDecode(store, m.reports, m.request, new Date('2026-09-12T12:00Z'));
  }
  return store;
}

const model = process.env['OLLAMA_MODEL'] ?? 'qwen2.5:7b';
const fixtureDir = process.env['HOLDSHORT_LLM_FIXTURE_DIR'] ?? join(__dirname, '..', 'fixtures', 'llm', model.replace(/[^a-z0-9.-]/gi, '_'));

async function recordingsExist(): Promise<boolean> {
  if (!existsSync(fixtureDir)) return false;
  const store = await seeded();
  const resolved = await resolveFlight(store, plan, new Date('2026-09-12T20:00:00Z'));
  const cfps = new NavCanadaClient(replayHttp(Object.fromEntries(['CYSN', 'CYKF', 'CYHM'].map((s) => [`${NAVCANADA_CFPS_BASE_URL}?site=${s}&alpha=notam`, { status: 200, file: `../notam/navcanada/2026-09-12/${s}.json` }]))));
  const nb = await notamsForFlight({ store, navcanada: cfps, now: () => new Date('2026-09-12T20:00:00Z') }, resolved, 'C172');
  const ctx = flightContextOf(resolved, 'C172');
  const fixture = new FixtureProvider(fixtureDir);
  /*
   * Ask exactly what the pipeline would ask — in scope, not already settled
   * by a deterministic rule, and with the same facts attached. Building the
   * request any other way makes the key miss, and the gate then skips
   * itself silently, which is the one thing it must never do.
   */
  const asked = nb.items.filter((i) => i.classification.inScope && !i.rule);
  if (asked.length === 0) return false;
  return asked.every((i) => fixture.has(buildAssessmentRequest(model, i.decoded, ctx, notamFactsOf(ctx, i.decoded, i.classification))));
}

const haveRecordings = await recordingsExist();

describe.skipIf(!haveRecordings)(`NOTAM relevance eval — ${model}, prompt v${PROMPT_VERSION}`, () => {
  it('agrees with the labelled set on at least 75% of assessed NOTAMs and never calls a runway closure irrelevant', async () => {
    const store = await seeded();
    const resolved = await resolveFlight(store, plan, new Date('2026-09-12T20:00:00Z'));
    const cfps = new NavCanadaClient(replayHttp(Object.fromEntries(['CYSN', 'CYKF', 'CYHM'].map((s) => [`${NAVCANADA_CFPS_BASE_URL}?site=${s}&alpha=notam`, { status: 200, file: `../notam/navcanada/2026-09-12/${s}.json` }]))));
    const nb = await notamsForFlight({ store, navcanada: cfps, provider: new FixtureProvider(fixtureDir), model, now: () => new Date('2026-09-12T20:00:00Z') }, resolved, 'C172');
    const score = scoreAssessments(set, nb.items);
    console.log(`eval ${model}: agreement ${(score.agreement * 100).toFixed(0)}% over ${score.total - score.missing - score.filtered} (filtered ${score.filtered}, missing ${score.missing})`, score.perClass, score.disagreements);
    expect(score.agreement).toBeGreaterThanOrEqual(0.75);
    const closure = nb.items.find((i) => i.decoded.id?.value.text === 'J5067/26')!;
    expect(closure.rank).not.toBe('irrelevant');
  });
});

if (!haveRecordings) {
  describe(`NOTAM relevance eval — ${model}`, () => {
    it.skip(`skipped: no recorded responses for prompt v${PROMPT_VERSION} in ${fixtureDir} (run npm run eval:notam -- --record with Ollama up)`, () => {});
  });
}
