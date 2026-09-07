/**
 * Run the API over the Compose Postgres, serving the built web app when it
 * exists. Reads `.env` from the repo root when present.
 */
import { AwcClient, createHttpClient, PostgresStore } from '@holdshort/core';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from './server.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
for (const env of [join(root, '.env'), '.env']) if (existsSync(env)) process.loadEnvFile(env);

const userAgent = process.env.HOLDSHORT_USER_AGENT ?? 'holdshort/0.1 (+https://github.com/holdshort)';
const store = await PostgresStore.connect();
const http = createHttpClient({
  userAgent,
  cache: process.env.HOLDSHORT_HTTP_CACHE ? { dir: process.env.HOLDSHORT_HTTP_CACHE, ttlMs: 5 * 60_000 } : null,
});
const app = buildServer({ store, awc: new AwcClient(http), staticDir: join(root, 'apps', 'web', 'dist'), logger: true });

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
await app.listen({ port, host });

const shutdown = async () => {
  await app.close();
  await store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
