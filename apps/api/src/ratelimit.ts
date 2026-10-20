/**
 * A cap on how often one visitor can ask for a briefing.
 *
 * Assembling a briefing sends requests to the weather services, so an open
 * form on a public page is a way for one visitor to spend somebody else's
 * capacity. The freshness windows already stop repeat requests for the same
 * station; this stops the rest — a script walking the aerodrome list.
 *
 * In process and per instance, which is the honest scope: it keeps this
 * server from being rude to its upstreams. It is not a defence against
 * somebody determined, and it is not claimed to be one.
 */
export interface RateLimit {
  /** `null` when the call is allowed; otherwise the seconds until it will be. */
  check(key: string, now: number): number | null;
}

export interface FixedWindowOptions {
  /** Calls allowed per window, per key. */
  readonly limit: number;
  readonly windowMs: number;
  /** Keys held at once. Past it the expired ones are dropped, so memory is bounded. */
  readonly maxKeys?: number;
}

/**
 * A fixed window per key: `limit` calls per `windowMs`, counted from the
 * first call of the window. Simple on purpose — it is read on every briefing
 * request and its behaviour should be obvious from the 429 it returns.
 */
export function fixedWindow(options: FixedWindowOptions): RateLimit {
  const maxKeys = options.maxKeys ?? 10_000;
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    check(key, now) {
      const open = windows.get(key);
      if (!open || now >= open.resetAt) {
        if (windows.size >= maxKeys) for (const [k, w] of windows) if (now >= w.resetAt) windows.delete(k);
        windows.set(key, { count: 1, resetAt: now + options.windowMs });
        return null;
      }
      if (open.count < options.limit) {
        open.count++;
        return null;
      }
      return Math.max(1, Math.ceil((open.resetAt - now) / 1000));
    },
  };
}
