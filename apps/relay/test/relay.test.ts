/**
 * The relay, driven directly: a Map for storage, a table of canned
 * upstream answers, and a clock the test moves. No network.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  AwcCacheClient,
  AwcClient,
  CANADIAN_UPPERWIND_SITES,
  NavCanadaClient,
  SOUNDING_STATIONS,
  SoundingClient,
  soundingLocation,
  type HttpClient,
} from '@depbrief/core/judge';
import { describe, expect, it, vi } from 'vitest';
import { MemoryKv } from '../src/memoryKv.js';
import {
  ALASKA_SOUNDINGS,
  AWC_API,
  CFPS,
  NOAA_RAW_US,
  NOTAM_FETCHES_PER_MINUTE,
  NWS_API,
  PRODUCTS,
  Relay,
  SOUNDING_FILES,
  UPPERWIND_SITES,
  type RelayResponse,
} from '../src/relay.js';

const FIXTURES = join(__dirname, '..', '..', '..', 'packages', 'core', 'test', 'fixtures', 'fetch');
const metarCsv = readFileSync(join(FIXTURES, 'awc-cache-2026-10-20', 'metars.cache.csv'), 'utf8');
const tafXml = readFileSync(join(FIXTURES, 'awc-cache-2026-10-20', 'tafs.cache.xml'), 'utf8');
/** Toronto's and Val-d'Or's upper winds, and CFPS refusing a request over a site it does not know: both as recorded on 5 November 2026. */
const upperwinds = readFileSync(join(FIXTURES, 'navcanada', 'upperwind', '2026-11-05', 'CYYZ-CYVO.json'), 'utf8');
const refusedCyei = readFileSync(join(FIXTURES, 'navcanada', 'upperwind', '2026-11-05', 'refused-CYEI.json'), 'utf8');
/** The combined SIGMET answer, the G-AIRMET cache file and every balloon's file, as recorded on 9 November 2026. */
const sigmets = readFileSync(join(FIXTURES, 'northeast-2026-11-09', 'sigmet.json'), 'utf8');
const gairmetXml = readFileSync(join(FIXTURES, 'northeast-2026-11-09', 'gairmets.cache.xml'), 'utf8');
const aircraftReportXml = readFileSync(join(FIXTURES, 'pireps-2026-11-09', 'aircraftreports.cache.xml'), 'utf8');
const SOUNDINGS = join(FIXTURES, 'noaa', 'soundings-2026-11-09');
const soundingFile = (name: string) => readFileSync(join(SOUNDINGS, `${name}.txt`), 'latin1');
const modified = JSON.parse(readFileSync(join(SOUNDINGS, 'last-modified.json'), 'utf8')) as Record<string, string>;
/** Alaska's balloons, as the NWS product API answered for each on the same morning. */
const alaskaProduct = (location: string) => readFileSync(join(FIXTURES, 'noaa', 'alaska-2026-11-09', `${location}.json`), 'utf8');
const alaskaUrl = (location: string) => `${NWS_API}/products/types/MAN/locations/${location}/latest`;
const ALL_SOUNDINGS = SOUNDING_FILES.length + ALASKA_SOUNDINGS.length;
const isSignificant = (url: string) => url.includes('/products/types/SGL/');
const isBalloon = (url: string) => (url.startsWith(NOAA_RAW_US) || url.startsWith(NWS_API)) && !isSignificant(url);
/** The 12Z flight from the same day: Albany's mandatory file and its significant levels as the NWS API answered. */
const SIGNIFICANT = join(FIXTURES, 'noaa', 'significant-2026-11-09');
const ALBANY = 'usus41.kaly.man.aly';
const albany12z = readFileSync(join(SIGNIFICANT, `${ALBANY}.txt`), 'latin1');
const albanySignificant = readFileSync(join(SIGNIFICANT, 'ALY.sgl.json'), 'utf8');
const albanySignificantUrl = `${NWS_API}/products/types/SGL/locations/ALY/latest`;

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
    [PRODUCTS.sigmet.upstream]: () => new Response(sigmets),
    [PRODUCTS.gairmet.upstream]: () => new Response(gzipSync(gairmetXml), { headers: { 'Content-Type': 'application/octet-stream' } }),
    [PRODUCTS.aircraftreports.upstream]: () => new Response(gzipSync(aircraftReportXml), { headers: { 'Content-Type': 'application/octet-stream' } }),
    [PRODUCTS.upperwind.upstream]: () => new Response(upperwinds),
    ...Object.fromEntries(SOUNDING_FILES.map((f) => [`${NOAA_RAW_US}/${f}.txt`, () => new Response(soundingFile(f), { headers: { 'Last-Modified': new Date(modified[`${f}.txt`]!).toUTCString() } })])),
    ...Object.fromEntries(ALASKA_SOUNDINGS.map((l) => [alaskaUrl(l), () => new Response(alaskaProduct(l), { headers: { 'Content-Type': 'application/ld+json' } })])),
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
    expect(outcomes.map((o) => `${o.key}:${o.state}`)).toEqual([
      'metars:refreshed',
      'tafs:refreshed',
      'sigmet:refreshed',
      'gairmet:refreshed',
      'aircraftreports:refreshed',
      'upperwind:refreshed',
      'soundings:refreshed',
    ]);
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
    expect(fourth.filter((o) => o.state === 'refreshed').map((o) => o.key)).toEqual(['metars', 'tafs', 'sigmet']);
  });

  it('stays inside the free plan: a day of five-minute ticks is well under a thousand writes', async () => {
    const r = relayWith();
    for (let tick = 0; tick < 288; tick++) {
      await r.relay.refresh();
      // A cron tick is not exactly on the minute.
      r.advance(5 * MIN + (tick % 2 === 0 ? 4_000 : -4_000));
    }
    // 288 for the METARs, 96 each for the TAFs and the SIGMETs, 24 each for the G-AIRMETs and the Canadian upper winds, 72 each for the balloons and the pilot reports.
    expect(r.kv.writes).toBeLessThanOrEqual(690);
    expect(r.kv.writes).toBeGreaterThanOrEqual(660);
  });

  it('stores every product inside what KV allows, the upper winds of all ninety-seven sites included', async () => {
    // Over the limit by itself, which is what stopped the upper winds refreshing the day this went live.
    expect(PRODUCTS.upperwind.upstream.length).toBeGreaterThan(1024);
    const { relay, kv } = relayWith();
    const outcomes = await relay.refresh();
    expect(outcomes.every((o) => o.state === 'refreshed')).toBe(true);
    for (const key of Object.keys(PRODUCTS)) {
      const { metadata } = await kv.getWithMetadata(key);
      expect(new TextEncoder().encode(JSON.stringify(metadata)).length).toBeLessThanOrEqual(1024);
    }
    expect((await kv.getWithMetadata('upperwind')).metadata?.upstream).toBe(CFPS);
  });

  it('goes on to the next product when one cannot be stored, and says which', async () => {
    const r = relayWith();
    const put = r.kv.put.bind(r.kv);
    r.kv.put = async (key, value, options) => {
      if (key === 'tafs') throw new Error('KV PUT failed: 500 Internal Server Error');
      return put(key, value, options);
    };
    const outcomes = await r.relay.refresh();
    expect(outcomes.map((o) => `${o.key}:${o.state}`)).toEqual(['metars:refreshed', 'tafs:failed', 'sigmet:refreshed', 'gairmet:refreshed', 'aircraftreports:refreshed', 'upperwind:refreshed', 'soundings:refreshed']);
    expect(outcomes[1]).toMatchObject({ error: 'could not store tafs: KV PUT failed: 500 Internal Server Error' });
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
      [PRODUCTS.sigmet.upstream]: () => new Response('<html>down for maintenance</html>'),
    });
    const r = relayWith(up);
    const outcomes = await r.relay.refresh();
    expect(outcomes.find((o) => o.key === 'metars')).toMatchObject({ state: 'failed', error: expect.stringContaining('gzip') });
    expect(outcomes.find((o) => o.key === 'sigmet')).toMatchObject({ state: 'failed', error: expect.stringContaining('JSON') });
    expect((await r.kv.getWithMetadata('metars')).value).toBeNull();
  });

  it('never replaces the country\'s upper winds with a refusal that arrived as a 200', async () => {
    let refusing = false;
    const r = relayWith(upstream({ [PRODUCTS.upperwind.upstream]: () => new Response(refusing ? refusedCyei : upperwinds) }));
    await r.relay.refresh();
    refusing = true;
    r.advance(60 * MIN);
    const outcomes = await r.relay.refresh();
    expect(outcomes.find((o) => o.key === 'upperwind')).toMatchObject({ state: 'failed', error: expect.stringContaining('alpha.geomInvalid (CYEI)') });
    const served = await r.get('/cfps/?alpha=upperwind');
    expect(text(served)).toBe(upperwinds);
    expect(served.headers['X-Fetched-At']).toBe('2026-10-20T05:00:00.000Z');
  });

  it('asks again without a site NAV CANADA stops recognising, and says so on the status page', async () => {
    // The recorded refusal, naming one of the relay's own sites rather than CYEI.
    const gone = UPPERWIND_SITES[0];
    const refusal = refusedCyei.replace('CYEI', gone);
    const without = `${CFPS}?${UPPERWIND_SITES.filter((s) => s !== gone).map((s) => `site=${s}`).join('&')}&alpha=upperwind`;
    const r = relayWith(upstream({ [PRODUCTS.upperwind.upstream]: () => new Response(refusal), [without]: () => new Response(upperwinds) }));
    const outcomes = await r.relay.refresh();
    expect(outcomes.find((o) => o.key === 'upperwind')).toMatchObject({ state: 'refreshed' });
    expect(r.up.calls.filter((u) => u.includes('alpha=upperwind'))).toEqual([PRODUCTS.upperwind.upstream, without]);
    expect(text(await r.get('/cfps/?alpha=upperwind'))).toBe(upperwinds);
    const status = JSON.parse(text(await r.get('/status'))) as { products: { product: string; note?: string }[] };
    expect(status.products.find((p) => p.product === 'upperwind')?.note).toBe(`NAV CANADA does not recognise ${gone}; asked without it`);
  });

  it('stores "nothing in force" as an empty list, because that is what a 204 means here', async () => {
    const r = relayWith(upstream({ [PRODUCTS.sigmet.upstream]: () => new Response(null, { status: 204 }) }));
    await r.relay.refresh();
    expect(text(await r.get('/awc/sigmet?format=json'))).toBe('[]');
  });

  it('no longer asks NOAA for the US winds aloft bulletins it discontinued', async () => {
    const r = relayWith();
    await r.relay.refresh();
    // The table has no answer for them, so a request would have thrown; there is none to throw.
    expect(r.up.calls.some((u) => u.includes('/windtemp'))).toBe(false);
    expect((await r.get('/awc/windtemp?region=us&level=low&fcst=06')).status).toBe(404);
  });
});

