/**
 * Filter, dedupe, provider plumbing, assessment caching, citation
 * verification, ranking and the eval scorer. Model answers in these tests
 * are test doubles for OUR code paths — a real model is never exercised
 * here; recorded fixtures do that.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseFlightPlan } from '../../src/domain/flight.js';
import { AWC_BASE_URL, AwcClient } from '../../src/fetch/awc.js';
import { storeAndDecode } from '../../src/store/decode.js';
import { NAVCANADA_CFPS_BASE_URL, NavCanadaClient } from '../../src/fetch/navcanada.js';
import { readOurAirportsDirectory } from '../../src/fetch/ourairports.js';
import { BudgetedProvider, BudgetExceededError } from '../../src/llm/budget.js';
import { FixtureMissingError, FixtureProvider, RecordingProvider } from '../../src/llm/fixture.js';
import { OllamaProvider } from '../../src/llm/ollama.js';
import { requestKey, type LLMProvider, type LLMRequest, type LLMResponse } from '../../src/llm/provider.js';
import { assessNotam, buildAssessmentRequest, PROMPT_VERSION, validateAssessment, verifyCitation, type FlightContext, type NotamAssessment } from '../../src/notam/assess.js';
import { decodeNotam } from '../../src/notam/decode.js';
import { dedupeNotams } from '../../src/notam/dedupe.js';
import { scoreAssessments } from '../../src/notam/eval.js';
import { classifyNotam, scheduleIntervals } from '../../src/notam/filter.js';
import { notamsForFlight } from '../../src/notam/flight.js';
import { resolveFlight } from '../../src/resolve/flight.js';
import { MemoryStore } from '../../src/store/memory.js';
import { rawReport } from '../../src/store/types.js';
import { FIXTURES, replayHttp } from '../helpers/http.js';

const NOTAMS = join(__dirname, '..', 'fixtures', 'notam', 'navcanada', '2026-09-12');
const ROOT = join(__dirname, '..', '..', '..', '..');
const plan = parseFlightPlan(JSON.parse(readFileSync(join(ROOT, 'flights', 'demo-cysn-cykf.json'), 'utf8')));

const cfpsRoutes = Object.fromEntries(['CYSN', 'CYKF', 'CYHM'].map((s) => [`${NAVCANADA_CFPS_BASE_URL}?site=${s}&alpha=notam`, { status: 200, file: `../notam/navcanada/2026-09-12/${s}.json` }]));

function corpusRaw(id: string): string {
  for (const s of ['CYSN', 'CYKF', 'CYHM']) {
    const j = JSON.parse(readFileSync(join(NOTAMS, `${s}.json`), 'utf8')) as { data: { text: string }[] };
    for (const item of j.data) {
      const raw = (JSON.parse(item.text) as { raw: string }).raw;
      if (raw.startsWith(`(${id} `)) return raw;
    }
  }
  throw new Error(`no ${id} in corpus`);
}

/** The flight: 2026-09-14, departing CYSN 15:00Z, at CYKF about 15:32Z, alternate CYHM ~15:46Z. */
const window = { start: new Date('2026-09-14T14:00:00Z'), end: new Date('2026-09-14T16:46:00Z') };
const route = [
  { lat: 43.1916, lon: -79.1717 },
  { lat: 43.4608, lon: -80.3786 },
  { lat: 43.1713, lon: -79.9294 },
];

describe('scheduleIntervals', () => {
  const validity = { start: new Date('2026-09-14T04:00:00Z'), end: new Date('2026-09-18T10:59:00Z') };
  it('expands DAILY within validity', () => {
    const ivs = scheduleIntervals('DAILY 0400-1059', validity)!;
    expect(ivs.length).toBe(5);
    expect(ivs[0]!.start.toISOString()).toBe('2026-09-14T04:00:00.000Z');
    expect(ivs[0]!.end.toISOString()).toBe('2026-09-14T10:59:00.000Z');
  });
  it('expands month/day lists and handles a range crossing midnight', () => {
    const ivs = scheduleIntervals('SEP 11 14 1100-2100, SEP 15 1000-1800', { start: new Date('2026-09-11T00:00Z'), end: new Date('2026-09-17T21:00Z') })!;
    expect(ivs.map((i) => i.start.toISOString().slice(0, 13))).toEqual(['2026-09-11T11', '2026-09-14T11', '2026-09-15T10']);
    const night = scheduleIntervals('DAILY 2200-0400', { start: new Date('2026-09-14T00:00Z'), end: new Date('2026-09-14T23:59Z') })!;
    expect(night[0]!.end.toISOString()).toBe('2026-09-15T04:00:00.000Z');
  });
  it('returns null for anything it cannot read', () => {
    expect(scheduleIntervals('MON-FRI 1200-1800', validity)).toBeNull();
    expect(scheduleIntervals('SR-SS', validity)).toBeNull();
  });
});

