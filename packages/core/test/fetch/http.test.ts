import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpClient, expectOk, HttpError } from '../../src/fetch/http.js';

interface Scripted {
  status?: number;
  body?: string;
  throw?: boolean;
}

/** A fake `fetch` that plays a script of responses and records calls; time is virtual. */
function harness(script: Scripted[]) {
  const calls: { url: string; headers: Record<string, string>; at: number }[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const step = script[calls.length] ?? { status: 200, body: 'ok' };
    calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) }, at: clock });
    if (step.throw) throw new Error('network down');
    return new Response(step.body ?? 'ok', { status: step.status ?? 200, headers: { 'X-Test': 'yes' } });
  }) as unknown as typeof fetch;
  return {
    calls,
    sleeps,
    options: {
      fetch: fakeFetch,
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    },
  };
}

describe('createHttpClient', () => {
  it('sends the User-Agent and merges headers; lower-cases response headers', async () => {
    const h = harness([]);
    const http = createHttpClient({ userAgent: 'holdshort-test', ...h.options });
    const res = await http.get('https://example.test/a', { headers: { client_id: 'x' } });
    expect(res.status).toBe(200);
    expect(res.body).toBe('ok');
    expect(res.headers['x-test']).toBe('yes');
    expect(h.calls[0]?.headers['User-Agent']).toBe('holdshort-test');
    expect(h.calls[0]?.headers['client_id']).toBe('x');
  });

  it('spaces requests by the minimum interval, even when called concurrently', async () => {
    const h = harness([]);
    const http = createHttpClient({ userAgent: 'x', minIntervalMs: 1000, ...h.options });
    await Promise.all([http.get('https://e/1'), http.get('https://e/2'), http.get('https://e/3')]);
    const starts = h.calls.map((c) => c.at);
    expect(starts[1]! - starts[0]!).toBe(1000);
    expect(starts[2]! - starts[1]!).toBe(1000);
  });

  it('retries 5xx and 429 with exponential backoff, then returns the last response', async () => {
    const h = harness([{ status: 503 }, { status: 429 }, { status: 200, body: 'fine' }]);
    const http = createHttpClient({ userAgent: 'x', minIntervalMs: 0, backoffMs: 100, ...h.options });
    const res = await http.get('https://e/x');
    expect(res.body).toBe('fine');
    expect(h.calls.length).toBe(3);
    expect(h.sleeps).toEqual([100, 200]);

    const exhausted = harness([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }]);
    const http2 = createHttpClient({ userAgent: 'x', minIntervalMs: 0, retries: 3, backoffMs: 1, ...exhausted.options });
    expect((await http2.get('https://e/y')).status).toBe(500);
    expect(exhausted.calls.length).toBe(4);
  });

  it('retries network errors and rethrows when exhausted', async () => {
    const h = harness([{ throw: true }, { status: 200, body: 'recovered' }]);
    const http = createHttpClient({ userAgent: 'x', minIntervalMs: 0, backoffMs: 1, ...h.options });
    expect((await http.get('https://e/z')).body).toBe('recovered');

    const dead = harness([{ throw: true }, { throw: true }]);
    const http2 = createHttpClient({ userAgent: 'x', minIntervalMs: 0, retries: 1, backoffMs: 1, ...dead.options });
    await expect(http2.get('https://e/w')).rejects.toThrow('network down');
  });

  it('does not retry 4xx other than 429', async () => {
    const h = harness([{ status: 404, body: 'nope' }]);
    const http = createHttpClient({ userAgent: 'x', minIntervalMs: 0, ...h.options });
    expect((await http.get('https://e/404')).status).toBe(404);
    expect(h.calls.length).toBe(1);
  });

  describe('disk cache', () => {
    const dir = mkdtempSync(join(tmpdir(), 'holdshort-http-'));
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('serves a fresh 2xx from disk and refetches after the TTL', async () => {
      const h = harness([{ status: 200, body: 'first' }, { status: 200, body: 'second' }]);
      const http = createHttpClient({ userAgent: 'x', minIntervalMs: 0, cache: { dir, ttlMs: 5000 }, ...h.options });
      expect((await http.get('https://e/c')).body).toBe('first');
      expect((await http.get('https://e/c')).body).toBe('first');
      expect(h.calls.length).toBe(1);
      await h.options.sleep(6000);
      expect((await http.get('https://e/c')).body).toBe('second');
      expect(h.calls.length).toBe(2);
    });

    it('never caches non-2xx', async () => {
      const h = harness([{ status: 404 }, { status: 200, body: 'now ok' }]);
      const http = createHttpClient({ userAgent: 'x', minIntervalMs: 0, cache: { dir, ttlMs: 5000 }, ...h.options });
      expect((await http.get('https://e/d')).status).toBe(404);
      expect((await http.get('https://e/d')).body).toBe('now ok');
    });
  });
});

describe('a deadline on every attempt', () => {
  /** Accepts the connection and then says nothing — the case a bare fetch waits out forever. */
  function stalling(): { calls: number[]; fetch: typeof fetch } {
    const calls: number[] = [];
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(calls.length);
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error));
      });
    }) as unknown as typeof fetch;
    return { calls, fetch: fake };
  }

  it('abandons the attempt, retries, and finally throws rather than hanging', async () => {
    const h = stalling();
    const sleeps: number[] = [];
    const http = createHttpClient({
      userAgent: 'x',
      minIntervalMs: 0,
      timeoutMs: 10,
      retries: 2,
      fetch: h.fetch,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    await expect(http.get('https://e/stalls')).rejects.toThrow();
    // Requests are serialised, so a hang here is a hang for every caller.
    expect(h.calls.length).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
  });
});

describe('expectOk', () => {
  it('passes 2xx and throws HttpError otherwise', () => {
    const ok = { status: 204, body: '', headers: {} };
    expect(expectOk('u', ok)).toBe(ok);
    expect(() => expectOk('https://e/f', { status: 503, body: 'down', headers: {} })).toThrow(HttpError);
  });
});
