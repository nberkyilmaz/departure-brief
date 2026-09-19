/**
 * The API over a memory store seeded from the recorded AWC responses and
 * the NASR fixture slice, driven with fastify.inject. No network, no
 * database.
 */
import {
  AWC_BASE_URL,
  AwcClient,
  BudgetedProvider,
  MemoryStore,
  NAVCANADA_CFPS_BASE_URL,
  NavCanadaClient,
  readNasrDirectory,
  readOurAirportsDirectory,
  type HttpClient,
  type LLMProvider,
  type StoredBriefing,
} from '@holdshort/core';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fixedWindow, type RateLimit } from '../src/ratelimit.js';
import { buildServer } from '../src/server.js';

const FIXTURES = join(__dirname, '..', '..', '..', 'packages', 'core', 'test', 'fixtures');
const ROOT = join(__dirname, '..', '..', '..');

function replay(routes: Record<string, { status: number; file?: string; body?: string }>): HttpClient {
  return {
    async get(url) {
      const r = routes[url];
      if (!r) throw new Error(`no recorded response for ${url}`);
      return { status: r.status, body: r.file ? readFileSync(join(FIXTURES, 'fetch', r.file), 'utf8') : (r.body ?? ''), headers: {} };
    },
  };
}

const three = { status: 200, file: 'awc/metar-KJFK-KTEB-KHPN.json' };
const threeTaf = { status: 200, file: 'awc/taf-KJFK-KTEB-KHPN.json' };
const routes: Record<string, { status: number; file?: string; body?: string }> = {};
for (const id of ['KTEB', 'N07', 'KHPN', 'KJFK']) {
  routes[`${AWC_BASE_URL}/metar?ids=${id}&format=json`] = id === 'N07' ? { status: 204 } : three;
  routes[`${AWC_BASE_URL}/taf?ids=${id}&format=json`] = id === 'N07' ? { status: 204 } : threeTaf;
}
// Hazard advisories: nothing in force, which is what the service says most days.
routes[`${AWC_BASE_URL}/isigmet?format=json`] = { status: 204 };
routes[`${AWC_BASE_URL}/airsigmet?format=json`] = { status: 204 };

async function makeApp(staticDir: string | null = null) {
  const store = new MemoryStore();
  await store.putAirports(readNasrDirectory(join(FIXTURES, 'fetch', 'nasr', '2026-09-03')));
  return buildServer({ store, awc: new AwcClient(replay(routes)), staticDir });
}

/** The same app with every upstream call recorded, for asserting what a request costs. */
async function makeCountingApp(opts: { rateLimit?: RateLimit | null } = {}) {
  const store = new MemoryStore();
  await store.putAirports(readNasrDirectory(join(FIXTURES, 'fetch', 'nasr', '2026-09-03')));
  const calls: string[] = [];
  const inner = replay(routes);
  const counted: HttpClient = {
    get(url, init) {
      calls.push(url);
      return inner.get(url, init);
    },
  };
  return { app: buildServer({ store, awc: new AwcClient(counted), ...opts }), calls };
}

const plan = JSON.parse(readFileSync(join(ROOT, 'flights', 'demo-kteb-khpn.json'), 'utf8'));
const profile = JSON.parse(readFileSync(join(ROOT, 'profiles', 'default.json'), 'utf8'));

describe('GET /api/health', () => {
  it('answers and says what it is not', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().notOperational).toContain('not an official briefing');
  });
});