describe('classifyNotam', () => {
  it('an active runway closure at the departure field is in scope and near', () => {
    const c = classifyNotam(decodeNotam(corpusRaw('J5067/26')), window, route);
    expect(c.time).toBe('active');
    expect(c.near).toBe(true);
    expect(c.inScope).toBe(true);
    expect(c.distanceNm).toBeLessThan(2);
  });
  it('a FIR-wide GPS exercise with a DAILY 0400-1059 schedule is schedule-inactive for a 15Z flight', () => {
    const c = classifyNotam(decodeNotam(corpusRaw('G3263/26')), window, route);
    expect(c.scheduleUnderstood).toBe(true);
    expect(c.time).toBe('schedule-inactive');
    expect(c.inScope).toBe(false);
    expect(c.reasons.join(' ')).toContain('within its 294 nm radius');
    // …but during its hours it is active.
    const early = classifyNotam(decodeNotam(corpusRaw('G3263/26')), { start: new Date('2026-09-14T05:00Z'), end: new Date('2026-09-14T06:00Z') }, route);
    expect(early.time).toBe('active');
    expect(early.inScope).toBe(true);
  });
  it('a threshold displacement with day-list schedule is active on a listed day and not on an unlisted one', () => {
    const n = decodeNotam(corpusRaw('J6230/26'));
    expect(classifyNotam(n, window, route).time).toBe('active');
    const sep13 = { start: new Date('2026-09-13T14:00Z'), end: new Date('2026-09-13T17:00Z') };
    expect(classifyNotam(n, sep13, route).time).toBe('schedule-inactive');
  });
  it('a NOTAM that expired before the flight or starts after it is out of scope but still classified', () => {
    const n = decodeNotam(corpusRaw('J5067/26'));
    expect(classifyNotam(n, { start: new Date('2026-12-01T00:00Z'), end: new Date('2026-12-01T02:00Z') }, route).time).toBe('expired');
    expect(classifyNotam(n, { start: new Date('2026-07-01T00:00Z'), end: new Date('2026-07-01T02:00Z') }, route).time).toBe('not-yet-effective');
  });
  it('a distant obstacle is not near; an unreadable schedule and a missing position are treated conservatively', () => {
    const far = classifyNotam(decodeNotam(corpusRaw('J5068/26')), window, [{ lat: 49, lon: -97 }]);
    expect(far.near).toBe(false);
    expect(far.inScope).toBe(false);
    const raw = '(A0001/26 NOTAMN Q) CZYZ/QMRLC/IV/NBO/A/000/999 A) CYSN B) 2609140000 C) 2609150000 D) MON-FRI 1200-1800 E) RWY 06/24 CLSD)';
    const c = classifyNotam(decodeNotam(raw), window, route);
    expect(c.scheduleUnderstood).toBe(false);
    expect(c.time).toBe('active');
    expect(c.near).toBe(true);
    expect(c.reasons.join(' ')).toContain('not understood');
  });
});

describe('dedupeNotams', () => {
  it('folds the same NOTAM fetched via several sites and flags replaced ones', () => {
    const g = corpusRaw('G3263/26');
    const a = rawReport({ kind: 'notam', source: 'x', station: 'CYSN', body: g, issuedAt: null, upstream: null });
    const b = rawReport({ kind: 'notam', source: 'x', station: 'CYKF', body: g, issuedAt: null, upstream: null });
    const older = rawReport({ kind: 'notam', source: 'x', station: 'CYSN', body: '(J2786/26 NOTAMN Q) CZYZ/QMRLC/IV/NBO/A/000/999/4312N07910W005 A) CYSN B) 2607011200 C) 2610261200EST E) RWY 11/29 CLSD)', issuedAt: null, upstream: null });
    const newer = rawReport({ kind: 'notam', source: 'x', station: 'CYSN', body: corpusRaw('J5067/26'), issuedAt: null, upstream: null });
    const d = dedupeNotams([a, b, older, newer]);
    expect(d.map((x) => x.decoded.id?.value.text)).toEqual(['G3263/26', 'J2786/26', 'J5067/26']);
    expect(d[0]!.duplicates).toEqual([]); // identical content: one raw report, not a duplicate row
    expect(d[1]!.supersededBy).toBe('J5067/26');
    expect(d[2]!.supersededBy).toBeNull();
  });
});

