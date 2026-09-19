/**
 * How this server behaves on a host rather than on a laptop.
 *
 * Everything here is a difference between the two: a database that starts
 * empty, a proxy between the server and everybody who talks to it, a page
 * served from another origin, and weather services that are owed a limit
 * nobody can talk their way past. Each of these was found by reading the
 * code for what a deployment would do to it, and each would have been a
 * live instance that looked fine and was not.
 */
import { AwcClient, MemoryStore, readNasrDirectory, type HttpClient } from '@holdshort/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixedWindow } from '../src/ratelimit.js';
import { buildServer, type InstanceStatus } from '../src/server.js';

const FIXTURES = join(__dirname, '..', '..', '..', 'packages', 'core', 'test', 'fixtures');
const ROOT = join(__dirname, '..', '..', '..');

const noNetwork: HttpClient = {
  async get(url) {
    throw new Error(`no request should have been made, but something asked for ${url}`);
  },
};

const plan = JSON.parse(readFileSync(join(ROOT, 'flights', 'demo-kteb-khpn.json'), 'utf8'));
const profile = JSON.parse(readFileSync(join(ROOT, 'profiles', 'default.json'), 'utf8'));

async function loadedStore() {
  const store = new MemoryStore();
  await store.putAirports(readNasrDirectory(join(FIXTURES, 'fetch', 'nasr', '2026-09-03')));
  return store;
}

const ready: InstanceStatus = { airports: 26_000, airportData: 'ready', reason: null };

describe('an instance with no airport data', () => {
  it('fails its health check rather than reporting ok', async () => {
    const app = buildServer({
      store: new MemoryStore(),
      awc: new AwcClient(noNetwork),
      status: () => ({ airports: 0, airportData: 'loading', reason: null }),
    });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json().ok).toBe(false);
    expect(res.json().airportData).toBe('loading');
  });

  it('tells a caller it is still loading rather than that their aerodrome does not exist', async () => {
    const app = buildServer({
      store: new MemoryStore(),
      awc: new AwcClient(noNetwork),
      status: () => ({ airports: 0, airportData: 'loading', reason: null }),
    });
    const res = await app.inject({ method: 'POST', url: '/api/briefings', payload: { plan, profile, fetch: false } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/still loading its airport data/);
  });

  it('says why when the load failed, since the caller cannot see the log', async () => {
    const app = buildServer({
      store: new MemoryStore(),
      awc: new AwcClient(noNetwork),
      status: () => ({ airports: 0, airportData: 'missing', reason: 'could not download the airport snapshot: HTTP 503' }),
    });
    const res = await app.inject({ method: 'POST', url: '/api/briefings', payload: { plan, profile, fetch: false } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/HTTP 503/);
  });

  it('still says 422 for an aerodrome that genuinely is not there', async () => {
    const app = buildServer({ store: await loadedStore(), awc: new AwcClient(noNetwork), status: () => ready });
    const res = await app.inject({
      method: 'POST',
      url: '/api/briefings',
      payload: { plan: { ...plan, departure: 'KZZZ', airspace: { ...plan.airspace, KZZZ: 'G' } }, profile, fetch: false },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/KZZZ/);
  });

  it('reports ok once the data is there', async () => {
    const app = buildServer({ store: await loadedStore(), awc: new AwcClient(noNetwork), status: () => ready });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, airportData: 'ready', airports: 26_000 });
  });

  it('answers as before when nothing is telling it its status, which is a laptop', async () => {
    const app = buildServer({ store: await loadedStore(), awc: new AwcClient(noNetwork) });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, airportData: null });
  });
});

