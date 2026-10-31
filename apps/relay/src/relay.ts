/**
 * The relay: what stands between the page and the weather services.
 *
 * Neither the AWC nor NAV CANADA sends the header that lets a page on
 * another site read its answers, so a page cannot fetch the weather itself.
 * Something has to fetch it on the page's behalf, and that something has to
 * be fair to the services: a thousand visitors must not become a thousand
 * requests to somebody else's endpoint.
 *
 * So the relay fetches on a timer, not on demand. Every few minutes it
 * takes the products that cover the whole country — every METAR, every TAF,
 * the hazard advisories, the upper winds — and keeps the latest copy. A
 * visitor reads that copy. However many visitors there are, the services
 * see one request per product per window, which is the same promise the
 * server's freshness windows make.
 *
 * It holds no logic about weather. It does not parse, decode or judge; it
 * moves bytes and says when it fetched them. That is deliberate: the
 * browser parses what arrives with the same clients the server uses, so the
 * relay cannot drift from the pipeline, and it fits inside the ten
 * milliseconds of processor time a free Cloudflare Worker is allowed.
 *
 * NOTAMs are the exception, because they are per aerodrome and there is no
 * way to ask for the whole country. They are fetched when asked for, kept
 * for the same half hour the server keeps them, and throttled.
 *
 * One station's METAR is the other, for a page that shows a single line —
 * the home page at nberkyilmaz.com — and should not download the country's
 * reports to show it. Kept for the five minutes the snapshot is, and drawn
 * from the same per-minute budget as NOTAMs.
 *
 * Nothing here knows it is running on Cloudflare. `worker.ts` adapts it to
 * a Worker, `scripts/dev.ts` to Node, and the tests call it directly.
 */

const MIN = 60_000;

export const AWC_CACHE = 'https://aviationweather.gov/data/cache';
export const AWC_API = 'https://aviationweather.gov/api/data';
export const CFPS = 'https://plan.navcanada.ca/weather/api/alpha/';

/**
 * Every Canadian upper wind site, asked for in one request. The same list
 * as `CANADIAN_UPPERWIND_SITES` in core — a test holds them together — kept
 * here so the relay bundles nothing but itself.
 */
export const UPPERWIND_SITES = [
  'CYYZ', 'CYOW', 'CYUL', 'CYQB', 'CYHZ', 'CYWG', 'CYYC', 'CYEG', 'CYVR',
  'CYXE', 'CYQR', 'CYQT', 'CYZF', 'CYXY', 'CYFB', 'CYYT', 'CYQX',
] as const;

export interface Product {
  /** The storage key, and the name the status page uses. */
  readonly key: string;
  readonly upstream: string;
  /**
   * How often it is worth asking. Set by how often the product changes and
   * by the free plan's thousand writes a day: these come to 600.
   */
  readonly everyMs: number;
  readonly contentType: string;
  /** Kept as the service sent it, compressed, and served with `Content-Encoding: gzip`. */
  readonly gzip: boolean;
  /** What a `204 No Content` means for this product, when it means "nothing in force". */
  readonly emptyBody?: string;
}

export const PRODUCTS: Readonly<Record<'metars' | 'tafs' | 'isigmet' | 'airsigmet' | 'upperwind', Product>> = {
  // Every station on earth, rebuilt by the service each minute. Hourly reports and specials between them.
  metars: { key: 'metars', upstream: `${AWC_CACHE}/metars.cache.csv.gz`, everyMs: 5 * MIN, contentType: 'text/csv; charset=utf-8', gzip: true },
  // Issued four times a day, amended when they are wrong.
  tafs: { key: 'tafs', upstream: `${AWC_CACHE}/tafs.cache.xml.gz`, everyMs: 15 * MIN, contentType: 'application/xml; charset=utf-8', gzip: true },
  // A hazard advisory can be issued at any moment; a quarter of an hour is the server's window too.
  isigmet: { key: 'isigmet', upstream: `${AWC_API}/isigmet?format=json`, everyMs: 15 * MIN, contentType: 'application/json', gzip: false, emptyBody: '[]' },
  airsigmet: { key: 'airsigmet', upstream: `${AWC_API}/airsigmet?format=json`, everyMs: 15 * MIN, contentType: 'application/json', gzip: false, emptyBody: '[]' },
  // Three bulletins a day; asking more than hourly buys nothing.
  upperwind: {
    key: 'upperwind',
    upstream: `${CFPS}?${UPPERWIND_SITES.map((s) => `site=${s}`).join('&')}&alpha=upperwind`,
    everyMs: 60 * MIN,
    contentType: 'application/json',
    gzip: false,
  },
};