const ctx: FlightContext = {
  departure: 'CYSN',
  destination: 'CYKF',
  alternate: 'CYHM',
  route: [],
  daylight: true,
  aerodromes: [
    { id: 'CYSN', role: 'departure', runways: ['01/19', '06/24', '11/29'] },
    { id: 'CYKF', role: 'destination', runways: ['08/26', '14/32'] },
    { id: 'CYHM', role: 'alternate', runways: ['06/24', '12/30'] },
  ],
  times: [
    { id: 'CYSN', eta: '2026-09-14T15:00:00.000Z' },
    { id: 'CYKF', eta: '2026-09-14T15:31:30.000Z' },
    { id: 'CYHM', eta: '2026-09-14T15:46:29.000Z' },
  ],
  aircraft: 'C172',
  flightRules: 'VFR',
  cruiseAltitudeFt: 3500,
  equipment: [],
};

const goodAnswer: NotamAssessment = {
  relevance: 'critical',
  category: 'runway',
  affects: ['departure'],
  plain_text: 'Runway 11/29 at St. Catharines is closed.',
  cited_span: 'RWY 11/29 CLSD',
  rationale: 'A departure-field runway is closed.',
};

function stub(answer: unknown, provider = 'stub'): LLMProvider & { calls: LLMRequest[] } {
  const calls: LLMRequest[] = [];
  return {
    id: provider,
    calls,
    async complete(req) {
      calls.push(req);
      const res: LLMResponse = { json: answer, text: JSON.stringify(answer), model: req.model, provider, usage: { input: 100, output: 50 } };
      return res;
    },
  };
}

describe('assessment', () => {
  const notam = decodeNotam(corpusRaw('J5067/26'));
  const report = rawReport({ kind: 'notam', source: 'x', station: 'CYSN', body: notam.raw, issuedAt: null, upstream: null });

  it('builds a prompt that carries the flight, the NOTAM metadata and the verbatim text', () => {
    const req = buildAssessmentRequest('qwen2.5:7b', notam, ctx);
    expect(req.prompt).toContain('C172, VFR, cruise 3500 ft MSL');
    expect(req.prompt).toContain('CYSN → CYKF, alternate CYHM');
    expect(req.prompt).toContain('Q code QMRLC');
    expect(req.prompt).toContain('RWY 11/29 CLSD');
    expect(req.schema).toBeTruthy();
    expect(requestKey(req)).toBe(requestKey(buildAssessmentRequest('qwen2.5:7b', notam, ctx)));
    expect(requestKey(req)).not.toBe(requestKey(buildAssessmentRequest('other', notam, ctx)));
  });

  it('validates model output strictly', () => {
    expect(validateAssessment(goodAnswer)).toEqual(goodAnswer);
    expect(validateAssessment({ ...goodAnswer, relevance: 'urgent' })).toBeNull();
    expect(validateAssessment({ ...goodAnswer, affects: ['everywhere'] })).toBeNull();
    expect(validateAssessment({ ...goodAnswer, cited_span: 42 })).toBeNull();
    expect(validateAssessment(null)).toBeNull();
    expect(validateAssessment({ ...goodAnswer, affects: ['departure', 'departure'] })!.affects).toEqual(['departure']);
  });

  it('verifies citations exactly, tolerating line wraps, and rejects the rest', () => {
    expect(verifyCitation(goodAnswer, notam)).toBe('exact');
    const wrapped = decodeNotam(corpusRaw('G3263/26'));
    expect(verifyCitation({ ...goodAnswer, cited_span: 'INFORM ATC OF ANY ADVERSE IMPACT' }, wrapped)).toBe('whitespace');
    expect(verifyCitation({ ...goodAnswer, cited_span: 'RWY 06/24 CLSD' }, notam)).toBe('none');
    expect(verifyCitation({ ...goodAnswer, cited_span: '' }, notam)).toBe('none');
  });

  it('caches on (notam, context, prompt version, model) and records the citation check', async () => {
    const store = new MemoryStore();
    await store.putRaw(report, { fetchedAt: new Date(0), request: 'x', station: null });
    const provider = stub(goodAnswer);
    const first = await assessNotam(provider, 'm1', store, report, notam, ctx, () => new Date('2026-09-12T00:00Z'));
    expect(first.cached).toBe(false);
    expect(first.row?.citation).toBe('exact');
    expect(first.row?.promptVersion).toBe(PROMPT_VERSION);
    const second = await assessNotam(provider, 'm1', store, report, notam, ctx);
    expect(second.cached).toBe(true);
    expect(provider.calls.length).toBe(1);
    await assessNotam(provider, 'm2', store, report, notam, ctx);
    expect(provider.calls.length).toBe(2);
    const otherFlight = await assessNotam(provider, 'm1', store, report, notam, { ...ctx, cruiseAltitudeFt: 5500 });
    expect(otherFlight.cached).toBe(false);
  });

  it('an invalid model answer is reported, not stored', async () => {
    const store = new MemoryStore();
    const out = await assessNotam(stub({ nonsense: true }), 'm', store, report, notam, ctx);
    expect(out.row).toBeNull();
    expect(out.invalid).toContain('failed validation');
    expect(await store.getAssessment(report.sha256, 'x', PROMPT_VERSION, 'm')).toBeNull();
  });
});

