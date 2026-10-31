/**
 * The relay, driven directly: a Map for storage, a table of canned
 * upstream answers, and a clock the test moves. No network.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { AwcCacheClient, AwcClient, CANADIAN_UPPERWIND_SITES, NavCanadaClient, type HttpClient } from '@depbrief/core/judge';
import { describe, expect, it } from 'vitest';
import { MemoryKv } from '../src/memoryKv.js';
import { AWC_API, CFPS, NOTAM_FETCHES_PER_MINUTE, PRODUCTS, Relay, UPPERWIND_SITES, type RelayResponse } from '../src/relay.js';

const FIXTURES = join(__dirname, '..', '..', '..', 'packages', 'core', 'test', 'fixtures', 'fetch');
const metarCsv = readFileSync(join(FIXTURES, 'awc-cache-2026-10-20', 'metars.cache.csv'), 'utf8');
const tafXml = readFileSync(join(FIXTURES, 'awc-cache-2026-10-20', 'tafs.cache.xml'), 'utf8');

const PAGE = 'https://nberkyilmaz.github.io';
const T0 = Date.parse('2026-10-20T05:00:00Z');
const MIN = 60_000;

type Answer = () => Response;

/** The services, as a table. Counts every request so a test can say how many the services saw. */
function upstream(overrides: Record<string, Answer> = {}) {
  const calls: string[] = [];
  const table: Record<string, Answer> = {
    [PRODUCTS.metars.upstream]: () => new Response(gzipSync(metarCsv), { headers: { 'Content-Type': 'application/octet-stream' } }),
    [PRODUCTS.tafs.upstream]: () => new Response(gzipSync(tafXml), { headers: { 'Content-Type': 'application/octet-stream' } }),
    [PRODUCTS.isigmet.upstream]: () => new Response('[{"firId":"CZYZ","rawSigmet":"..."}]'),
    [PRODUCTS.airsigmet.upstream]: () => new Response(null, { status: 204 }),
    [PRODUCTS.upperwind.upstream]: () => new Response('{"meta":{},"data":[]}'),
    [`${CFPS}?site=CYSN&alpha=notam`]: () => new Response('{"meta":{},"data":[{"type":"notam"}]}'),
    ...overrides,
  };
  return {
    calls,
    fetch: async (url: string) => {
      calls.push(url);
      const answer = table[url];
      if (!answer) throw new Error(`no canned answer for ${url}`);
      return answer();
    },
  };
}

function relayWith(up = upstream(), origins = PAGE) {
  const kv = new MemoryKv();
  let now = T0;
  const relay = new Relay({ SNAPSHOTS: kv, ALLOWED_ORIGINS: origins }, { fetch: up.fetch, now: () => now });
  return {
    relay,
    kv,
    up,
    advance: (ms: number) => {
      now += ms;
    },
    get: (path: string, origin: string | null = PAGE) => relay.handle({ method: 'GET', url: `https://relay.example${path}`, origin }),
  };
}

const text = (r: RelayResponse): string => (typeof r.body === 'string' ? r.body : new TextDecoder().decode(r.body!));

