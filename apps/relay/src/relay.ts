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
 * the hazard advisories, the Canadian upper winds, the American balloon
 * soundings — and keeps the latest copy. A
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
export const NOAA_RAW_US = 'https://tgftp.nws.noaa.gov/data/raw/us';
export const NWS_API = 'https://api.weather.gov';

/**
 * Every Canadian upper wind site, asked for in one request. The same list
 * as `CANADIAN_UPPERWIND_SITES` in core — a test holds them together — kept
 * here so the relay bundles nothing but itself.
 */
export const UPPERWIND_SITES = [
  'CYAB', 'CYAH', 'CYAM', 'CYAY', 'CYBK', 'CYBR', 'CYCB', 'CYCO', 'CYDB', 'CYDL',
  'CYEG', 'CYEU', 'CYEV', 'CYFB', 'CYFC', 'CYFS', 'CYGP', 'CYGR', 'CYGW', 'CYHO',
  'CYHZ', 'CYIF', 'CYJA', 'CYKA', 'CYKL', 'CYLT', 'CYMA', 'CYMM', 'CYMO', 'CYMT',
  'CYMW', 'CYNA', 'CYNC', 'CYNM', 'CYOC', 'CYOD', 'CYOJ', 'CYOW', 'CYPH', 'CYPU',
  'CYQB', 'CYQD', 'CYQG', 'CYQH', 'CYQI', 'CYQL', 'CYQM', 'CYQR', 'CYQT', 'CYQX',
  'CYQY', 'CYRB', 'CYRI', 'CYRL', 'CYRT', 'CYSC', 'CYSM', 'CYSY', 'CYTE', 'CYTF',
  'CYTL', 'CYUL', 'CYUX', 'CYVC', 'CYVO', 'CYVP', 'CYVQ', 'CYVR', 'CYVV', 'CYWG',
  'CYWK', 'CYXC', 'CYXE', 'CYXJ', 'CYXS', 'CYXY', 'CYYB', 'CYYC', 'CYYD', 'CYYE',
  'CYYF', 'CYYH', 'CYYL', 'CYYQ', 'CYYR', 'CYYT', 'CYYU', 'CYYW', 'CYYY', 'CYYZ',
  'CYZF', 'CYZG', 'CYZH', 'CYZP', 'CYZS', 'CYZT', 'CYZV',
] as const;

/**
 * Every American balloon's file at NOAA. The same list as
 * `SOUNDING_STATIONS` in core — a test holds them together.
 */
export const SOUNDING_FILES = [
  'ushw40.phli.man.lih', 'ushw40.phto.man.ito', 'usus41.kaly.man.aly',
  'usus41.kbuf.man.buf', 'usus41.kcar.man.car', 'usus41.kgyx.man.gyx',
  'usus41.kiln.man.iln', 'usus41.klwx.man.iad', 'usus41.kokx.man.okx',
  'usus41.kpbz.man.pbz', 'usus41.krnk.man.rnk', 'usus42.kchs.man.chs',
  'usus42.kffc.man.ffc', 'usus42.kjax.man.jax', 'usus42.kkey.man.key',
  'usus42.kmfl.man.mfl', 'usus42.kmhx.man.mhx', 'usus42.krah.man.gso',
  'usus42.ktbw.man.tbw', 'usus43.kabr.man.abr', 'usus43.kapx.man.apx',
  'usus43.kbis.man.bis', 'usus43.kddc.man.ddc', 'usus43.kdlh.man.inl',
  'usus43.kdtx.man.dtx', 'usus43.kdvn.man.dvn', 'usus43.kgrb.man.grb',
  'usus43.kilx.man.ilx', 'usus43.klbf.man.lbf', 'usus43.kmpx.man.mpx',
  'usus43.koax.man.oax', 'usus43.ksgf.man.sgf', 'usus43.ktop.man.top',
  'usus43.kunr.man.unr', 'usus44.kama.man.ama', 'usus44.kbmx.man.bmx',
  'usus44.kbro.man.bro', 'usus44.kcrp.man.crp', 'usus44.kepz.man.epz',
  'usus44.kewx.man.drt', 'usus44.kfwd.man.fwd', 'usus44.kjan.man.jan',
  'usus44.klch.man.lch', 'usus44.klix.man.lix', 'usus44.klzk.man.lzk',
  'usus44.kmaf.man.maf', 'usus44.kohx.man.ohx', 'usus44.koun.man.oun',
  'usus44.kshv.man.shv', 'usus45.kabq.man.abq', 'usus45.kboi.man.boi',
  'usus45.kfgz.man.fgz', 'usus45.kggw.man.ggw', 'usus45.kgjt.man.gjt',
  'usus45.klkn.man.lkn', 'usus45.kpsr.man.psr', 'usus45.krev.man.rev',
  'usus45.kriw.man.riw', 'usus45.kslc.man.slc', 'usus45.ktfx.man.tfx',
  'usus45.ktwc.man.twc', 'usus45.kvef.man.vef', 'usus46.kmfr.man.mfr',
  'usus46.kmtr.man.oak', 'usus46.kotx.man.otx', 'usus46.kpqr.man.sle',
  'usus46.ksew.man.uil', 'usus46.ksgx.man.nkx',
] as const;