describe('providers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'depbrief-llm-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const req: LLMRequest = { model: 'm', system: 's', prompt: 'p', schema: { type: 'object' }, maxTokens: 10 };

  it('fixture provider throws for an unrecorded request and replays a recorded one', async () => {
    const fixture = new FixtureProvider(dir);
    expect(fixture.has(req)).toBe(false);
    await expect(fixture.complete(req)).rejects.toThrow(FixtureMissingError);
    const recording = new RecordingProvider(stub({ a: 1 }, 'real'), dir, () => new Date('2026-09-12T00:00Z'));
    const live = await recording.complete(req);
    expect(live.provider).toBe('real');
    expect(fixture.has(req)).toBe(true);
    const replayed = await fixture.complete(req);
    expect(replayed.json).toEqual({ a: 1 });
    expect(replayed.provider).toBe('fixture:real');
    const again = await recording.complete({ ...req });
    expect(again.json).toEqual({ a: 1 });
  });

  it('budgeted provider counts output tokens and refuses past the cap', async () => {
    const b = new BudgetedProvider(stub({ a: 1 }), 120);
    await b.complete(req);
    await b.complete(req);
    expect(b.spent).toBe(100);
    await b.complete(req);
    await expect(b.complete(req)).rejects.toThrow(BudgetExceededError);
  });

  it('ollama provider posts the schema as format, temperature 0, and parses the JSON content', async () => {
    let sent: unknown = null;
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ model: 'qwen2.5:7b', message: { content: '{"a":1}' }, prompt_eval_count: 12, eval_count: 3 }), { status: 200 });
    }) as unknown as typeof fetch;
    const o = new OllamaProvider({ baseUrl: 'http://ollama.test/', fetch: fakeFetch });
    const res = await o.complete({ ...req, model: 'qwen2.5:7b' });
    expect(res).toEqual({ json: { a: 1 }, text: '{"a":1}', model: 'qwen2.5:7b', provider: 'ollama', usage: { input: 12, output: 3 } });
    expect(sent).toMatchObject({ model: 'qwen2.5:7b', stream: false, format: { type: 'object' }, options: { temperature: 0, num_predict: 10 } });
    const down = new OllamaProvider({ baseUrl: 'http://ollama.test', fetch: (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch });
    await expect(down.complete(req)).rejects.toThrow('HTTP 503');
    const unreachable = new OllamaProvider({ baseUrl: 'http://ollama.test', fetch: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch });
    await expect(unreachable.complete(req)).rejects.toThrow('cannot reach Ollama');
  });
});

async function seededStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.putAirports(readOurAirportsDirectory(join(FIXTURES, 'ourairports', '2026-09-07'), { snapshot: '2026-09-07' }));
  // Weather is not what this test is about, but resolveFlight wants a store; reuse the recorded US responses' shape with 204s.
  const awc = new AwcClient(replayHttp(Object.fromEntries(['CYSN', 'CYKF', 'CYHM'].flatMap((s) => [[`${AWC_BASE_URL}/metar?ids=${s}&format=json`, { status: 204 }], [`${AWC_BASE_URL}/taf?ids=${s}&format=json`, { status: 204 }]]))));
  for (const s of ['CYSN', 'CYKF', 'CYHM']) {
    const m = await awc.metars([s]);
    await storeAndDecode(store, m.reports, m.request, new Date('2026-09-12T12:00Z'));
  }
  return store;
}