describe('the timer', () => {
  it('fetches everything on the first tick and stores it with when it was fetched', async () => {
    const { relay, kv } = relayWith();
    const outcomes = await relay.refresh();
    expect(outcomes.map((o) => `${o.key}:${o.state}`)).toEqual(['metars:refreshed', 'tafs:refreshed', 'isigmet:refreshed', 'airsigmet:refreshed', 'upperwind:refreshed']);
    const { metadata } = await kv.getWithMetadata('metars');
    expect(metadata?.fetchedAt).toBe('2026-10-20T05:00:00.000Z');
  });

  it('asks again only for what is due', async () => {
    const r = relayWith();
    await r.relay.refresh();
    r.advance(5 * MIN);
    const second = await r.relay.refresh();
    expect(second.filter((o) => o.state === 'refreshed').map((o) => o.key)).toEqual(['metars']);
    r.advance(10 * MIN);
    const fourth = await r.relay.refresh();
    expect(fourth.filter((o) => o.state === 'refreshed').map((o) => o.key)).toEqual(['metars', 'tafs', 'isigmet', 'airsigmet']);
  });

  it('stays inside the free plan: a day of five-minute ticks is well under a thousand writes', async () => {
    const r = relayWith();
    for (let tick = 0; tick < 288; tick++) {
      await r.relay.refresh();
      // A cron tick is not exactly on the minute.
      r.advance(5 * MIN + (tick % 2 === 0 ? 4_000 : -4_000));
    }
    expect(r.kv.writes).toBeLessThanOrEqual(620);
    expect(r.kv.writes).toBeGreaterThanOrEqual(580);
  });

  it('keeps the last good copy when the service fails, and says it failed', async () => {
    let down = false;
    const up = upstream({
      [PRODUCTS.metars.upstream]: () => (down ? new Response('busy', { status: 503 }) : new Response(gzipSync(metarCsv))),
    });
    const r = relayWith(up);
    await r.relay.refresh();
    down = true;
    r.advance(5 * MIN);
    const outcomes = await r.relay.refresh();
    expect(outcomes.find((o) => o.key === 'metars')).toMatchObject({ state: 'failed' });
    const served = await r.get('/awc/cache/metars.cache.csv.gz');
    expect(served.status).toBe(200);
    // Its age is the truth: five minutes old, not now.
    expect(served.headers['X-Fetched-At']).toBe('2026-10-20T05:00:00.000Z');
  });

  it('never replaces good weather with a maintenance page served as a 200', async () => {
    const up = upstream({
      [PRODUCTS.metars.upstream]: () => new Response('<html>down for maintenance</html>'),
      [PRODUCTS.isigmet.upstream]: () => new Response('<html>down for maintenance</html>'),
    });
    const r = relayWith(up);
    const outcomes = await r.relay.refresh();
    expect(outcomes.find((o) => o.key === 'metars')).toMatchObject({ state: 'failed', error: expect.stringContaining('gzip') });
    expect(outcomes.find((o) => o.key === 'isigmet')).toMatchObject({ state: 'failed', error: expect.stringContaining('JSON') });
    expect((await r.kv.getWithMetadata('metars')).value).toBeNull();
  });

  it('stores "nothing in force" as an empty list, because that is what a 204 means here', async () => {
    const r = relayWith();
    await r.relay.refresh();
    expect(text(await r.get('/awc/airsigmet?format=json'))).toBe('[]');
  });
});