describe('POST /api/briefings', () => {
  it('fetches, resolves, judges, stores and returns a content-addressed briefing', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/briefings', payload: { plan, profile, asOf: '2026-09-07T12:30:00Z' } });
    expect(res.statusCode).toBe(201);
    const b = res.json() as StoredBriefing;
    expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
    // N07 reports nothing itself, so the nearest current observation stands in.
    expect(b.document.briefing.points.map((p) => p.category)).toEqual(['VFR', 'VFR', 'VFR']);
    expect(b.document.briefing.points[1]!.findings.some((f) => f.rule === 'observation.borrowed')).toBe(true);
    expect(b.document.briefing.points.map((p) => p.waypoint)).toEqual(['KTEB', 'N07', 'KHPN']);
    expect(b.document.inputs.reports.length).toBe(6);

    const again = await app.inject({ method: 'POST', url: '/api/briefings', payload: { plan, profile, asOf: '2026-09-07T12:30:00Z' } });
    expect(again.statusCode).toBe(200);
    expect((again.json() as StoredBriefing).sha256).toBe(b.sha256);

    const get = await app.inject({ method: 'GET', url: `/api/briefings/${b.sha256}` });
    expect(get.statusCode).toBe(200);
    expect((get.json() as StoredBriefing).document.asOf).toBe('2026-09-07T12:30:00.000Z');

    const list = await app.inject({ method: 'GET', url: `/api/briefings?flightKey=${b.flightKey}` });
    expect((list.json() as StoredBriefing[]).map((x) => x.sha256)).toEqual([b.sha256]);
  });

  it('rejects a bad plan with 400 and an unknown waypoint with 422', async () => {
    const app = await makeApp();
    const bad = await app.inject({ method: 'POST', url: '/api/briefings', payload: { plan: { departure: 'KTEB' } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('destination');
    const unknown = await app.inject({ method: 'POST', url: '/api/briefings', payload: { plan: { ...plan, route: ['KZZZ'] }, profile, fetch: false } });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().error).toContain('KZZZ');
  });

  it('asks upstream for nothing until the route is known good', async () => {
    // Checking waypoints against the airport data costs nothing; fetching
    // first meant a plan naming a field that does not exist still spent
    // somebody else's capacity before being rejected.
    const { app, calls } = await makeCountingApp();
    const res = await app.inject({ method: 'POST', url: '/api/briefings', payload: { plan: { ...plan, route: ['KZZZ'] }, profile } });
    expect(res.statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it('asks upstream as little as the plan allows', async () => {
    const { app, calls } = await makeCountingApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/briefings',
      // KJFK named twice over in the route, and again as the alternate.
      payload: { plan: { ...plan, route: ['N07', 'KJFK', 'KJFK'] }, profile, asOf: '2026-09-07T12:30:00Z' },
    });
    expect(res.statusCode).toBe(201);
    /*
     * One METAR and one TAF request in total, for a plan naming five points.
     * A repeated waypoint was never a second request; the first response
     * carried KHPN and KJFK as well as KTEB, so by the time those came round
     * the freshness window already had them. Then the two hazard feeds,
     * which are not per station: they are the whole world, once, however
     * many aerodromes the plan names.
     */
    expect(calls).toEqual([
      `${AWC_BASE_URL}/metar?ids=KTEB&format=json`,
      `${AWC_BASE_URL}/taf?ids=KTEB&format=json`,
      `${AWC_BASE_URL}/isigmet?format=json`,
      `${AWC_BASE_URL}/airsigmet?format=json`,
    ]);
    // N07 has no ICAO identifier, so there are no reports filed under it to ask for.
    expect(calls.some((u) => u.includes('N07'))).toBe(false);
  });

  it('asks for the hazard feeds once, not once per briefing', async () => {
    const { app, calls } = await makeCountingApp();
    const payload = { plan, profile, asOf: '2026-09-07T12:30:00Z' };
    await app.inject({ method: 'POST', url: '/api/briefings', payload });
    const first = calls.filter((u) => u.includes('sigmet')).length;
    expect(first).toBe(2);
    await app.inject({ method: 'POST', url: '/api/briefings', payload });
    // A quarter of an hour is as often as anybody needs the world's worth
    // of advisories, however many people are briefing.
    expect(calls.filter((u) => u.includes('sigmet')).length).toBe(first);
  });

  it('refuses a caller asking far too often, and says when to come back', async () => {
    const { app } = await makeCountingApp({ rateLimit: fixedWindow({ limit: 1, windowMs: 60_000 }) });
    const payload = { plan, profile, fetch: false, asOf: '2026-09-07T12:30:00Z' };
    expect((await app.inject({ method: 'POST', url: '/api/briefings', payload })).statusCode).toBe(201);
    const again = await app.inject({ method: 'POST', url: '/api/briefings', payload });
    expect(again.statusCode).toBe(429);
    expect(again.headers['retry-after']).toBe('60');
    expect(again.json().error).toContain('try again in 60s');
  });

  it('with fetch:false uses only what the store already has', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/briefings', payload: { plan, profile, fetch: false, asOf: '2026-09-07T12:30:00Z' } });
    expect(res.statusCode).toBe(201);
    const b = res.json() as StoredBriefing;
    expect(b.document.briefing.points.every((p) => p.forecastCategory === null)).toBe(true);
    expect(b.document.inputs.reports).toEqual([]);
  });
});

describe('GET /api/briefings/:sha256/diff', () => {
  it('404s when there is nothing to compare against, then diffs against the previous briefing of the flight', async () => {
    const app = await makeApp();
    const first = (await app.inject({ method: 'POST', url: '/api/briefings', payload: { plan, profile, asOf: '2026-09-07T11:00:00Z' } })).json() as StoredBriefing;
    const none = await app.inject({ method: 'GET', url: `/api/briefings/${first.sha256}/diff` });
    expect(none.statusCode).toBe(404);
    expect(none.json().error).toContain('no earlier briefing');

    // Later, with the TAFs known: the coverage findings resolve.
    const second = (await app.inject({ method: 'POST', url: '/api/briefings', payload: { plan, profile, asOf: '2026-09-07T12:30:00Z' } })).json() as StoredBriefing;
    const res = await app.inject({ method: 'GET', url: `/api/briefings/${second.sha256}/diff` });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.quiet).toBe(false);
    // What changed is stated as changes, with no verdict rolled up over them.
    expect('verdict' in d).toBe(false);
    expect(d.points.flatMap((p: { changes: { kind: string; rule: string }[] }) => p.changes).some((c: { kind: string; rule: string }) => c.kind === 'resolved' && c.rule === 'forecast.coverage')).toBe(true);
    expect(d.from.sha256).toBe(first.sha256);

    // An explicit `against`, and an unknown one.
    const explicit = await app.inject({ method: 'GET', url: `/api/briefings/${second.sha256}/diff?against=${first.sha256}` });
    expect(explicit.json().from.sha256).toBe(first.sha256);
    expect((await app.inject({ method: 'GET', url: `/api/briefings/${second.sha256}/diff?against=${'0'.repeat(64)}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/briefings/${'0'.repeat(64)}/diff` })).statusCode).toBe(404);
  });

  it('never compares a briefing with a later one, however they were stored', async () => {
    const app = await makeApp();
    // Store the later briefing first, then an earlier one.
    const later = (await app.inject({ method: 'POST', url: '/api/briefings', payload: { plan, profile, asOf: '2026-09-07T12:30:00Z' } })).json() as StoredBriefing;
    const earlier = (await app.inject({ method: 'POST', url: '/api/briefings', payload: { plan, profile, asOf: '2026-09-07T11:00:00Z' } })).json() as StoredBriefing;
    // The earlier one has nothing before it, even though a newer briefing exists.
    expect((await app.inject({ method: 'GET', url: `/api/briefings/${earlier.sha256}/diff` })).statusCode).toBe(404);
    // The later one compares against the earlier one, forwards in time.
    const d = (await app.inject({ method: 'GET', url: `/api/briefings/${later.sha256}/diff` })).json();
    expect(d.from.sha256).toBe(earlier.sha256);
    expect(new Date(d.from.asOf).getTime()).toBeLessThan(new Date(d.to.asOf).getTime());
  });

  it('a re-brief of an unchanged situation is the same briefing, so there is nothing to diff', async () => {
    const app = await makeApp();
    const a = (await app.inject({ method: 'POST', url: '/api/briefings', payload: { plan, profile, asOf: '2026-09-07T12:30:00Z' } })).json() as StoredBriefing;
    const b = (await app.inject({ method: 'POST', url: '/api/briefings', payload: { plan, profile, asOf: '2026-09-07T12:30:00Z' } })).json() as StoredBriefing;
    expect(b.sha256).toBe(a.sha256);
    expect((await app.inject({ method: 'GET', url: `/api/briefings/${a.sha256}/diff` })).statusCode).toBe(404);
  });
});