describe('notamsForFlight', () => {
  const asOf = new Date('2026-09-12T20:00:00Z');
  const flightPlan = { ...plan, departureTime: '2026-09-14T15:00:00.000Z' };

  it('fetches per site, dedupes across sites, classifies everything, and shows every NOTAM', async () => {
    const store = await seededStore();
    const resolved = await resolveFlight(store, flightPlan, asOf);
    const nb = await notamsForFlight({ store, navcanada: new NavCanadaClient(replayHttp(cfpsRoutes)), now: () => asOf }, resolved, 'C172');
    expect(nb.sites).toEqual(['CYSN', 'CYKF', 'CYHM']);
    expect(nb.fetchErrors).toEqual([]);
    expect(nb.model).toBeNull();
    // 41 records, 30-something distinct NOTAMs; the FIR-wide ones list all three sites.
    expect(nb.items.length).toBeGreaterThan(25);
    expect(nb.items.length).toBeLessThan(41);
    const gps = nb.items.find((i) => i.decoded.id?.value.text === 'G3263/26')!;
    expect(gps.sites).toEqual(['CYHM', 'CYKF', 'CYSN']);
    expect(gps.rank).toBe('out-of-scope');
    // A runway closure at the departure aerodrome is critical by rule, model or no model.
    const closure = nb.items.find((i) => i.decoded.id?.value.text === 'J5067/26')!;
    expect(closure.rank).toBe('critical');
    expect(closure.rule?.rule).toBe('runway.used-aerodrome');
    expect(closure.classification.inScope).toBe(true);
    // A lighting outage is advisory by rule for a daylight flight, no model needed.
    const papi = nb.items.find((i) => i.decoded.id?.value.text === 'J6192/26')!;
    expect(papi.rank).toBe('advisory');
    expect(papi.rule?.rule).toBe('lighting.daylight-flight');
    // Whereas a taxiway closure needs judgement, and there is no model here.
    const taxiway = nb.items.find((i) => i.decoded.id?.value.text === 'J5066/26')!;
    expect(taxiway.rank).toBe('not-assessed');
    expect(taxiway.rule).toBeNull();
    // Ranking puts in-scope items before out-of-scope, and counts add up.
    const ranks = nb.items.map((i) => i.rank);
    expect(ranks.indexOf('out-of-scope')).toBeGreaterThan(ranks.lastIndexOf('not-assessed'));
    expect(Object.values(nb.counts).reduce((a, b) => a + b, 0)).toBe(nb.items.length);
    // Stored: a second run without fetching sees the same set.
    const again = await notamsForFlight({ store, now: () => asOf }, resolved, 'C172');
    expect(again.items.length).toBe(nb.items.length);
  });

  it('assesses only in-scope NOTAMs, verifies citations, ranks unverified below advisory, and caches', async () => {
    const store = await seededStore();
    const resolved = await resolveFlight(store, flightPlan, asOf);
    // A stub that cites correctly for the runway closure and fabricates for everything else.
    const provider: LLMProvider & { calls: LLMRequest[] } = {
      id: 'stub',
      calls: [],
      async complete(req) {
        this.calls.push(req);
        const cites = req.prompt.includes('TWY D CLSD') ? 'TWY D CLSD' : 'NOT IN THE NOTAM';
        const answer = { ...goodAnswer, relevance: cites === 'TWY D CLSD' ? 'critical' : 'advisory', cited_span: cites };
        return { json: answer, text: JSON.stringify(answer), model: req.model, provider: 'stub', usage: { input: 1, output: 1 } };
      },
    };
    const nb = await notamsForFlight({ store, navcanada: new NavCanadaClient(replayHttp(cfpsRoutes)), provider, model: 'stub-model', now: () => asOf }, resolved, 'C172');
    expect(nb.model).toBe('stub-model');
    // The model is asked only about in-scope NOTAMs that no rule settles.
    const inScope = nb.items.filter((i) => i.classification.inScope);
    const byRule = inScope.filter((i) => i.rule);
    const asked = inScope.length - byRule.length;
    expect(provider.calls.length).toBe(asked);
    expect(byRule.length).toBeGreaterThan(5);
    expect(byRule.map((i) => i.decoded.id?.value.text)).toEqual(expect.arrayContaining(['J5067/26', 'J5069/26', 'J6230/26', 'D3745/26', 'J6015/26', 'G3032/26', 'J6192/26']));
    // Rule-decided criticals plus the one the stub called critical with an exact citation.
    expect(nb.counts.critical).toBe(byRule.filter((i) => i.rule!.relevance === 'critical').length + 1);
    expect(nb.counts.unverified).toBe(asked - 1);
    const taxiway = nb.items.find((i) => i.decoded.id?.value.text === 'J5066/26')!;
    expect(taxiway.rank).toBe('critical');
    expect(taxiway.assessment?.citation).toBe('exact');
    expect(nb.items[0]!.rank).toBe('critical');
    expect(nb.items.filter((i) => i.rank === 'unverified').every((i) => i.assessment?.citation === 'none')).toBe(true);
    // Second run: everything served from the cache.
    const again = await notamsForFlight({ store, provider, model: 'stub-model', now: () => asOf }, resolved, 'C172');
    expect(provider.calls.length).toBe(asked);
    expect(again.items.every((i) => !i.assessment || i.assessmentCached)).toBe(true);
  });

  it('keeps what it fetched for itself even though the fetch lands after the briefing instant', async () => {
    const store = await seededStore();
    const resolved = await resolveFlight(store, flightPlan, asOf);
    // The fetch happens a minute after `asOf` — exactly what a live briefing does.
    const later = new Date(asOf.getTime() + 60_000);
    const nb = await notamsForFlight({ store, navcanada: new NavCanadaClient(replayHttp(cfpsRoutes)), now: () => later }, resolved, 'C172');
    expect(nb.items.length).toBeGreaterThan(25);

    // Reproducibility is intact: briefing an instant after the fetch, without
    // fetching, sees the same set; briefing an instant before it sees none,
    // because at that moment they genuinely were not known yet.
    const after = await resolveFlight(store, flightPlan, new Date(later.getTime() + 60_000));
    expect((await notamsForFlight({ store }, after, 'C172')).items.length).toBe(nb.items.length);
    const before = await resolveFlight(store, flightPlan, new Date(asOf.getTime() - 60_000));
    expect((await notamsForFlight({ store }, before, 'C172')).items).toEqual([]);
  });

  it('asks CFPS once per site per half hour, however many briefings pass through', async () => {
    const store = await seededStore();
    const http = replayHttp(cfpsRoutes);
    const navcanada = new NavCanadaClient(http);

    const first = await notamsForFlight({ store, navcanada, now: () => asOf }, await resolveFlight(store, flightPlan, asOf), 'C172');
    const asked = http.calls.length;
    expect(asked).toBe(3);
    expect(first.items.length).toBeGreaterThan(25);

    // Ten minutes later, the same route: every site was asked about within
    // the window, so nothing goes upstream and the same NOTAMs come back.
    const tenMinutes = new Date(asOf.getTime() + 10 * 60_000);
    const again = await notamsForFlight({ store, navcanada, now: () => tenMinutes }, await resolveFlight(store, flightPlan, tenMinutes), 'C172');
    expect(http.calls.length).toBe(asked);
    expect(again.items.length).toBe(first.items.length);
    expect(again.fetchErrors).toEqual([]);

    // Past the window it asks again.
    const later = new Date(asOf.getTime() + 31 * 60_000);
    await notamsForFlight({ store, navcanada, now: () => later }, await resolveFlight(store, flightPlan, later), 'C172');
    expect(http.calls.length).toBe(asked * 2);
  });

  it('a fetch failure for one site is reported and the rest still works', async () => {
    const store = await seededStore();
    const resolved = await resolveFlight(store, flightPlan, asOf);
    const routes = { ...cfpsRoutes, [`${NAVCANADA_CFPS_BASE_URL}?site=CYKF&alpha=notam`]: { status: 503, body: 'down' } };
    const nb = await notamsForFlight({ store, navcanada: new NavCanadaClient(replayHttp(routes)), now: () => asOf }, resolved, 'C172');
    expect(nb.fetchErrors).toEqual([{ site: 'CYKF', error: expect.stringContaining('503') }]);
    expect(nb.items.length).toBeGreaterThan(10);
  });
});