/**
 * Alaska's balloons, by the location the NWS product API holds them under:
 * they have no files of their own at NOAA. The same list as the stations
 * with an `nwsLocation` in core — a test holds them together.
 */
export const ALASKA_SOUNDINGS = ['ADQ', 'AKN', 'ANC', 'ANN', 'BET', 'BRW', 'CDB', 'FAI', 'MCG', 'OME', 'OTZ', 'SNP', 'YAK'] as const;

/**
 * NOAA has a file per balloon and the free plan allows fifty requests a
 * run, with the other products to fetch in the same one. So a run asks for
 * a third of them, the ones asked about longest ago, and three runs an hour
 * ask every balloon once.
 */
const SOUNDINGS_PER_RUN = 27;

/**
 * Significant levels are one more request per balloon, but only after its
 * mandatory levels have changed, which is twice a day. This many a run keeps
 * the worst run, with everything due and CFPS taking two, at 46 of the fifty.
 */
const SIGNIFICANT_PER_RUN = 12;

/** One of the small files a rotating product is made of. */
interface RotatingSource {
  /** What it is held under in the copy. */
  readonly key: string;
  readonly url: string;
  /** A plain file, or a product of the NWS API with the text and its date inside. */
  readonly shape: 'file' | 'nws-product';
  /** The NWS product holding the same flight's significant levels. */
  readonly significantUrl?: string;
}

const significantUrl = (location: string) => `${NWS_API}/products/types/SGL/locations/${location}/latest`;

const SOUNDING_SOURCES: readonly RotatingSource[] = [
  ...SOUNDING_FILES.map((key) => ({ key, url: `${NOAA_RAW_US}/${key}.txt`, shape: 'file' as const, significantUrl: significantUrl(key.slice(key.lastIndexOf('.') + 1).toUpperCase()) })),
  ...ALASKA_SOUNDINGS.map((key) => ({ key, url: `${NWS_API}/products/types/MAN/locations/${key}/latest`, shape: 'nws-product' as const, significantUrl: significantUrl(key) })),
];

/** Which flight a bulletin is from: the day and hour in its time group. */
const flightOf = (text: string): string | null => /\bTT(?:AA|BB)\s+(\d{4})/.exec(text)?.[1] ?? null;

export interface Product {
  /** The storage key, and the name the status page uses. */
  readonly key: string;
  readonly upstream: string;
  /**
   * How often it is worth asking. Set by how often the product changes and
   * by the free plan's thousand writes a day: all of them together come to
   * about 600.
   */
  readonly everyMs: number;
  readonly contentType: string;
  /** Kept as the service sent it, compressed, and served with `Content-Encoding: gzip`. */
  readonly gzip: boolean;
  /** What a `204 No Content` means for this product, when it means "nothing in force". */
  readonly emptyBody?: string;
  /** For a JSON product, a refusal dressed as an answer: why it is not the product, or `null` when it is. */
  readonly refusal?: (text: string) => Refusal | null;
  /** Many small files rather than one: kept together in one copy, and asked for a few at a time. */
  readonly rotating?: { readonly sources: readonly RotatingSource[]; readonly perRun: number };
}

/** One file of a rotating product, as the copy holds it. */
interface RotatingFile {
  readonly askedAt: string;
  readonly modified: string | null;
  readonly text: string;
  /** A balloon's significant levels, held beside its mandatory ones so they cost no write of their own. */
  readonly significant?: { readonly askedAt: string; readonly text: string };
}

export interface Refusal {
  readonly error: string;
  /** Sites the service says it does not know, which may be left out of the next request. */
  readonly unknownSites: readonly string[];
}

/**
 * How CFPS says no: still a 200, still JSON, with the reason in
 * `meta.messages` and nothing in `data`. `alpha.geomInvalid` names the
 * sites it does not recognise, and one of them is enough to empty the
 * answer for all the others. An answer with no upper winds in it at all is
 * not kept either: it would replace a country's winds with none.
 */