/** A cron tick lands a few seconds either side of the minute; without slack a 15-minute product would wait 20. */
const SLACK_MS = 1 * MIN;
const UPSTREAM_TIMEOUT_MS = 20_000;
/** The same half hour the server waits before asking CFPS about a site again. */
export const NOTAM_FRESH_MS = 30 * MIN;
/** The same five minutes the country's METARs are kept for. */
export const METAR_FRESH_MS = 5 * MIN;
/** Upstream requests for one aerodrome — NOTAMs or a METAR — one instance will make in a minute, for anybody. */
export const NOTAM_FETCHES_PER_MINUTE = 20;
const MEMO_MAX = 2_000;

export interface SnapshotMeta {
  /** When the relay received it from the service: the age a page shows. */
  readonly fetchedAt: string;
  readonly upstream: string;
}

/** The part of Workers KV the relay uses, so a Map can stand in for it. */
export interface Kv {
  getWithMetadata(key: string, type: 'arrayBuffer'): Promise<{ value: ArrayBuffer | null; metadata: SnapshotMeta | null }>;
  put(key: string, value: ArrayBuffer, options: { metadata: SnapshotMeta }): Promise<void>;
}

export interface RelayEnv {
  readonly SNAPSHOTS: Kv;
  /** Origins a page may call from, comma separated. A list, never `*`. */
  readonly ALLOWED_ORIGINS?: string;
  readonly USER_AGENT?: string;
}

export interface RelayDeps {
  readonly fetch: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;
  readonly now: () => number;
}

export interface RelayRequest {
  readonly method: string;
  readonly url: string;
  readonly origin: string | null;
}

export interface RelayResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: ArrayBuffer | string | null;
}

export type RefreshOutcome =
  | { readonly key: string; readonly state: 'fresh'; readonly ageMs: number }
  | { readonly key: string; readonly state: 'refreshed'; readonly bytes: number }
  | { readonly key: string; readonly state: 'failed'; readonly error: string };

interface Snapshot {
  readonly body: ArrayBuffer;
  readonly meta: SnapshotMeta;
}

const DEFAULT_USER_AGENT = 'depbrief-relay/0.1 (+https://github.com/nberkyilmaz/departure-brief)';

/** The route each product is served at: the service's own path, under a prefix naming the service. */
function productFor(url: URL): Product | null {
  switch (url.pathname) {
    case '/awc/cache/metars.cache.csv.gz':
      return PRODUCTS.metars;
    case '/awc/cache/tafs.cache.xml.gz':
      return PRODUCTS.tafs;
    case '/awc/isigmet':
      return PRODUCTS.isigmet;
    case '/awc/airsigmet':
      return PRODUCTS.airsigmet;
    case '/cfps/':
    case '/cfps':
      // Whichever sites were asked about, the answer is all of them: the
      // client keeps every site the service answers for.
      return url.searchParams.get('alpha') === 'upperwind' ? PRODUCTS.upperwind : null;
    default:
      return null;
  }
}

const isGzip = (b: ArrayBuffer): boolean => {
  const v = new Uint8Array(b, 0, Math.min(2, b.byteLength));
  return v[0] === 0x1f && v[1] === 0x8b;
};

/** An error page served with a 200 is still an error page; JSON starts with a bracket. */
const looksLikeJson = (b: ArrayBuffer): boolean => {
  const v = new Uint8Array(b, 0, Math.min(64, b.byteLength));
  for (const c of v) {
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) continue;
    return c === 0x5b || c === 0x7b;
  }
  return false;
};

export class Relay {
  private readonly allowed: ReadonlySet<string>;
  private readonly userAgent: string;
  private readonly notams = new Map<string, { at: number; body: string }>();
  private readonly stationMetars = new Map<string, { at: number; status: number; body: string }>();
  private upstreamFetches: number[] = [];

  constructor(
    private readonly env: RelayEnv,
    private readonly deps: RelayDeps,
  ) {
    this.allowed = new Set(
      (env.ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o !== '' && o !== '*'),
    );
    this.userAgent = env.USER_AGENT ?? DEFAULT_USER_AGENT;
  }

  async handle(req: RelayRequest): Promise<RelayResponse> {
    const cors = this.cors(req.origin);
    if (req.method === 'OPTIONS') {
      return { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Accept', 'Access-Control-Max-Age': '86400' }, body: null };
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'this relay only answers GET' }, cors);
    const url = new URL(req.url);
    let res: RelayResponse;
    if (url.pathname === '/' || url.pathname === '/status') res = await this.status(cors);
    else {
      const product = productFor(url);
      if (product) res = await this.serveSnapshot(product, cors);
      else if ((url.pathname === '/cfps/' || url.pathname === '/cfps') && url.searchParams.get('alpha') === 'notam') res = await this.serveNotams(url, cors);
      else if (url.pathname === '/awc/metar') res = await this.serveStationMetar(url, cors);
      else res = json(404, { error: 'not something this relay carries', carries: ['/awc/cache/metars.cache.csv.gz', '/awc/cache/tafs.cache.xml.gz', '/awc/isigmet', '/awc/airsigmet', '/awc/metar?ids=<id>&format=json', '/cfps/?alpha=upperwind', '/cfps/?site=<id>&alpha=notam', '/status'] }, cors);
    }
    return req.method === 'HEAD' ? { ...res, body: null } : res;
  }

