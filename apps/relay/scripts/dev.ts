/**
 * The relay on a laptop: the same code the Worker runs, over Node's HTTP
 * server and an in-memory store, with the timer as a `setInterval`. It
 * fetches the real services, so it is how the page's live mode is tried
 * before anything is deployed.
 *
 *   npm run dev -w apps/relay
 *   VITE_DEMO=1 VITE_RELAY=http://127.0.0.1:8787 npm run dev -w apps/web
 */
import { createServer } from 'node:http';
import { MemoryKv } from '../src/memoryKv.js';
import { Relay } from '../src/relay.js';

const port = Number(process.env['PORT'] ?? 8787);
const relay = new Relay(
  {
    SNAPSHOTS: new MemoryKv(),
    ALLOWED_ORIGINS: process.env['ALLOWED_ORIGINS'] ?? 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173',
  },
  { fetch: (url, init) => fetch(url, init), now: Date.now },
);

createServer((req, res) => {
  relay
    .handle({ method: req.method ?? 'GET', url: `http://127.0.0.1:${port}${req.url ?? '/'}`, origin: req.headers.origin ?? null })
    .then((r) => {
      res.writeHead(r.status, r.headers);
      res.end(r.body === null ? undefined : typeof r.body === 'string' ? r.body : Buffer.from(r.body));
    })
    .catch((e: Error) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(e.message);
    });
}).listen(port, '127.0.0.1', () => console.log(`relay on http://127.0.0.1:${port}/status`));

// A minute rather than five: the relay decides what is due, so ticking often costs nothing.
const tick = () =>
  relay
    .refresh()
    .then((outcomes) => console.log(new Date().toISOString().slice(11, 19), outcomes.map((o) => `${o.key}: ${o.state}${o.state === 'failed' ? ` (${o.error})` : ''}`).join('; ')));
void tick();
setInterval(() => void tick(), 60_000);