export function cfpsRefusal(text: string): Refusal | null {
  let parsed: { meta?: { messages?: { type?: string; message?: string; details?: unknown }[] }; data?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return { error: 'NAV CANADA did not send JSON', unknownSites: [] };
  }
  const errors = (parsed.meta?.messages ?? []).filter((m) => m.type === 'error');
  if (errors.length > 0) {
    const details = (m: { details?: unknown }) => (Array.isArray(m.details) ? m.details.map(String) : []);
    return {
      error: `NAV CANADA refused: ${errors.map((m) => `${m.message ?? 'an error'}${details(m).length > 0 ? ` (${details(m).join(', ')})` : ''}`).join('; ')}`,
      unknownSites: errors.filter((m) => m.message === 'alpha.geomInvalid').flatMap(details),
    };
  }
  if (!Array.isArray(parsed.data) || parsed.data.length === 0) return { error: 'NAV CANADA sent no upper winds', unknownSites: [] };
  return null;
}

export const PRODUCTS: Readonly<Record<'metars' | 'tafs' | 'sigmet' | 'gairmet' | 'aircraftreports' | 'upperwind' | 'soundings', Product>> = {
  // Every station on earth, rebuilt by the service each minute. Hourly reports and specials between them.
  metars: { key: 'metars', upstream: `${AWC_CACHE}/metars.cache.csv.gz`, everyMs: 5 * MIN, contentType: 'text/csv; charset=utf-8', gzip: true },
  // Issued four times a day, amended when they are wrong.
  tafs: { key: 'tafs', upstream: `${AWC_CACHE}/tafs.cache.xml.gz`, everyMs: 15 * MIN, contentType: 'application/xml; charset=utf-8', gzip: true },
  // A hazard advisory can be issued at any moment; a quarter of an hour is the server's window too.
  sigmet: { key: 'sigmet', upstream: `${AWC_API}/sigmet?format=json`, everyMs: 15 * MIN, contentType: 'application/json', gzip: false, emptyBody: '[]' },
  // Issued every six hours and amended when they are wrong, each with its forecast hours in the one file.
  gairmet: { key: 'gairmet', upstream: `${AWC_CACHE}/gairmets.cache.xml.gz`, everyMs: 60 * MIN, contentType: 'application/xml; charset=utf-8', gzip: true },
  // Pilot reports, the last ninety minutes of them, rebuilt by the service each minute.
  aircraftreports: { key: 'aircraftreports', upstream: `${AWC_CACHE}/aircraftreports.cache.xml.gz`, everyMs: 20 * MIN, contentType: 'application/xml; charset=utf-8', gzip: true },
  // Three bulletins a day; asking more than hourly buys nothing.
  upperwind: {
    key: 'upperwind',
    upstream: `${CFPS}?${UPPERWIND_SITES.map((s) => `site=${s}`).join('&')}&alpha=upperwind`,
    everyMs: 60 * MIN,
    contentType: 'application/json',
    gzip: false,
    refusal: cfpsRefusal,
  },
  // Twice a day from each balloon, over an hour and a half; a run is a third of them.
  soundings: {
    key: 'soundings',
    upstream: NOAA_RAW_US,
    everyMs: 20 * MIN,
    contentType: 'application/json',
    gzip: false,
    rotating: { sources: SOUNDING_SOURCES, perRun: SOUNDINGS_PER_RUN },
  },
};

/*
 * The US winds aloft bulletins were carried here too, until NOAA
 * discontinued them: the model they were built from was retired on
 * 3 November 2026, and the bulletins went with it (SCN 26-47, updated
 * 5 November). The AWC now answers a request for one with a 400 saying so.
 * The balloon soundings are what replaced them.
 */
const ALL_PRODUCTS: readonly Product[] = Object.values(PRODUCTS);

