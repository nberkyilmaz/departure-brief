/**
 * The relay as a Cloudflare Worker: `fetch` answers the page, `scheduled`
 * is the timer. Everything else is in `relay.ts`.
 */
import { Relay, type RelayEnv } from './relay.js';

/** One per isolate, so the NOTAM memo and throttle last as long as the isolate does. */
let relay: Relay | null = null;
const relayFor = (env: RelayEnv): Relay => (relay ??= new Relay(env, { fetch: (url, init) => fetch(url, init), now: Date.now }));

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    const r = await relayFor(env).handle({ method: request.method, url: request.url, origin: request.headers.get('Origin') });
    /*
     * A product kept compressed is served compressed. `encodeBody: manual`
     * tells the runtime the bytes are already gzip, so it sends them as they
     * are with the header saying so, and the browser undoes it — rather than
     * compressing them a second time.
     */
    const init = { status: r.status, headers: r.headers, ...(r.headers['Content-Encoding'] ? { encodeBody: 'manual' } : {}) };
    return new Response(r.body, init as ResponseInit);
  },

  async scheduled(_controller: unknown, env: RelayEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      relayFor(env)
        .refresh()
        .then((outcomes) => console.log(outcomes.map((o) => `${o.key}: ${o.state}${o.state === 'failed' ? ` (${o.error})` : ''}`).join('; '))),
    );
  },
};