  /**
   * One cron tick: refresh whatever is due, leave the rest. A product that
   * fails keeps its last good copy, which carries its own age, so a page
   * shows old weather as old rather than no weather at all.
   */
  async refresh(): Promise<RefreshOutcome[]> {
    const out: RefreshOutcome[] = [];
    for (const product of Object.values(PRODUCTS)) {
      const held = await this.read(product);
      const ageMs = held ? this.deps.now() - Date.parse(held.meta.fetchedAt) : Number.POSITIVE_INFINITY;
      if (ageMs < product.everyMs - SLACK_MS) {
        out.push({ key: product.key, state: 'fresh', ageMs });
        continue;
      }
      const result = await this.fetchProduct(product);
      out.push('error' in result ? { key: product.key, state: 'failed', error: result.error } : { key: product.key, state: 'refreshed', bytes: result.body.byteLength });
    }
    return out;
  }

  private cors(origin: string | null): Record<string, string> {
    const base = { Vary: 'Origin', 'Access-Control-Expose-Headers': 'X-Fetched-At' };
    return origin && this.allowed.has(origin) ? { ...base, 'Access-Control-Allow-Origin': origin } : base;
  }

  private async read(product: Product): Promise<Snapshot | null> {
    const { value, metadata } = await this.env.SNAPSHOTS.getWithMetadata(product.key, 'arrayBuffer');
    return value && metadata ? { body: value, meta: metadata } : null;
  }