describe('the balloons, which are many small files', () => {
  it('asks the free plan for no more than it allows in one run', async () => {
    const r = relayWith();
    await r.relay.refresh();
    // Everything due at once, on the first tick: the limit is fifty, and CFPS can take two.
    expect(r.up.calls.length).toBeLessThanOrEqual(46);
    expect(r.up.calls.filter(isBalloon)).toHaveLength(27);
    expect(r.up.calls.filter(isSignificant)).toHaveLength(12);
  });

  it('has every balloon in core in its list, and asks each one within three runs', async () => {
    expect([...SOUNDING_FILES].sort()).toEqual(SOUNDING_STATIONS.flatMap((s) => s.file ?? []).sort());
    expect([...ALASKA_SOUNDINGS].sort()).toEqual(SOUNDING_STATIONS.flatMap((s) => s.nwsLocation ?? []).sort());
    const r = relayWith();
    for (let run = 0; run < 3; run++) {
      await r.relay.refresh();
      r.advance(20 * MIN);
    }
    expect(new Set(r.up.calls.filter(isBalloon)).size).toBe(ALL_SOUNDINGS);
  });

  it('gives the page every balloon the client can read, dated by NOAA', async () => {
    const r = relayWith();
    for (let run = 0; run < 3; run++) {
      await r.relay.refresh();
      r.advance(20 * MIN);
    }
    const http: HttpClient = { get: async (url) => ({ status: 200, body: text(await r.get(url.replace('https://relay.example', ''))), headers: {} }) };
    const { reports } = await new SoundingClient(http, 'https://relay.example/noaa/soundings').relayed();
    expect(reports).toHaveLength(ALL_SOUNDINGS);
    const albany = reports.find((x) => x.station === '72518')!;
    expect(albany.issuedAt).toEqual(new Date('2026-11-09T00:00:00Z'));
    expect(albany.body).toBe(soundingFile('usus41.kaly.man.aly').trim());
    const anchorage = reports.find((x) => x.station === '70273')!;
    expect(anchorage.issuedAt).toEqual(new Date('2026-11-09T00:00:00Z'));
    expect(anchorage.body).toBe((JSON.parse(alaskaProduct('ANC')) as { productText: string }).productText.trim());
  });

  it('keeps a balloon\'s last sounding when its file does not answer, and says which', async () => {
    let answering = true;
    const missing = SOUNDING_FILES[0];
    const r = relayWith(upstream({ [`${NOAA_RAW_US}/${missing}.txt`]: () => (answering ? new Response(soundingFile(missing)) : new Response('gone', { status: 404 })) }));
    await r.relay.refresh();
    answering = false;
    for (let run = 0; run < 2; run++) {
      r.advance(20 * MIN);
      await r.relay.refresh();
    }
    r.advance(20 * MIN);
    // The fourth run, which comes back round to the first file.
    const outcomes = await r.relay.refresh();
    expect(outcomes.find((o) => o.key === 'soundings')).toMatchObject({ state: 'refreshed' });
    const held = JSON.parse(text(await r.get('/noaa/soundings'))) as Record<string, { text: string }>;
    expect(held[missing]!.text).toBe(soundingFile(missing));
    const status = JSON.parse(text(await r.get('/status'))) as { products: { product: string; note?: string }[] };
    expect(status.products.find((p) => p.product === 'soundings')?.note).toContain(missing);
  });

  it('never keeps an error page as a sounding', async () => {
    const file = SOUNDING_FILES[0];
    const r = relayWith(upstream({ [`${NOAA_RAW_US}/${file}.txt`]: () => new Response('<html>maintenance</html>') }));
    await r.relay.refresh();
    expect((JSON.parse(text(await r.get('/noaa/soundings'))) as Record<string, { text: string }>)[file]!.text).toBe('');
  });

  it('counts it a failure only when nothing answered, and then writes nothing', async () => {
    const none = Object.fromEntries(SOUNDING_FILES.map((f) => [`${NOAA_RAW_US}/${f}.txt`, () => new Response('down', { status: 503 })]));
    const r = relayWith(upstream(none));
    const outcomes = await r.relay.refresh();
    expect(outcomes.find((o) => o.key === 'soundings')).toMatchObject({ state: 'failed', error: expect.stringContaining('none of the 27') });
    expect((await r.kv.getWithMetadata('soundings')).value).toBeNull();
  });

  it('keeps a file NOAA has removed from holding up the rest', async () => {
    const gone = SOUNDING_FILES[0];
    const r = relayWith(upstream({ [`${NOAA_RAW_US}/${gone}.txt`]: () => new Response('gone', { status: 404 }) }));
    await r.relay.refresh();
    r.advance(20 * MIN);
    await r.relay.refresh();
    // Having been asked once, it waits its turn behind the ones not asked yet.
    expect(r.up.calls.filter((u) => u.includes(gone))).toHaveLength(1);
    r.advance(20 * MIN);
    await r.relay.refresh();
    expect(new Set(r.up.calls.filter(isBalloon)).size).toBe(ALL_SOUNDINGS);
  });

  it('asks the NWS API for Alaska, and keeps nothing from an answer with no bulletin in it', async () => {
    const r = relayWith(upstream({ [alaskaUrl('ANC')]: () => new Response('{"title":"Not Found"}') }));
    for (let run = 0; run < 3; run++) {
      await r.relay.refresh();
      r.advance(20 * MIN);
    }
    const held = JSON.parse(text(await r.get('/noaa/soundings'))) as Record<string, { text: string; modified: string | null }>;
    expect(held['ANC']!.text).toBe('');
    expect(held['FAI']!.text).toContain('70261 TTAA');
    expect(held['FAI']!.modified).toBe('2026-11-09T00:02:00.000Z');
  });

  describe('significant levels', () => {
    const flying12z = () => upstream({ [`${NOAA_RAW_US}/${ALBANY}.txt`]: () => new Response(albany12z, { headers: { 'Last-Modified': 'Mon, 09 Nov 2026 12:36:59 GMT' } }), [albanySignificantUrl]: () => new Response(albanySignificant) });
    const heldCopy = async (r: ReturnType<typeof relayWith>) => JSON.parse(text(await r.get('/noaa/soundings'))) as Record<string, { text: string; significant?: { askedAt: string; text: string } }>;

    it('holds them beside the sounding of the same flight, and the page gets both in one report', async () => {
      const r = relayWith(flying12z());
      await r.relay.refresh();
      expect((await heldCopy(r))[ALBANY]!.significant!.text).toContain('PPBB');
      const http: HttpClient = { get: async (url) => ({ status: 200, body: text(await r.get(url.replace('https://relay.example', ''))), headers: {} }) };
      const { reports } = await new SoundingClient(http, 'https://relay.example/noaa/soundings').relayed();
      const albany = reports.find((x) => x.station === '72518')!;
      expect(albany.body.startsWith(albany12z.trim())).toBe(true);
      expect(albany.body).toContain('TTBB');
    });

    it('stops asking once it has them, and asks again when the next flight arrives', async () => {
      let flight = albany12z;
      const up = upstream({ [`${NOAA_RAW_US}/${ALBANY}.txt`]: () => new Response(flight), [albanySignificantUrl]: () => new Response(albanySignificant) });
      const r = relayWith(up);
      const asked = () => up.calls.filter((u) => u === albanySignificantUrl).length;
      // Long enough for every balloon to have been asked, so Albany is not waiting behind any that have not.
      for (let run = 0; run < 7; run++) {
        await r.relay.refresh();
        r.advance(20 * MIN);
      }
      expect(asked()).toBe(1);
      flight = soundingFile(ALBANY);
      for (let run = 0; run < 3; run++) {
        await r.relay.refresh();
        r.advance(20 * MIN);
      }
      expect(asked()).toBe(2);
    });

    it('writes the copy once a run, however many it asked for', async () => {
      const r = relayWith(flying12z());
      const put = vi.spyOn(r.kv, 'put');
      await r.relay.refresh();
      expect(put.mock.calls.filter(([key]) => key === 'soundings')).toHaveLength(1);
    });

    it('never asks for more than its share, and sends the ones that do not appear to the back', async () => {
      const r = relayWith();
      await r.relay.refresh();
      expect(r.up.calls.filter(isSignificant)).toHaveLength(12);
      r.advance(20 * MIN);
      await r.relay.refresh();
      const calls = r.up.calls.filter(isSignificant);
      expect(calls).toHaveLength(24);
      // The first dozen did not answer, and the next dozen are ones not yet asked.
      expect(new Set(calls).size).toBe(24);
    });

    it('keeps what it had when the answer is not a bulletin', async () => {
      let answer = albanySignificant;
      let flight = albany12z;
      const up = upstream({ [`${NOAA_RAW_US}/${ALBANY}.txt`]: () => new Response(flight), [albanySignificantUrl]: () => new Response(answer) });
      const r = relayWith(up);
      for (let run = 0; run < 7; run++) {
        await r.relay.refresh();
        r.advance(20 * MIN);
      }
      const before = (await heldCopy(r))[ALBANY]!.significant!;
      answer = '{"title":"Not Found"}';
      flight = soundingFile(ALBANY);
      for (let run = 0; run < 3; run++) {
        await r.relay.refresh();
        r.advance(20 * MIN);
      }
      const after = (await heldCopy(r))[ALBANY]!.significant!;
      // It was asked, and got nothing it could keep.
      expect(after.askedAt > before.askedAt).toBe(true);
      expect(after.text).toBe(before.text);
    });

    it('asks the API for each balloon in core, by the three letters ending its file', async () => {
      const r = relayWith();
      for (let run = 0; run < 14; run++) {
        await r.relay.refresh();
        r.advance(20 * MIN);
      }
      const wanted = SOUNDING_STATIONS.map((s) => `${NWS_API}/products/types/SGL/locations/${soundingLocation(s)}/latest`).sort();
      expect([...new Set(r.up.calls.filter(isSignificant))].sort()).toEqual(wanted);
    });
  });

  it('sorts them without localeCompare, which costs a free plan run its whole allowance the first time', async () => {
    const compare = vi.spyOn(String.prototype, 'localeCompare');
    const r = relayWith();
    await r.relay.refresh();
    r.advance(20 * MIN);
    await r.relay.refresh();
    expect(compare).not.toHaveBeenCalled();
    compare.mockRestore();
  });

  it('serves the pilot reports compressed and labelled, for a browser to undo', async () => {
    const r = relayWith();
    await r.relay.refresh();
    const res = await r.get('/awc/cache/aircraftreports.cache.xml.gz');
    expect(res.headers['Content-Encoding']).toBe('gzip');
    expect(gunzipSync(Buffer.from(res.body as ArrayBuffer)).toString('utf8')).toBe(aircraftReportXml);
  });

  it('serves the G-AIRMET file compressed and labelled, for a browser to undo', async () => {
    const r = relayWith();
    await r.relay.refresh();
    const res = await r.get('/awc/cache/gairmets.cache.xml.gz');
    expect(res.headers['Content-Encoding']).toBe('gzip');
    expect(gunzipSync(Buffer.from(res.body as ArrayBuffer)).toString('utf8')).toBe(gairmetXml);
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
    expect((await r.get('/awc/sigmet?format=json')).headers['Access-Control-Allow-Origin']).toBe(PAGE);
    expect((await r.get('/awc/sigmet?format=json', 'https://elsewhere.example')).headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect((await r.get('/awc/sigmet?format=json')).headers['Vary']).toBe('Origin');
  });

  it('will not be configured to let everybody in', async () => {
    const r = relayWith(upstream(), '*');
    await r.relay.refresh();
    expect((await r.get('/awc/sigmet?format=json', 'https://anyone.example')).headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('answers upper winds for whichever sites were asked, with all of them', async () => {
    const r = relayWith();
    await r.relay.refresh();
    const res = await r.get('/cfps/?site=CYYZ&site=CYOW&alpha=upperwind');
    expect(res.status).toBe(200);
    expect(text(res)).toBe(upperwinds);
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
    expect((await r.relay.handle({ method: 'POST', url: 'https://relay.example/awc/sigmet', origin: PAGE })).status).toBe(405);
    const pre = await r.relay.handle({ method: 'OPTIONS', url: 'https://relay.example/awc/sigmet', origin: PAGE });
    expect(pre.status).toBe(204);
    expect(pre.headers['Access-Control-Allow-Origin']).toBe(PAGE);
  });

  it('reports its own health: 503 until everything is held, 200 after, 503 again if the timer stops', async () => {
    const r = relayWith();
    expect((await r.get('/status')).status).toBe(503);
    await r.relay.refresh();
    const ok = await r.get('/status');
    expect(ok.status).toBe(200);
    expect(JSON.parse(text(ok)).products.map((p: { product: string }) => p.product)).toEqual(['metars', 'tafs', 'sigmet', 'gairmet', 'aircraftreports', 'upperwind', 'soundings']);
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
    expect(sigmets.reports).toHaveLength(16);
    // The canned NOTAM record is deliberately incomplete; what matters is that the request arrived at the right place.
    expect(r.up.calls).toContain(`${CFPS}?site=CYSN&alpha=notam`);
    expect(notams).toBeDefined();
  });

  it('agree with core about which sites publish upper winds', () => {
    expect([...UPPERWIND_SITES]).toEqual([...CANADIAN_UPPERWIND_SITES]);
  });
});