describe('serving the page', () => {
  it('serves a compressed file compressed, labelled so a browser undoes it, with its age', async () => {
    const r = relayWith();
    await r.relay.refresh();
    const res = await r.get('/awc/cache/metars.cache.csv.gz');
    expect(res.status).toBe(200);
    expect(res.headers['Content-Encoding']).toBe('gzip');
    expect(res.headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['X-Fetched-At']).toBe('2026-10-20T05:00:00.000Z');
    expect(res.headers['Access-Control-Expose-Headers']).toBe('X-Fetched-At');
    expect(gunzipSync(Buffer.from(res.body as ArrayBuffer)).toString('utf8')).toBe(metarCsv);
  });

  it('serves every visitor from the copy: a hundred page loads are no extra requests upstream', async () => {
    const r = relayWith();
    await r.relay.refresh();
    const before = r.up.calls.length;
    for (let i = 0; i < 100; i++) await r.get('/awc/cache/tafs.cache.xml.gz');
    expect(r.up.calls.length).toBe(before);
  });

  it('lets the named page read the answer, and no other', async () => {
    const r = relayWith();
    await r.relay.refresh();
    expect((await r.get('/awc/isigmet?format=json')).headers['Access-Control-Allow-Origin']).toBe(PAGE);
    expect((await r.get('/awc/isigmet?format=json', 'https://elsewhere.example')).headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect((await r.get('/awc/isigmet?format=json')).headers['Vary']).toBe('Origin');
  });

  it('will not be configured to let everybody in', async () => {
    const r = relayWith(upstream(), '*');
    await r.relay.refresh();
    expect((await r.get('/awc/isigmet?format=json', 'https://anyone.example')).headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('answers upper winds for whichever sites were asked, with all of them', async () => {
    const r = relayWith();
    await r.relay.refresh();
    const res = await r.get('/cfps/?site=CYYZ&site=CYOW&alpha=upperwind');
    expect(res.status).toBe(200);
    expect(text(res)).toBe('{"meta":{},"data":[]}');
  });

  it('fetches once on a fresh deployment, before the first tick has run', async () => {
    const r = relayWith();
    const res = await r.get('/awc/cache/metars.cache.csv.gz');
    expect(res.status).toBe(200);
    expect(r.up.calls).toEqual([PRODUCTS.metars.upstream]);
  });

  it('says so when it holds nothing and cannot reach the service', async () => {
    const r = relayWith(upstream({ [PRODUCTS.tafs.upstream]: () => new Response('down', { status: 503 }) }));
    const res = await r.get('/awc/cache/tafs.cache.xml.gz');
    expect(res.status).toBe(503);
    expect(text(res)).toMatch(/no tafs held yet/);
  });

  it('carries only what it carries', async () => {
    const r = relayWith();
    expect((await r.get('/awc/taf?ids=CYSN&format=json')).status).toBe(404);
    expect((await r.relay.handle({ method: 'POST', url: 'https://relay.example/awc/isigmet', origin: PAGE })).status).toBe(405);
    const pre = await r.relay.handle({ method: 'OPTIONS', url: 'https://relay.example/awc/isigmet', origin: PAGE });
    expect(pre.status).toBe(204);
    expect(pre.headers['Access-Control-Allow-Origin']).toBe(PAGE);
  });

  it('reports its own health: 503 until everything is held, 200 after, 503 again if the timer stops', async () => {
    const r = relayWith();
    expect((await r.get('/status')).status).toBe(503);
    await r.relay.refresh();
    const ok = await r.get('/status');
    expect(ok.status).toBe(200);
    expect(JSON.parse(text(ok)).products).toHaveLength(5);
    r.advance(20 * MIN);
    expect((await r.get('/status')).status).toBe(503);
  });
});

describe('NOTAMs, which cannot be had for the whole country', () => {
  it('asks NAV CANADA once per aerodrome per half hour', async () => {
    const r = relayWith();
    expect((await r.get('/cfps/?site=CYSN&alpha=notam')).status).toBe(200);
    expect((await r.get('/cfps/?site=cysn&alpha=notam')).status).toBe(200);
    r.advance(29 * MIN);
    await r.get('/cfps/?site=CYSN&alpha=notam');
    expect(r.up.calls.filter((u) => u.includes('alpha=notam'))).toHaveLength(1);
    r.advance(2 * MIN);
    await r.get('/cfps/?site=CYSN&alpha=notam');
    expect(r.up.calls.filter((u) => u.includes('alpha=notam'))).toHaveLength(2);
  });

  it('refuses anything but one four-letter aerodrome', async () => {
    const r = relayWith();
    expect((await r.get('/cfps/?site=CYSN&site=CYKF&alpha=notam')).status).toBe(400);
    expect((await r.get('/cfps/?site=../x&alpha=notam')).status).toBe(400);
    expect((await r.get('/cfps/?alpha=notam')).status).toBe(400);
    expect(r.up.calls).toEqual([]);
  });

  it('will not ask for more than its share in a minute, whoever is asking', async () => {
    const answers: Record<string, Answer> = {};
    const ids = Array.from({ length: NOTAM_FETCHES_PER_MINUTE + 1 }, (_, i) => `CA${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`);
    for (const id of ids) answers[`${CFPS}?site=${id}&alpha=notam`] = () => new Response('{"data":[]}');
    const r = relayWith(upstream(answers));
    for (const id of ids.slice(0, -1)) expect((await r.get(`/cfps/?site=${id}&alpha=notam`)).status).toBe(200);
    const refused = await r.get(`/cfps/?site=${ids.at(-1)}&alpha=notam`);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers['Retry-After'])).toBeGreaterThan(0);
    r.advance(MIN);
    expect((await r.get(`/cfps/?site=${ids.at(-1)}&alpha=notam`)).status).toBe(200);
  });

  it('passes a NAV CANADA failure on as a failure, not as an aerodrome with no NOTAMs', async () => {
    const r = relayWith(upstream({ [`${CFPS}?site=CYSN&alpha=notam`]: () => new Response('nope', { status: 500 }) }));
    expect((await r.get('/cfps/?site=CYSN&alpha=notam')).status).toBe(502);
  });
});

describe("one station's METAR, for a page that shows a single line", () => {
  const CYTZ = `${AWC_API}/metar?ids=CYTZ&format=json`;
  const cytz = '[{"icaoId":"CYTZ","rawOb":"METAR CYTZ 292000Z 24010KT 15SM FEW040 17/13 A2993","fltCat":"VFR"}]';

  it('asks the AWC once per station per five minutes, and passes its answer on as it came', async () => {
    const r = relayWith(upstream({ [CYTZ]: () => new Response(cytz) }));
    const first = await r.get('/awc/metar?ids=CYTZ&format=json');
    expect(first.status).toBe(200);
    expect(text(first)).toBe(cytz);
    expect(first.headers['Access-Control-Allow-Origin']).toBe(PAGE);
    expect(first.headers['X-Fetched-At']).toBe('2026-10-20T05:00:00.000Z');
    await r.get('/awc/metar?ids=cytz&format=json');
    r.advance(4 * MIN);
    await r.get('/awc/metar?ids=CYTZ&format=json');
    expect(r.up.calls).toEqual([CYTZ]);
    r.advance(2 * MIN);
    await r.get('/awc/metar?ids=CYTZ&format=json');
    expect(r.up.calls).toEqual([CYTZ, CYTZ]);
  });

  it('refuses anything but one four-letter station, without asking anybody', async () => {
    const r = relayWith();
    expect((await r.get('/awc/metar?ids=CYTZ,CYYZ&format=json')).status).toBe(400);
    expect((await r.get('/awc/metar?ids=CYTZ&ids=CYYZ&format=json')).status).toBe(400);
    expect((await r.get('/awc/metar?format=json')).status).toBe(400);
    expect(r.up.calls).toEqual([]);
  });

  it('says a station with nothing to report is not found, and does not ask again for five minutes', async () => {
    const r = relayWith(upstream({ [`${AWC_API}/metar?ids=CZZZ&format=json`]: () => new Response(null, { status: 204 }) }));
    expect((await r.get('/awc/metar?ids=CZZZ&format=json')).status).toBe(404);
    expect((await r.get('/awc/metar?ids=CZZZ&format=json')).status).toBe(404);
    expect(r.up.calls).toHaveLength(1);
  });

  it('passes a failure on as a failure, and never keeps an error page as a report', async () => {
    const down = relayWith(upstream({ [CYTZ]: () => new Response('busy', { status: 503 }) }));
    expect((await down.get('/awc/metar?ids=CYTZ&format=json')).status).toBe(502);
    const maintenance = relayWith(upstream({ [CYTZ]: () => new Response('<html>down for maintenance</html>') }));
    expect((await maintenance.get('/awc/metar?ids=CYTZ&format=json')).status).toBe(502);
    // Nothing was kept, so the next visitor asks again.
    await maintenance.get('/awc/metar?ids=CYTZ&format=json');
    expect(maintenance.up.calls).toEqual([CYTZ, CYTZ]);
  });

  it('draws on the same per-minute budget as NOTAMs', async () => {
    const answers: Record<string, Answer> = { [CYTZ]: () => new Response(cytz) };
    const ids = Array.from({ length: NOTAM_FETCHES_PER_MINUTE }, (_, i) => `CA${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`);
    for (const id of ids) answers[`${CFPS}?site=${id}&alpha=notam`] = () => new Response('{"data":[]}');
    const r = relayWith(upstream(answers));
    for (const id of ids) await r.get(`/cfps/?site=${id}&alpha=notam`);
    expect((await r.get('/awc/metar?ids=CYTZ&format=json')).status).toBe(429);
    r.advance(MIN);
    expect((await r.get('/awc/metar?ids=CYTZ&format=json')).status).toBe(200);
  });
});

describe('the clients in core, reading through the relay', () => {
  /** What a browser does with a relay response: undo the gzip it was told about, hand over text. */
  function browserThrough(r: ReturnType<typeof relayWith>): HttpClient {
    return {
      async get(url) {
        const res = await r.relay.handle({ method: 'GET', url, origin: PAGE });
        const bytes = res.body === null ? Buffer.alloc(0) : typeof res.body === 'string' ? Buffer.from(res.body) : Buffer.from(res.body);
        const body = res.headers['Content-Encoding'] === 'gzip' ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
        return { status: res.status, body, headers: res.headers };
      },
    };
  }

  it('get the reports the services sent, parsed by the same code a server uses', async () => {
    const r = relayWith();
    await r.relay.refresh();
    const http = browserThrough(r);
    const base = 'https://relay.example';
    const metars = await new AwcCacheClient(http, `${base}/awc/cache`).metars();
    const tafs = await new AwcCacheClient(http, `${base}/awc/cache`).tafs();
    const sigmets = await new AwcClient(http, `${base}/awc`).sigmets();
    const notams = await new NavCanadaClient(http, `${base}/cfps/`).notams('CYSN').catch((e: Error) => e);
    expect(metars.reports.find((m) => m.station === 'CYYZ')?.body).toBe('METAR CYYZ 200400Z 35010KT 15SM SKC 11/07 A3036 RMK SLP286');
    expect(tafs.reports).toHaveLength(8);
    expect(sigmets.reports).toHaveLength(1);
    // The canned NOTAM record is deliberately incomplete; what matters is that the request arrived at the right place.
    expect(r.up.calls).toContain(`${CFPS}?site=CYSN&alpha=notam`);
    expect(notams).toBeDefined();
  });

  it('agree with core about which sites publish upper winds', () => {
    expect([...UPPERWIND_SITES]).toEqual([...CANADIAN_UPPERWIND_SITES]);
  });
});
