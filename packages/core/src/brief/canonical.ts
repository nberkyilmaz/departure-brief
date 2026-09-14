import { sha256Hex } from '../hash/sha256.js';

/**
 * Canonical JSON: keys sorted recursively, dates as ISO strings, `undefined`
 * dropped. Two structurally equal values always serialise to the same
 * bytes, which is what makes content addressing meaningful.
 */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = canonicalize(v);
  }
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** SHA-256 hex of the canonical JSON. Portable, so the same bytes hash the same anywhere. */
export function contentHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
