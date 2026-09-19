/**
 * Run the API over Postgres, serving the built web app when it exists.
 * Reads `.env` from the repo root when present.
 *
 * This is also the entry point a host runs, so it does the things a host
 * needs and a laptop does not: it loads airport data into an empty database,
 * it says whether it believes a proxy's headers, and it opens its port
 * before the slow parts of boot so a health check has something to talk to.
 */
import { AwcClient, createHttpClient, ensureAirportData, llmFromEnv, NavCanadaClient, PostgresStore } from '@depbrief/core';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer, type InstanceStatus } from './server.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
for (const env of [join(root, '.env'), '.env']) if (existsSync(env)) process.loadEnvFile(env);

const userAgent = process.env.DEPBRIEF_USER_AGENT ?? 'depbrief/0.1 (+https://github.com/nberkyilmaz/departure-brief)';

/**
 * What the instance can say about itself, kept here rather than in the
 * server because it is a property of this process's boot, not of the HTTP
 * surface. It starts as `loading` because that is true: nothing has been
 * counted yet.
 */
let status: InstanceStatus = { airports: 0, airportData: 'loading', reason: null };

const store = await PostgresStore.connect(undefined, {
  // Without a listener here the first idle connection a hosted database
  // drops is an unhandled error event, which is a process-level throw.
  // `app` is built below; a pool error during migration would arrive before
  // there is a logger, so this asks whether there is one rather than assuming.
  onPoolError: (err) => (typeof app === 'undefined' ? console.warn(err.message) : app.log.warn({ err }, 'idle database connection dropped')),
  // A database that is not answering yet is waited for rather than died of:
  // on a host, dying of it is a crash loop that pays the cold start every
  // time round. This runs before the logger exists, so it writes directly.
  onWaiting: (message) => console.warn(message),
});
const http = createHttpClient({
  userAgent,
  cache: process.env.DEPBRIEF_HTTP_CACHE ? { dir: process.env.DEPBRIEF_HTTP_CACHE, ttlMs: 5 * 60_000 } : null,
  // The airport snapshot is 17 MB; the default ten seconds is for a METAR.
  timeoutMs: Number(process.env.DEPBRIEF_HTTP_TIMEOUT_MS ?? 60_000),
});
const llm = llmFromEnv();

const origins = (process.env.DEPBRIEF_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter((o) => o !== '');

const app = buildServer({
  store,
  awc: new AwcClient(http),
  navcanada: new NavCanadaClient(http),
  llm,
  staticDir: join(root, 'apps', 'web', 'dist'),
  aircraftDir: join(root, 'aircraft'),
  docCacheDir: process.env.DEPBRIEF_DOC_CACHE ?? join(root, 'data', 'docs'),
  // `true`, or the proxy's address. Unset, the rate limiter counts every
  // visitor behind a proxy as the proxy and refuses the twenty-first
  // briefing of the minute to whoever happens to ask for it. Set, it
  // believes a header the caller wrote — which is why the instance-wide cap
  // exists and does not.
  trustProxy: process.env.TRUST_PROXY === 'true' ? true : (process.env.TRUST_PROXY ?? false),
  allowedOrigins: origins,
  status: () => status,
  logger: true,
});
app.log.info(`NOTAM relevance model: ${llm?.description ?? 'none (set DEPBRIEF_LLM=ollama)'}`);

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
await app.listen({ port, host });

/*
 * Airport data, after the port is open and not before.
 *
 * An empty database means every briefing fails at its first waypoint, so
 * this has to happen — but it is a 17 MB download and 26,000 rows, which on
 * a cold free-tier instance is a minute or two. Done before `listen` that is
 * a minute or two in which the host cannot see a port and concludes the
 * service failed to start. So the port opens first, `/api/health` reports
 * 503 with `airportData: loading` until this finishes, and a briefing asked
 * for in the meantime is told what is happening rather than that its
 * aerodrome does not exist.
 */
void (async () => {
  const result = await ensureAirportData(store, http, { onProgress: (m) => app.log.info(m) });
  const airports = await store.countAirports().catch(() => 0);
  if (result.state === 'failed') {
    status = { airports, airportData: airports > 0 ? 'ready' : 'missing', reason: result.reason };
    app.log.error(result.reason);
    return;
  }
  status = { airports, airportData: airports > 0 ? 'ready' : 'missing', reason: airports > 0 ? null : 'the snapshot loaded but the store is empty' };
  app.log.info(
    result.state === 'present'
      ? `${airports.toLocaleString('en')} aerodromes already loaded`
      : `${airports.toLocaleString('en')} aerodromes loaded from the ${result.snapshot} snapshot`,
  );
})();

const shutdown = async () => {
  await app.close();
  await store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