describe('scoreAssessments', () => {
  it('computes agreement, per-class precision/recall, confusion and disagreements', async () => {
    const store = await seededStore();
    const resolved = await resolveFlight(store, { ...plan, departureTime: '2026-09-14T15:00:00.000Z' }, new Date('2026-09-12T20:00Z'));
    const provider = stub({ ...goodAnswer, relevance: 'advisory', cited_span: 'CLSD' });
    const nb = await notamsForFlight({ store, navcanada: new NavCanadaClient(replayHttp(cfpsRoutes)), provider, model: 'm', now: () => new Date('2026-09-12T20:00Z') }, resolved, 'C172');
    const score = scoreAssessments(
      {
        flight: 'demo-cysn-cykf',
        description: 'test',
        labels: [
          { notamId: 'J5067/26', relevance: 'critical', category: 'runway', labelledBy: 'test', note: null },
          { notamId: 'J5066/26', relevance: 'advisory', category: 'taxiway', labelledBy: 'test', note: null },
          { notamId: 'G3263/26', relevance: 'irrelevant', category: null, labelledBy: 'test', note: 'out of scope → no assessment' },
        ],
      },
      nb.items,
    );
    expect(score.total).toBe(3);
    // G3263 is out of scope by schedule, so the model was never asked: filtered, not a miss.
    expect(score.filtered).toBe(1);
    expect(score.missing).toBe(0);
    // J5067 is critical by rule (the stub was not asked); J5066 the stub called advisory.
    expect(score.agreement).toBe(1);
    expect(score.confusion.critical.critical).toBe(1);
    expect(score.confusion.advisory.advisory).toBe(1);
    expect(score.perClass.advisory.precision).toBe(1);
    // Category agreement counts only model-assessed items.
    expect(score.categoryAgreement).toBe(goodAnswer.category === 'taxiway' ? 1 : 0);
    expect(score.disagreements).toEqual([]);

    // The same labels against a stub that gets the taxiway wrong: the rule still carries the closure.
    const wrong = await notamsForFlight({ store: await seededStore(), navcanada: new NavCanadaClient(replayHttp(cfpsRoutes)), provider: stub({ ...goodAnswer, relevance: 'irrelevant', cited_span: 'CLSD' }), model: 'm', now: () => new Date('2026-09-12T20:00Z') }, resolved, 'C172');
    const s2 = scoreAssessments({ flight: 'demo-cysn-cykf', description: 'test', labels: [{ notamId: 'J5067/26', relevance: 'critical', category: 'runway', labelledBy: 'test', note: null }, { notamId: 'J5066/26', relevance: 'advisory', category: 'taxiway', labelledBy: 'test', note: null }] }, wrong.items);
    expect(s2.agreement).toBe(0.5);
    expect(s2.disagreements).toEqual([{ notamId: 'J5066/26', expected: 'advisory', actual: 'irrelevant' }]);
  });

  it('a model that declines to answer does not keep its agreement', async () => {
    /*
     * The hole this closes: agreement is computed over the NOTAMs the
     * model answered usably, so a model whose citations never verify
     * answers nothing, disagrees with nothing, and scored 100%. The one
     * NOTAM here that still scores is settled by a deterministic rule —
     * the runway closure — which is exactly the kind of "answer" a bad
     * model would be carried by.
     */
    const store = await seededStore();
    const resolved = await resolveFlight(store, { ...plan, departureTime: '2026-09-14T15:00:00.000Z' }, new Date('2026-09-12T20:00Z'));
    const evasive = stub({ ...goodAnswer, relevance: 'advisory', cited_span: 'THIS TEXT IS IN NO NOTAM' });
    const nb = await notamsForFlight({ store, navcanada: new NavCanadaClient(replayHttp(cfpsRoutes)), provider: evasive, model: 'm', now: () => new Date('2026-09-12T20:00Z') }, resolved, 'C172');
    const score = scoreAssessments(
      {
        flight: 'demo-cysn-cykf',
        description: 'test',
        labels: [
          { notamId: 'J5067/26', relevance: 'critical', category: 'runway', labelledBy: 'test', note: 'settled by rule, never asked' },
          { notamId: 'J5066/26', relevance: 'advisory', category: 'taxiway', labelledBy: 'test', note: null },
        ],
      },
      nb.items,
    );
    // Agreement alone says this model is perfect.
    expect(score.missing).toBe(1);
    expect(score.agreement).toBe(1);
    // Coverage says it answered half of what it was asked. The gate reads both.
    expect(score.coverage).toBe(0.5);
  });
});
