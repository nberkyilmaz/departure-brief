import { describe, expect, it } from 'vitest';
import { fixedWindow } from '../src/ratelimit.js';

describe('fixedWindow', () => {
  it('allows a burst, then says how long to wait', () => {
    const limit = fixedWindow({ limit: 3, windowMs: 60_000 });
    const t = 1_000_000;
    expect(limit.check('a', t)).toBeNull();
    expect(limit.check('a', t + 10)).toBeNull();
    expect(limit.check('a', t + 20)).toBeNull();
    expect(limit.check('a', t + 30)).toBe(60);
    // Another caller is unaffected by the first one's spending.
    expect(limit.check('b', t + 30)).toBeNull();
    // And the window opens again once it has passed.
    expect(limit.check('a', t + 60_000)).toBeNull();
  });

  it('rounds the wait up, so a caller told 1s never comes back too early', () => {
    const limit = fixedWindow({ limit: 1, windowMs: 1_000 });
    expect(limit.check('a', 0)).toBeNull();
    expect(limit.check('a', 100)).toBe(1);
    expect(limit.check('a', 999)).toBe(1);
  });

  it('forgets expired callers rather than growing without bound', () => {
    const limit = fixedWindow({ limit: 1, windowMs: 1_000, maxKeys: 2 });
    limit.check('a', 0);
    limit.check('b', 0);
    // 'a' and 'b' have expired by now, so the third caller is admitted and
    // the map does not keep every address that has ever visited.
    expect(limit.check('c', 5_000)).toBeNull();
    expect(limit.check('a', 5_000)).toBeNull();
  });
});