describe('GET /api/airports/:id', () => {
  it('returns the stored airport or 404', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/airports/kteb' })).json().icaoId).toBe('KTEB');
    expect((await app.inject({ method: 'GET', url: '/api/airports/KZZZ' })).statusCode).toBe(404);
  });
});

describe('POST /api/briefings with NOTAMs', () => {
  const cfps: Record<string, { status: number; file?: string; body?: string }> = {};
  for (const s of ['CYSN', 'CYKF', 'CYHM']) cfps[`${NAVCANADA_CFPS_BASE_URL}?site=${s}&alpha=notam`] = { status: 200, file: `../notam/navcanada/2026-09-12/${s}.json` };
  const awcCa: Record<string, { status: number; file?: string; body?: string }> = {};
  for (const s of ['CYSN', 'CYKF', 'CYHM']) {
    awcCa[`${AWC_BASE_URL}/metar?ids=${s}&format=json`] = { status: 204 };
    awcCa[`${AWC_BASE_URL}/taf?ids=${s}&format=json`] = { status: 204 };
  }
  const caPlan = JSON.parse(readFileSync(join(ROOT, 'flights', 'demo-cysn-cykf.json'), 'utf8'));

  async function makeCaApp(withModel: boolean) {
    const store = new MemoryStore();
    await store.putAirports(readOurAirportsDirectory(join(FIXTURES, 'fetch', 'ourairports', '2026-09-07'), { snapshot: '2026-09-07' }));
    const stub: LLMProvider = {
      id: 'stub',
      async complete(req) {
        const answer = { relevance: 'advisory', category: 'other', affects: ['departure'], plain_text: 'stub', cited_span: req.prompt.includes('RWY 11/29 CLSD') ? 'RWY 11/29 CLSD' : 'zzz', rationale: 'stub' };
        return { json: answer, text: JSON.stringify(answer), model: req.model, provider: 'stub', usage: { input: 1, output: 1 } };
      },
    };
    return buildServer({
      store,
      awc: new AwcClient(replay(awcCa)),
      navcanada: new NavCanadaClient(replay(cfps)),
      llm: withModel ? { provider: new BudgetedProvider(stub, 10_000), model: 'stub-model', description: 'stub' } : null,
    });
  }

  it('includes classified NOTAMs in the document and reports the NOTAM source and model on /api/health', async () => {
    const app = await makeCaApp(false);
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.json()).toMatchObject({ notams: 'navcanada-cfps', model: null });
    const res = await app.inject({ method: 'POST', url: '/api/briefings', payload: { plan: caPlan, profile, asOf: '2026-09-12T20:00:00Z' } });
    expect(res.statusCode).toBe(201);
    const b = res.json() as StoredBriefing;
    expect(b.document.format).toBe(2);
    expect(b.document.notams?.sites).toEqual(['CYSN', 'CYKF', 'CYHM']);
    expect(b.document.notams?.items.length).toBeGreaterThan(25);
    expect(b.document.notams?.model).toBeNull();
    expect(b.document.notams?.counts['not-assessed']).toBeGreaterThan(0);
    // Every NOTAM is a report the briefing cites by hash.
    expect(b.document.inputs.reports.filter((r) => r.kind === 'notam').length).toBe(b.document.notams?.items.length);
  });

  it('ranks with the configured model, marking unverifiable citations, and skips NOTAMs when asked', async () => {
    const app = await makeCaApp(true);
    const res = await app.inject({ method: 'POST', url: '/api/briefings', payload: { plan: caPlan, profile, asOf: '2026-09-12T20:00:00Z' } });
    const b = res.json() as StoredBriefing;
    expect(b.document.notams?.model).toBe('stub-model');
    // The departure runway closure is critical by rule; the model is not consulted about it.
    const closure = b.document.notams!.items.find((i) => i.id === 'J5067/26')!;
    expect(closure.rank).toBe('critical');
    expect(closure.rule?.rule).toBe('runway.used-aerodrome');
    expect(closure.assessment).toBeNull();
    // Everything the stub was asked about it cited badly, so those rank unverified.
    expect(b.document.notams!.counts.unverified).toBeGreaterThan(0);
    expect(b.document.notams!.items[0]!.rank).toBe('critical');

    const without = await app.inject({ method: 'POST', url: '/api/briefings', payload: { plan: caPlan, profile, asOf: '2026-09-12T20:00:00Z', notams: false } });
    expect((without.json() as StoredBriefing).document.notams).toBeNull();
    expect((without.json() as StoredBriefing).sha256).not.toBe(b.sha256);
  });
});

describe('static web app', () => {
  const dir = mkdtempSync(join(tmpdir(), 'holdshort-web-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Hold Short</title>');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('serves index.html at / and for unknown non-API paths; API 404s stay JSON', async () => {
    const app = await makeApp(dir);
    expect((await app.inject({ method: 'GET', url: '/' })).body).toContain('Hold Short');
    expect((await app.inject({ method: 'GET', url: '/briefings/abc' })).body).toContain('Hold Short');
    const api = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: 'not found' });
  });
});