/** A cron tick lands a few seconds either side of the minute; without slack a 15-minute product would wait 20. */
const SLACK_MS = 1 * MIN;
const UPSTREAM_TIMEOUT_MS = 20_000;
/** A note names sites, and has to leave room in the metadata for everything else. */
const NOTE_MAX_CHARS = 400;
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
  /** Anything about this copy worth a look on the status page: sites the service no longer knows, say. */
  readonly note?: string;
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
    case '/awc/sigmet':
      return PRODUCTS.sigmet;
    case '/awc/cache/gairmets.cache.xml.gz':
      return PRODUCTS.gairmet;
    case '/awc/cache/aircraftreports.cache.xml.gz':
      return PRODUCTS.aircraftreports;
    case '/noaa/soundings':
      return PRODUCTS.soundings;
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
      else res = json(404, { error: 'not something this relay carries', carries: ['/awc/cache/metars.cache.csv.gz', '/awc/cache/tafs.cache.xml.gz', '/awc/cache/gairmets.cache.xml.gz', '/awc/cache/aircraftreports.cache.xml.gz', '/awc/sigmet', '/awc/metar?ids=<id>&format=json', '/noaa/soundings', '/cfps/?alpha=upperwind', '/cfps/?site=<id>&alpha=notam', '/status'] }, cors);
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
    for (const product of ALL_PRODUCTS) {
      const held = await this.read(product);
      const ageMs = held ? this.deps.now() - Date.parse(held.meta.fetchedAt) : Number.POSITIVE_INFINITY;
      if (ageMs < product.everyMs - SLACK_MS) {
        out.push({ key: product.key, state: 'fresh', ageMs });
        continue;
      }
      const result = product.rotating ? await this.fetchRotating(product, held) : await this.fetchProduct(product);
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

  private async fetchProduct(product: Product, upstream: string = product.upstream, note: string | null = null): Promise<Snapshot | { error: string }> {
    let body: ArrayBuffer;
    let empty = false;
    try {
      const res = await this.deps.fetch(upstream, {
        headers: { 'User-Agent': this.userAgent, Accept: product.gzip ? '*/*' : 'application/json' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (res.status === 204 && product.emptyBody !== undefined) {
        body = new TextEncoder().encode(product.emptyBody).buffer as ArrayBuffer;
        empty = true;
      } else if (!res.ok) return { error: `HTTP ${res.status} from ${upstream}` };
      else body = await res.arrayBuffer();
    } catch (e) {
      return { error: `${(e as Error).message} (${upstream})` };
    }
    // Kept only if it is what it claims to be, so a maintenance page never replaces good weather.
    const expected = product.gzip ? 'a gzip file' : 'JSON';
    const genuine = empty || (product.gzip ? isGzip(body) : looksLikeJson(body));
    if (!genuine) return { error: `${upstream} did not send ${expected}` };
    const refused = !empty && product.refusal ? product.refusal(new TextDecoder().decode(body)) : null;
    if (refused) {
      /*
       * Once, and only without the sites the service named: a site NAV
       * CANADA stops recognising costs that one site, not the country.
       */
      const url = new URL(upstream);
      const asked = url.searchParams.getAll('site');
      const kept = asked.filter((s) => !refused.unknownSites.includes(s));
      if (note === null && kept.length > 0 && kept.length < asked.length) {
        url.searchParams.delete('site');
        const query = [...kept.map((s) => `site=${s}`), ...[...url.searchParams].map(([k, v]) => `${k}=${v}`)].join('&');
        const dropped = asked.filter((s) => !kept.includes(s));
        return this.fetchProduct(product, `${url.origin}${url.pathname}?${query}`, `NAV CANADA does not recognise ${dropped.join(', ')}; asked without ${dropped.length === 1 ? 'it' : 'them'}`);
      }
      return { error: `${refused.error} (${upstream})` };
    }
    return this.keep(product, body, upstream, note);
  }

  /**
   * Refreshes a third of a product made of many files, leaving the rest of
   * the copy as it was. A file that does not answer keeps what it had: a
   * balloon's last sounding carries its own time, so it is shown as old
   * rather than gone. The ones just asked go to the back of the queue either
   * way, or a file NOAA has removed would be first in it for ever.
   */
  private async fetchRotating(product: Product, held: Snapshot | null): Promise<Snapshot | { error: string }> {
    const { sources, perRun } = product.rotating!;
    let copy: Record<string, RotatingFile> = {};
    if (held) {
      try {
        copy = JSON.parse(new TextDecoder().decode(held.body)) as Record<string, RotatingFile>;
      } catch {
        // Nothing in it can be used, and the runs ahead will fill it again.
      }
    }
    const askedAt = new Date(this.deps.now()).toISOString();
    // Compared as they are: `localeCompare` takes ten milliseconds the first time an isolate uses it, which is the whole of the free plan's allowance.
    const oldestFirst = (askedOf: (s: RotatingSource) => string) => (a: RotatingSource, b: RotatingSource) => (askedOf(a) < askedOf(b) ? -1 : askedOf(a) > askedOf(b) ? 1 : 0);
    const turn = [...sources].sort(oldestFirst((s) => copy[s.key]?.askedAt ?? '')).slice(0, perRun);
    const failed: string[] = [];
    await Promise.all(
      turn.map(async ({ key, url, shape }) => {
        const { text, modified } = await this.readSource(url, shape);
        const had = copy[key];
        // Kept only if it is a sounding, so an error page never replaces one.
        if (text === null || !text.includes('TTAA')) {
          failed.push(key);
          copy[key] = { ...had, askedAt, modified: had?.modified ?? null, text: had?.text ?? '' };
        } else copy[key] = { ...had, askedAt, modified, text };
      }),
    );
    if (failed.length === turn.length) return { error: `none of the ${turn.length} files asked for answered (${product.upstream})` };

    /*
     * Nothing says when a balloon's file changes, so those are asked for
     * every hour. The significant levels are only worth asking for once one
     * has, so these are the balloons whose two parts are from different
     * flights. One that never appears goes to the back like any other.
     */
    const behind = sources.filter((s) => {
      const held = copy[s.key];
      return s.significantUrl && held && flightOf(held.text) !== null && flightOf(held.text) !== flightOf(held.significant?.text ?? '');
    });
    await Promise.all(
      behind
        .sort(oldestFirst((s) => copy[s.key]?.significant?.askedAt ?? ''))
        .slice(0, SIGNIFICANT_PER_RUN)
        .map(async ({ key, significantUrl: url }) => {
          const { text } = await this.readSource(url!, 'nws-product');
          const had = copy[key]!;
          copy[key] = { ...had, significant: { askedAt, text: text !== null && text.includes('TTBB') ? text : (had.significant?.text ?? '') } };
        }),
    );

    const body = new TextEncoder().encode(JSON.stringify(copy)).buffer as ArrayBuffer;
    return this.keep(product, body, product.upstream, failed.length > 0 ? `no answer for ${failed.join(', ')}` : null);
  }

  /** One small file's text and when it was written. Both `null` when it did not answer with any. */
  private async readSource(url: string, shape: RotatingSource['shape']): Promise<{ text: string | null; modified: string | null }> {
    try {
      const res = await this.deps.fetch(url, { headers: { 'User-Agent': this.userAgent, Accept: shape === 'file' ? 'text/plain' : 'application/ld+json' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      if (res.ok && shape === 'file') {
        const stamp = res.headers.get('last-modified');
        return { text: await res.text(), modified: stamp ? new Date(stamp).toISOString() : null };
      }
      if (res.ok) {
        const product = (await res.json()) as { productText?: unknown; issuanceTime?: unknown };
        return { text: typeof product.productText === 'string' ? product.productText : null, modified: typeof product.issuanceTime === 'string' ? new Date(product.issuanceTime).toISOString() : null };
      }
    } catch {
      // Counted by the caller, with the ones that answered with something else.
    }
    return { text: null, modified: null };
  }

  private async keep(product: Product, body: ArrayBuffer, upstream: string, note: string | null): Promise<Snapshot | { error: string }> {
    /*
     * KV refuses a whole write when its metadata is over 1,024 bytes, so this
     * says which service it came from and not the whole request: the upper
     * wind request's ninety-seven sites alone come to 1,030 characters.
     */
    const meta: SnapshotMeta = { fetchedAt: new Date(this.deps.now()).toISOString(), upstream: upstream.split('?')[0]!, ...(note ? { note: note.slice(0, NOTE_MAX_CHARS) } : {}) };
    try {
      await this.env.SNAPSHOTS.put(product.key, body, { metadata: meta });
    } catch (e) {
      // One product that cannot be stored is that product's failure, not the end of the tick.
      return { error: `could not store ${product.key}: ${(e as Error).message}` };
    }
    return { body, meta };
  }

  private async serveSnapshot(product: Product, cors: Record<string, string>): Promise<RelayResponse> {
    let snap = await this.read(product);
    if (!snap) {
      // Only before the first tick has run, on a fresh deployment.
      const fetched = product.rotating ? await this.fetchRotating(product, null) : await this.fetchProduct(product);
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
    for (const p of ALL_PRODUCTS) {
      const snap = await this.read(p);
      const ageMinutes = snap ? Math.round((now - Date.parse(snap.meta.fetchedAt)) / MIN) : null;
      // Three missed windows means the timer has stopped, not that a service hiccuped.
      const stale = ageMinutes === null || ageMinutes * MIN > 3 * p.everyMs;
      if (stale) healthy = false;
      products.push({ product: p.key, fetchedAt: snap?.meta.fetchedAt ?? null, ageMinutes, everyMinutes: p.everyMs / MIN, stale, ...(snap?.meta.note ? { note: snap.meta.note } : {}) });
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