describe('the cap the weather services are owed', () => {
  /*
   * The per-caller limit is keyed on an address. Behind a proxy that
   * address is either the proxy — one bucket for the world — or a header
   * the caller wrote, which anybody can change. So there is a second cap
   * keyed on nothing, and it is the one that actually holds.
   */
  async function app(limit: number) {
    return buildServer({
      store: await loadedStore(),
      awc: new AwcClient(noNetwork),
      status: () => ready,
      // Off, so only the instance-wide cap is under test.
      rateLimit: null,
      instanceLimit: fixedWindow({ limit, windowMs: 60_000, maxKeys: 1 }),
      trustProxy: true,
    });
  }

  const brief = (server: ReturnType<typeof buildServer>, ip: string) =>
    server.inject({ method: 'POST', url: '/api/briefings', payload: { plan, profile, fetch: false }, headers: { 'x-forwarded-for': ip } });

  it('counts every caller together, however they identify themselves', async () => {
    const server = await app(2);
    expect((await brief(server, '203.0.113.1')).statusCode).toBe(201);
    expect((await brief(server, '203.0.113.2')).statusCode).toBe(201);

    const third = await brief(server, '203.0.113.3');
    expect(third.statusCode).toBe(429);
    expect(third.json().error).toMatch(/as many briefings as it will ask the weather services for/);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('cannot be walked past by claiming a new address each time', async () => {
    const server = await app(1);
    expect((await brief(server, '198.51.100.1')).statusCode).toBe(201);
    for (let i = 2; i < 6; i++) expect((await brief(server, `198.51.100.${i}`)).statusCode).toBe(429);
  });

  it('is off when a private instance says so', async () => {
    const server = buildServer({
      store: await loadedStore(),
      awc: new AwcClient(noNetwork),
      status: () => ready,
      rateLimit: null,
      instanceLimit: null,
    });
    for (let i = 0; i < 5; i++) expect((await brief(server, '192.0.2.1')).statusCode).toBe(201);
  });
});

describe('who the rate limiter thinks a visitor is', () => {
  async function app(trustProxy: boolean) {
    return buildServer({
      store: await loadedStore(),
      awc: new AwcClient(noNetwork),
      status: () => ready,
      rateLimit: fixedWindow({ limit: 1, windowMs: 60_000 }),
      instanceLimit: null,
      trustProxy,
    });
  }
  const brief = (server: ReturnType<typeof buildServer>, ip: string) =>
    server.inject({ method: 'POST', url: '/api/briefings', payload: { plan, profile, fetch: false }, headers: { 'x-forwarded-for': ip } });

  it('behind a trusted proxy, counts the two visitors as two', async () => {
    const server = await app(true);
    expect((await brief(server, '203.0.113.7')).statusCode).toBe(201);
    expect((await brief(server, '203.0.113.8')).statusCode).toBe(201);
    expect((await brief(server, '203.0.113.7')).statusCode).toBe(429);
  });

  it('without one, believes nothing the caller says about itself', async () => {
    const server = await app(false);
    expect((await brief(server, '203.0.113.7')).statusCode).toBe(201);
    // Same socket, different claim: still the same visitor.
    expect((await brief(server, '203.0.113.8')).statusCode).toBe(429);
  });
});

describe('a page on another origin', () => {
  async function app(allowedOrigins: string[]) {
    return buildServer({ store: await loadedStore(), awc: new AwcClient(noNetwork), status: () => ready, allowedOrigins });
  }

  it('answers a named origin', async () => {
    const server = await app(['https://holdshort.example']);
    const res = await server.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://holdshort.example' } });
    expect(res.headers['access-control-allow-origin']).toBe('https://holdshort.example');
    expect(res.headers['vary']).toContain('Origin');
  });

  it('does not answer one it was not given', async () => {
    const server = await app(['https://holdshort.example']);
    const res = await server.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://not-holdshort.example' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    // Still varies, so a cache cannot hand this answer to the allowed origin.
    expect(res.headers['vary']).toContain('Origin');
  });

  it('answers the preflight a briefing needs', async () => {
    const server = await app(['https://holdshort.example']);
    const res = await server.inject({
      method: 'OPTIONS',
      url: '/api/briefings',
      headers: { origin: 'https://holdshort.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://holdshort.example');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain('content-type');
  });

  it('allows nothing when no origin was named, which is a private instance', async () => {
    const server = await app([]);
    const res = await server.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://holdshort.example' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never allows credentials, because there is nothing to authenticate', async () => {
    const server = await app(['https://holdshort.example']);
    const res = await server.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://holdshort.example' } });
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
});
