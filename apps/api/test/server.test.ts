/**
 * The API over a memory store seeded from the recorded AWC responses and
 * the NASR fixture slice, driven with fastify.inject. No network, no
 * database.
 */
import { AWC_BASE_URL, AwcClient, MemoryStore, readNasrDirectory, type HttpClient, type StoredBriefing } from '@holdshort/core';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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

async function makeApp(staticDir: string | null = null) {
  const store = new MemoryStore();
  await store.putAirports(readNasrDirectory(join(FIXTURES, 'fetch', 'nasr', '2026-09-03')));
  return buildServer({ store, awc: new AwcClient(replay(routes)), staticDir });
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
    expect(b.document.briefing.verdict).toBe('go');
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

  it('with fetch:false uses only what the store already has', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/briefings', payload: { plan, profile, fetch: false, asOf: '2026-09-07T12:30:00Z' } });
    expect(res.statusCode).toBe(201);
    const b = res.json() as StoredBriefing;
    expect(b.document.briefing.verdict).toBe('marginal');
    expect(b.document.inputs.reports).toEqual([]);
  });
});

describe('GET /api/airports/:id', () => {
  it('returns the stored airport or 404', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/airports/kteb' })).json().icaoId).toBe('KTEB');
    expect((await app.inject({ method: 'GET', url: '/api/airports/KZZZ' })).statusCode).toBe(404);
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
