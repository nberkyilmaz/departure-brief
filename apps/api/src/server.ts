import fastifyStatic from '@fastify/static';
import {
  assembleBriefing,
  computeLoading,
  cropPageImage,
  diffBriefings,
  IncompleteSpecError,
  ingestStation,
  ingestUpperWinds,
  recordFetchAttempt,
  shouldFetch,
  storeAndDecode,
  pageImagePath,
  notamsForFlight,
  parseAircraftLimits,
  recordForecastChecks,
  reliabilityNote,
  reliabilityOf,
  scorePair,
  withHandbookLimits,
  parseFlightPlan,
  parsePilotProfile,
  resolveFlight,
  resolveRoute,
  UnknownWaypointError,
  type AwcClient,
  type ConfiguredLLM,
  type Loading,
  type NavCanadaClient,
  type Store,
  type WeightBalanceSpec,
} from '@holdshort/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixedWindow, type RateLimit } from './ratelimit.js';

/**
 * Hazard advisories are not about any one station, so the fetch is recorded
 * against this name — it is how "we asked the service a moment ago" is
 * remembered for a product that has no station of its own.
 */
const HAZARD_STATION = 'WORLD';

export interface ServerDeps {
  readonly store: Store;
  readonly awc: AwcClient;
  /** Canadian NOTAMs; absent means NOTAMs are neither fetched nor shown. */
  readonly navcanada?: NavCanadaClient | null;
  /** The relevance model; absent means NOTAMs are classified but not ranked. Never called except during a briefing request's fetch step. */
  readonly llm?: ConfiguredLLM | null;
  /** Directory of the built web app to serve at `/`; skipped when absent. */
  readonly staticDir?: string | null;
  /**
   * How often one caller may ask for a briefing. Defaults to 20 a minute;
   * `null` turns it off, for a private instance or a test.
   */
  readonly rateLimit?: RateLimit | null;
  /** Where `<type>.wb.json` weight-and-balance specs live (default `aircraft`). */
  readonly aircraftDir?: string;
  /** The document cache written by `holdshort doc ingest` (default `data/docs`); page crops are served from it. */
  readonly docCacheDir?: string;
  readonly logger?: boolean;
}

interface BriefRequestBody {
  readonly plan: unknown;
  readonly profile?: unknown;
  readonly aircraft?: unknown;
  /** ISO instant; defaults to now. Only reports known by then are used. */
  readonly asOf?: string;
  /** Fetch the latest reports for every airport in the plan first. Default true. */
  readonly fetch?: boolean;
  /** Include NOTAMs. Default true when a NOTAM source is configured. */
  readonly notams?: boolean;
}