  private async fetchProduct(product: Product): Promise<Snapshot | { error: string }> {
    let body: ArrayBuffer;
    try {
      const res = await this.deps.fetch(product.upstream, {
        headers: { 'User-Agent': this.userAgent, Accept: product.gzip ? '*/*' : 'application/json' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (res.status === 204 && product.emptyBody !== undefined) body = new TextEncoder().encode(product.emptyBody).buffer as ArrayBuffer;
      else if (!res.ok) return { error: `HTTP ${res.status} from ${product.upstream}` };
      else body = await res.arrayBuffer();
    } catch (e) {
      return { error: `${(e as Error).message} (${product.upstream})` };
    }
    // Kept only if it is what it claims to be, so a maintenance page never replaces good weather.
    if (product.gzip ? !isGzip(body) : !looksLikeJson(body)) return { error: `${product.upstream} did not send ${product.gzip ? 'a gzip file' : 'JSON'}` };
    const meta: SnapshotMeta = { fetchedAt: new Date(this.deps.now()).toISOString(), upstream: product.upstream };
    await this.env.SNAPSHOTS.put(product.key, body, { metadata: meta });
    return { body, meta };
  }

  private async serveSnapshot(product: Product, cors: Record<string, string>): Promise<RelayResponse> {
    let snap = await this.read(product);
    if (!snap) {
      // Only before the first tick has run, on a fresh deployment.
      const fetched = await this.fetchProduct(product);
      if ('error' in fetched) return json(503, { error: `no ${product.key} held yet, and the service could not be reached: ${fetched.error}` }, cors);
      snap = fetched;
    }
    return {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': product.contentType,
        ...(product.gzip ? { 'Content-Encoding': 'gzip' } : {}),
        // Short: the copy changes every few minutes, and the age header is the truth about it.
        'Cache-Control': 'public, max-age=60',
        'X-Fetched-At': snap.meta.fetchedAt,
      },
      body: snap.body,
    };
  }

  private async serveNotams(url: URL, cors: Record<string, string>): Promise<RelayResponse> {
    const sites = url.searchParams.getAll('site').map((s) => s.trim().toUpperCase());
    if (sites.length !== 1 || !/^[A-Z][A-Z0-9]{3}$/.test(sites[0]!)) return json(400, { error: 'NOTAMs are asked for one aerodrome at a time, by its four-letter identifier' }, cors);
    const site = sites[0]!;
    const now = this.deps.now();
    const memo = this.notams.get(site);
    if (memo && now - memo.at < NOTAM_FRESH_MS) return notamResponse(memo, cors);

    const retry = this.spend(now);
    if (retry !== null) {
      return json(429, { error: `this relay is asking NAV CANADA for as many NOTAMs as it will in a minute; try again in ${retry}s` }, { ...cors, 'Retry-After': String(retry) });
    }

    const upstream = `${CFPS}?site=${site}&alpha=notam`;
    let body: string;
    try {
      const res = await this.deps.fetch(upstream, { headers: { 'User-Agent': this.userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      if (!res.ok) return json(502, { error: `HTTP ${res.status} from NAV CANADA for ${site}` }, cors);
      body = await res.text();
    } catch (e) {
      return json(502, { error: `NAV CANADA could not be reached for ${site}: ${(e as Error).message}` }, cors);
    }
    const entry = { at: now, body };
    if (this.notams.size >= MEMO_MAX) this.notams.delete(this.notams.keys().next().value!);
    this.notams.set(site, entry);
    return notamResponse(entry, cors);
  }

  /** One station's latest METAR, as the AWC answers it. A station with nothing to report is kept as such, so it is not asked again either. */
  private async serveStationMetar(url: URL, cors: Record<string, string>): Promise<RelayResponse> {
    const ids = url.searchParams.getAll('ids').map((s) => s.trim().toUpperCase());
    if (ids.length !== 1 || !/^[A-Z][A-Z0-9]{3}$/.test(ids[0]!)) return json(400, { error: 'a METAR is asked for one station at a time, by its four-letter identifier' }, cors);
    const station = ids[0]!;
    const now = this.deps.now();
    const memo = this.stationMetars.get(station);
    if (memo && now - memo.at < METAR_FRESH_MS) return stationMetarResponse(memo, cors);

    const retry = this.spend(now);
    if (retry !== null) {
      return json(429, { error: `this relay is asking the AWC for as many stations as it will in a minute; try again in ${retry}s` }, { ...cors, 'Retry-After': String(retry) });
    }

    const upstream = `${AWC_API}/metar?ids=${station}&format=json`;
    let entry: { at: number; status: number; body: string };
    try {
      const res = await this.deps.fetch(upstream, { headers: { 'User-Agent': this.userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      if (res.status === 204) entry = { at: now, status: 404, body: JSON.stringify({ error: `the AWC has no recent METAR from ${station}` }) };
      else if (!res.ok) return json(502, { error: `HTTP ${res.status} from the AWC for ${station}` }, cors);
      else {
        const bytes = await res.arrayBuffer();
        if (!looksLikeJson(bytes)) return json(502, { error: `the AWC did not send JSON for ${station}` }, cors);
        entry = { at: now, status: 200, body: new TextDecoder().decode(bytes) };
      }
    } catch (e) {
      return json(502, { error: `the AWC could not be reached for ${station}: ${(e as Error).message}` }, cors);
    }
    if (this.stationMetars.size >= MEMO_MAX) this.stationMetars.delete(this.stationMetars.keys().next().value!);
    this.stationMetars.set(station, entry);
    return stationMetarResponse(entry, cors);
  }

  /** Takes one request from the per-minute upstream budget, or says how many seconds until one is free. */
  private spend(now: number): number | null {
    this.upstreamFetches = this.upstreamFetches.filter((t) => now - t < MIN);
    if (this.upstreamFetches.length >= NOTAM_FETCHES_PER_MINUTE) return Math.ceil((this.upstreamFetches[0]! + MIN - now) / 1000);
    this.upstreamFetches.push(now);
    return null;
  }

  /** What is held and how old it is. 200 only when everything is there and none of it has gone stale. */
  private async status(cors: Record<string, string>): Promise<RelayResponse> {
    const now = this.deps.now();
    const products = [];
    let healthy = true;
    for (const p of Object.values(PRODUCTS)) {
      const snap = await this.read(p);
      const ageMinutes = snap ? Math.round((now - Date.parse(snap.meta.fetchedAt)) / MIN) : null;
      // Three missed windows means the timer has stopped, not that a service hiccuped.
      const stale = ageMinutes === null || ageMinutes * MIN > 3 * p.everyMs;
      if (stale) healthy = false;
      products.push({ product: p.key, fetchedAt: snap?.meta.fetchedAt ?? null, ageMinutes, everyMinutes: p.everyMs / MIN, stale });
    }
    return json(healthy ? 200 : 503, { ok: healthy, products }, { ...cors, 'Cache-Control': 'no-store' });
  }
}

function json(status: number, value: unknown, headers: Record<string, string>): RelayResponse {
  return { status, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}

function notamResponse(entry: { at: number; body: string }, cors: Record<string, string>): RelayResponse {
  return { status: 200, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', 'X-Fetched-At': new Date(entry.at).toISOString() }, body: entry.body };
}

function stationMetarResponse(entry: { at: number; status: number; body: string }, cors: Record<string, string>): RelayResponse {
  return { status: entry.status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', 'X-Fetched-At': new Date(entry.at).toISOString() }, body: entry.body };
}
