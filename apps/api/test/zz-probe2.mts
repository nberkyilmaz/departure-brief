import { createHttpClient } from '@depbrief/core';
import { fixedWindow } from '../src/ratelimit.js';
const keep = setInterval(() => {}, 500);
{
  const hang = (_url: string, init: any) => new Promise<Response>((_, reject) => { init.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))); });
  const ok = () => Promise.resolve(new Response('{}', { status: 200 }));
  const client = createHttpClient({ userAgent: 't', timeoutMs: 100, retries: 3, backoffMs: 10, minIntervalMs: 0, fetch: ((url: string, init: any) => (url.includes('hung') ? hang(url, init) : ok())) as any });
  const t0 = Date.now();
  const p1 = client.get('https://hung.example/x').then(() => 'resolved?!', (e) => `rejected: ${e.name} after ${Date.now() - t0} ms`);
  const p2 = client.get('https://fine.example/y').then((r) => `status ${r.status} after ${Date.now() - t0} ms`);
  console.log('(e) hung upstream:', await p1, '| unrelated upstream queued behind it:', await p2, '| floor = 4 x 100 ms + 10+20+40 ms backoff = 470 ms');
}
{
  const rl = fixedWindow({ limit: 20, windowMs: 60_000, maxKeys: 10_000 });
  (global as any).gc?.();
  const before = process.memoryUsage().heapUsed;
  const now = Date.now();
  for (let i = 0; i < 300_000; i++) rl.check(`2001:db8::${i.toString(16)}`, now);
  (global as any).gc?.();
  const after = process.memoryUsage().heapUsed;
  console.log('(f) 300k spoofed callers within one window, maxKeys=10000 -> heap +', Math.round((after - before) / 1048576), 'MB');
}
clearInterval(keep);