/**
 * The HTTP surface over the deterministic pipeline. No model is ever called
 * in a request; the only outward calls are weather fetches, which are
 * cached in the store.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? false,
    // A briefing request is a few hundred bytes; nothing here needs more.
    bodyLimit: 64 * 1024,
    // A request that has not arrived in half a minute is not going to.
    requestTimeout: 30_000,
  });
  const { store, awc } = deps;
  const briefingLimit = deps.rateLimit === undefined ? fixedWindow({ limit: 20, windowMs: 60_000 }) : deps.rateLimit;

  app.get('/api/health', async () => ({
    ok: true,
    notOperational: 'study and planning aid only — not an official briefing',
    notams: deps.navcanada ? 'navcanada-cfps' : null,
    model: deps.llm?.description ?? null,
  }));

  /**
   * How the forecasts this store has seen turned out, per station. Reading
   * only — pairing is a background job (`holdshort verify`), because it
   * needs observations that may not exist yet and this must not fetch.
   */
  app.get<{ Querystring: { station?: string; since?: string; limit?: string } }>('/api/verification', async (req, reply) => {
    const station = req.query.station ? req.query.station.toUpperCase() : null;
    const since = req.query.since ? new Date(req.query.since) : null;
    if (since && Number.isNaN(since.getTime())) return reply.code(400).send({ error: '"since" must be an ISO instant' });
    const limit = Number(req.query.limit ?? 1000);
    const pairs = await store.listVerificationPairs({ station, since, limit: Number.isFinite(limit) ? Math.min(limit, 5000) : 1000 });
    const stations = [...new Set(pairs.map((p) => p.check.station))].sort();
    return {
      stations: stations.map((s) => {
        const r = reliabilityOf(s, pairs.filter((p) => p.check.station === s));
        return { ...r, note: reliabilityNote(r) };
      }),
      pairs: pairs.map(scorePair),
    };
  });

  const aircraftDir = deps.aircraftDir ?? 'aircraft';
  const docCacheDir = deps.docCacheDir ?? 'data/docs';
  /** Everything but letters, digits and a dash is dropped, so the type can never walk out of the directory. */
  const specPath = (type: string) => {
    const safe = type.toLowerCase().replace(/[^a-z0-9-]/g, '');
    return safe.length > 0 ? join(aircraftDir, `${safe}.wb.json`) : null;
  };

  app.get<{ Params: { id: string } }>('/api/airports/:id', async (req, reply) => {
    const airport = await store.getAirport(req.params.id);
    if (!airport) return reply.code(404).send({ error: `no airport ${req.params.id.toUpperCase()} in the store` });
    return airport;
  });

  app.post<{ Body: BriefRequestBody }>('/api/briefings', async (req, reply) => {
    const retryAfter = briefingLimit?.check(req.ip, Date.now()) ?? null;
    if (retryAfter !== null) {
      return reply
        .code(429)
        .header('Retry-After', String(retryAfter))
        .send({ error: `too many briefings from this address; try again in ${retryAfter}s` });
    }
    const body = req.body ?? ({} as BriefRequestBody);
    let plan, profile, aircraft, asOf: Date;
    try {
      plan = parseFlightPlan(body.plan);
      profile = parsePilotProfile(body.profile ?? defaultProfile());
      aircraft = body.aircraft === undefined || body.aircraft === null ? null : parseAircraftLimits(body.aircraft);
      // Fill a missing demonstrated crosswind from the type's handbook data.
      if (aircraft) {
        const wb = specPath(aircraft.type);
        if (wb && existsSync(wb)) aircraft = withHandbookLimits(aircraft, JSON.parse(readFileSync(wb, 'utf8')) as WeightBalanceSpec);
      }
      asOf = body.asOf === undefined ? new Date() : new Date(body.asOf);
      if (Number.isNaN(asOf.getTime())) throw new Error('"asOf" must be an ISO instant');
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    /*
     * Resolve the route before fetching anything. Checking the waypoints
     * against the airport data costs nothing upstream; fetching first meant
     * a plan naming an aerodrome that does not exist still sent a round of
     * requests on its behalf before being rejected.
     */
    let route;
    try {
      route = await resolveRoute(store, plan);
    } catch (e) {
      if (e instanceof UnknownWaypointError) return reply.code(422).send({ error: e.message });
      throw e;
    }
    if (body.fetch !== false) {
      // Only fields that resolved, once each, under the identifier the
      // resolver will look reports up by — a field with no ICAO identifier
      // has no reports to ask for.
      const points = [...route.points, ...(route.alternate ? [route.alternate.point] : [])];
      const stations = [...new Set(points.map((p) => p.waypoint.airport?.icaoId ?? null).filter((s): s is string => s !== null))];
      for (const id of stations) await ingestStation({ store, awc }, id);
      /*
       * Upper winds are published for a few dozen places, almost never the
       * aerodromes on a light aircraft's route, so they are fetched for the
       * route rather than per station — one request for every candidate.
       */
      if (deps.navcanada) {
        try {
          await ingestUpperWinds({ store, navcanada: deps.navcanada }, points.map((p) => p.waypoint.position));
        } catch (e) {
          // A briefing without upper winds is worth having; it says so itself.
          req.log.warn({ err: e }, 'upper winds could not be fetched');
        }
      }
      /*
       * Hazard advisories belong to areas rather than stations, so they are
       * fetched whole and the geometry decides what is about this flight.
       * Not per station, and not per briefing either: the window keeps it to
       * once a quarter of an hour however many people are briefing.
       */
      try {
        const now = new Date();
        if (await shouldFetch(store, HAZARD_STATION, 'sigmet', now)) {
          const fetched = await awc.sigmets();
          // Recorded as asked whether or not anything was in force, which
          // most of the time it is not.
          await recordFetchAttempt(store, HAZARD_STATION, 'sigmet', now, fetched.request);
          await storeAndDecode(store, fetched.reports, fetched.request, now, HAZARD_STATION);
        }
      } catch (e) {
        req.log.warn({ err: e }, 'hazard advisories could not be fetched');
      }
    }
    // The route is already known good, so this cannot raise UnknownWaypoint.
    const resolved = await resolveFlight(store, plan, asOf);
    let notams = null;
    if (body.notams !== false && deps.navcanada) {
      notams = await notamsForFlight(
        {
          store,
          navcanada: body.fetch !== false ? deps.navcanada : null,
          provider: deps.llm?.provider ?? null,
          model: deps.llm?.model ?? null,
        },
        resolved,
        aircraft?.type ?? 'unknown',
      );
    }
    // What the forecasts assert, so it can be checked once the moment passes.
    await recordForecastChecks(store, resolved);
    const briefing = assembleBriefing(resolved, profile, aircraft, new Date(), notams);
    const { inserted } = await store.putBriefing(briefing);
    return reply.code(inserted ? 201 : 200).send(briefing);
  });

  app.get<{ Params: { sha256: string } }>('/api/briefings/:sha256', async (req, reply) => {
    const b = await store.getBriefing(req.params.sha256);
    if (!b) return reply.code(404).send({ error: 'no such briefing' });
    return b;
  });

  /**
   * What changed between this briefing and an earlier one — by default the
   * previous briefing of the same flight. 404 when there is nothing to
   * compare against, so the caller can say "first briefing" rather than
   * showing an empty diff.
   */
  app.get<{ Params: { sha256: string }; Querystring: { against?: string } }>('/api/briefings/:sha256/diff', async (req, reply) => {
    const after = await store.getBriefing(req.params.sha256);
    if (!after) return reply.code(404).send({ error: 'no such briefing' });
    // The newest briefing at or before this one — never a later one, or the
    // diff would read backwards in time.
    const before = req.query.against
      ? await store.getBriefing(req.query.against)
      : ((await store.listBriefings(after.flightKey, 50)).find((b) => b.sha256 !== after.sha256 && new Date(b.asOf).getTime() <= new Date(after.asOf).getTime()) ?? null);
    if (!before) return reply.code(404).send({ error: 'no earlier briefing for this flight to compare against' });
    return diffBriefings(before, after);
  });

  app.get<{ Querystring: { flightKey?: string; limit?: string } }>('/api/briefings', async (req, reply) => {
    if (!req.query.flightKey) return reply.code(400).send({ error: '"flightKey" is required' });
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    return store.listBriefings(req.query.flightKey, Number.isFinite(limit) ? limit : 20);
  });

  /** The aircraft type's weight-and-balance data as extracted from its POH, every figure with its page. */
  app.get<{ Params: { type: string } }>('/api/aircraft/:type/wb', async (req, reply) => {
    const p = specPath(req.params.type);
    if (!p || !existsSync(p)) return reply.code(404).send({ error: `no weight-and-balance data for ${req.params.type}; run holdshort doc wb <poh.pdf> --type ${req.params.type}` });
    return JSON.parse(readFileSync(p, 'utf8')) as WeightBalanceSpec;
  });

  /** A loading against those limits. Pure computation; nothing is stored. */
  app.post<{ Params: { type: string }; Body: Partial<Loading> }>('/api/aircraft/:type/wb', async (req, reply) => {
    const p = specPath(req.params.type);
    if (!p || !existsSync(p)) return reply.code(404).send({ error: `no weight-and-balance data for ${req.params.type}` });
    const spec = JSON.parse(readFileSync(p, 'utf8')) as WeightBalanceSpec;
    const b = req.body ?? {};
    if (!Number.isFinite(b.emptyWeightLb) || !(Number(b.emptyWeightLb) > 0) || !Number.isFinite(b.emptyMomentPer1000)) {
      return reply.code(400).send({ error: '"emptyWeightLb" and "emptyMomentPer1000" are required and must be real numbers, from the aircraft W&B record' });
    }
    const loads = { ...(b.stations ?? {}), ...(b.fuelGal ?? {}) };
    const bad = Object.entries(loads).filter(([, v]) => !Number.isFinite(v) || Number(v) < 0);
    if (bad.length > 0) return reply.code(400).send({ error: `these loads must be numbers of zero or more: ${bad.map(([k]) => k).join(', ')}` });
    const loading: Loading = {
      emptyWeightLb: Number(b.emptyWeightLb),
      emptyMomentPer1000: Number(b.emptyMomentPer1000),
      stations: b.stations ?? {},
      fuelGal: b.fuelGal ?? {},
      category: b.category === 'utility' ? 'utility' : 'normal',
    };
    try {
      return computeLoading(spec, loading);
    } catch (e) {
      if (e instanceof IncompleteSpecError) return reply.code(422).send({ error: e.message, review: spec.review });
      throw e;
    }
  });

  /** The cited region of a POH page, boxed, so a reader can check a figure against the ink. */
  app.get<{ Params: { sha256: string; page: string }; Querystring: { x?: string; y?: string; w?: string; h?: string } }>(
    '/api/documents/:sha256/pages/:page/crop',
    async (req, reply) => {
      if (!/^[0-9a-f]{64}$/.test(req.params.sha256)) return reply.code(400).send({ error: 'bad document id' });
      const page = Number(req.params.page);
      const img = pageImagePath(docCacheDir, req.params.sha256, page);
      if (!Number.isInteger(page) || !existsSync(img)) return reply.code(404).send({ error: 'no such page image; run holdshort doc ingest' });
      const box = { x: Number(req.query.x), y: Number(req.query.y), w: Number(req.query.w), h: Number(req.query.h) };
      if (![box.x, box.y, box.w, box.h].every(Number.isFinite)) return reply.code(400).send({ error: 'x, y, w, h are required' });
      if (box.w <= 0 || box.h <= 0 || box.w > 20_000 || box.h > 20_000 || box.x < 0 || box.y < 0) return reply.code(400).send({ error: 'x, y, w, h must describe a region of the page' });
      try {
        const png = await cropPageImage(await readFile(img), box);
        // Page images are content-addressed, so a crop of one never changes.
        return reply.type('image/png').header('cache-control', 'public, max-age=31536000, immutable').send(png);
      } catch (e) {
        return reply.code(500).send({ error: `could not crop that page: ${(e as Error).message}` });
      }
    },
  );

  const staticDir = deps.staticDir ?? null;
  if (staticDir && existsSync(join(staticDir, 'index.html'))) {
    app.register(fastifyStatic, { root: staticDir, wildcard: false });
    const index = readFileSync(join(staticDir, 'index.html'), 'utf8');
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.type('text/html').send(index);
      return reply.code(404).send({ error: 'not found' });
    });
  }

  return app;
}

function defaultProfile(): unknown {
  const candidates = ['profiles/default.json', '../../profiles/default.json'];
  for (const c of candidates) if (existsSync(c)) return JSON.parse(readFileSync(c, 'utf8'));
  return { ceilingAglFt: 3000, visibilitySm: 5, crosswindKt: 10 };
}
