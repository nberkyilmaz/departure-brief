import fastifyStatic from '@fastify/static';
import {
  assembleBriefing,
  ingestStation,
  notamsForFlight,
  parseAircraftLimits,
  parseFlightPlan,
  parsePilotProfile,
  resolveFlight,
  UnknownWaypointError,
  type AwcClient,
  type ConfiguredLLM,
  type NavCanadaClient,
  type Store,
} from '@holdshort/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ServerDeps {
  readonly store: Store;
  readonly awc: AwcClient;
  /** Canadian NOTAMs; absent means NOTAMs are neither fetched nor shown. */
  readonly navcanada?: NavCanadaClient | null;
  /** The relevance model; absent means NOTAMs are classified but not ranked. Never called except during a briefing request's fetch step. */
  readonly llm?: ConfiguredLLM | null;
  /** Directory of the built web app to serve at `/`; skipped when absent. */
  readonly staticDir?: string | null;
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
  const app = Fastify({ logger: deps.logger ?? false });
  const { store, awc } = deps;

  app.get('/api/health', async () => ({
    ok: true,
    notOperational: 'study and planning aid only — not an official briefing',
    notams: deps.navcanada ? 'navcanada-cfps' : null,
    model: deps.llm?.description ?? null,
  }));

  app.get<{ Params: { id: string } }>('/api/airports/:id', async (req, reply) => {
    const airport = await store.getAirport(req.params.id);
    if (!airport) return reply.code(404).send({ error: `no airport ${req.params.id.toUpperCase()} in the store` });
    return airport;
  });

  app.post<{ Body: BriefRequestBody }>('/api/briefings', async (req, reply) => {
    const body = req.body ?? ({} as BriefRequestBody);
    let plan, profile, aircraft, asOf: Date;
    try {
      plan = parseFlightPlan(body.plan);
      profile = parsePilotProfile(body.profile ?? defaultProfile());
      aircraft = body.aircraft === undefined || body.aircraft === null ? null : parseAircraftLimits(body.aircraft);
      asOf = body.asOf === undefined ? new Date() : new Date(body.asOf);
      if (Number.isNaN(asOf.getTime())) throw new Error('"asOf" must be an ISO instant');
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    if (body.fetch !== false) {
      const ids = [plan.departure, ...plan.route, plan.destination, plan.alternate].filter(
        (s): s is string => s !== null && /^[A-Z0-9]{3,4}$/.test(s),
      );
      for (const id of ids) await ingestStation({ store, awc }, id);
    }
    let resolved;
    try {
      resolved = await resolveFlight(store, plan, asOf);
    } catch (e) {
      if (e instanceof UnknownWaypointError) return reply.code(422).send({ error: e.message });
      throw e;
    }
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
    const briefing = assembleBriefing(resolved, profile, aircraft, new Date(), notams);
    const { inserted } = await store.putBriefing(briefing);
    return reply.code(inserted ? 201 : 200).send(briefing);
  });

  app.get<{ Params: { sha256: string } }>('/api/briefings/:sha256', async (req, reply) => {
    const b = await store.getBriefing(req.params.sha256);
    if (!b) return reply.code(404).send({ error: 'no such briefing' });
    return b;
  });

  app.get<{ Querystring: { flightKey?: string; limit?: string } }>('/api/briefings', async (req, reply) => {
    if (!req.query.flightKey) return reply.code(400).send({ error: '"flightKey" is required' });
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    return store.listBriefings(req.query.flightKey, Number.isFinite(limit) ? limit : 20);
  });

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
