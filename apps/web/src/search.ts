import type { Aerodrome } from './engine.js';

/**
 * Finding a field among seventeen thousand by what someone types: an
 * identifier, either kind, or part of a name.
 *
 * Best first: the identifier itself, then identifiers that begin with what
 * was typed, then names with a word that begins with it, then names that
 * merely contain it. Among equals a field that reports weather comes first,
 * because "Miami" means the airport with a METAR more often than the
 * private strip that shares its name.
 */
export type AerodromeSearch = (query: string, limit?: number) => readonly Aerodrome[];

export function aerodromeSearch(all: readonly Aerodrome[], reporting: ReadonlySet<string> = new Set()): AerodromeSearch {
  // Upper-cased once, rather than seventeen thousand times a keystroke.
  const names = all.map((a) => a.name.toUpperCase());
  return (query, limit = 8) => {
    const q = query.trim().toUpperCase();
    if (q === '') return [];
    const found: { a: Aerodrome; rank: number }[] = [];
    all.forEach((a, i) => {
      let rank: number;
      if (a.id === q || a.faaId === q) rank = 0;
      else if (a.id.startsWith(q) || a.faaId?.startsWith(q)) rank = 1;
      else {
        const name = names[i]!;
        const at = name.indexOf(q);
        if (at < 0) return;
        rank = at === 0 || !/[A-Z0-9]/.test(name[at - 1]!) ? 2 : 3;
      }
      found.push({ a, rank: rank * 2 + (reporting.has(a.id) ? 0 : 1) });
    });
    return found
      .sort((x, y) => x.rank - y.rank || (x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0))
      .slice(0, limit)
      .map((x) => x.a);
  };
}
