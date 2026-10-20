import type { RawReport } from '../store/types.js';
import { decodeNotam } from './decode.js';
import type { DecodedNotam } from './types.js';

export interface DedupedNotam {
  readonly report: RawReport;
  readonly decoded: DecodedNotam;
  /** The other raw reports (same NOTAM id or identical text) folded into this one. */
  readonly duplicates: readonly RawReport[];
  /** Set when another NOTAM in the set replaces or cancels this one. */
  readonly supersededBy: string | null;
}

/**
 * Fold repeats of the same NOTAM — the FIR-wide ones arrive once per site
 * — and mark anything that a later `NOTAMR`/`NOTAMC` in the same set
 * supersedes. Nothing is removed: superseded NOTAMs stay, flagged.
 */
export function dedupeNotams(reports: readonly RawReport[]): DedupedNotam[] {
  const byKey = new Map<string, { report: RawReport; decoded: DecodedNotam; duplicates: RawReport[] }>();
  for (const report of reports) {
    const decoded = decodeNotam(report.body);
    const key = decoded.id?.value.text ?? report.sha256;
    const cur = byKey.get(key);
    if (cur) {
      if (cur.report.sha256 !== report.sha256) cur.duplicates.push(report);
    } else {
      byKey.set(key, { report, decoded, duplicates: [] });
    }
  }
  const supersededBy = new Map<string, string>();
  for (const { decoded } of byKey.values()) {
    if (decoded.refers && decoded.id && byKey.has(decoded.refers.value.text)) {
      supersededBy.set(decoded.refers.value.text, decoded.id.value.text);
    }
  }
  return [...byKey.entries()].map(([key, v]) => ({ ...v, supersededBy: supersededBy.get(key) ?? null }));
}
