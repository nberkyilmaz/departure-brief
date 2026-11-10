/**
 * The copied tables, held up against the scan.
 *
 * Run once, by `depbrief perf check`, against the owner's own scan; what it
 * finds is written into the aircraft's performance file, so the page and
 * the briefing can say which printed figures the scan bears out without
 * either of them needing the scan.
 */
import { checkNote, checkRows, type PrintedRow, type RowCheck } from '../docs/extract/table.js';
import type { DocumentOcr } from '../docs/types.js';
import { columnName } from './read.js';
import type { PerformanceSpec, RowScan } from './types.js';

const scanOf = (c: RowCheck): RowScan => ({ text: c.text, box: c.box, unconfirmed: c.unconfirmed });

export interface CheckSummary {
  readonly figures: number;
  readonly unconfirmed: readonly string[];
}

export function checkPerformance(doc: DocumentOcr, spec: PerformanceSpec): { spec: PerformanceSpec; cruise: CheckSummary; climb: CheckSummary } {
  const cruisePage = doc.pages[spec.cruise.page - 1];
  const climbPage = doc.pages[spec.climb.page - 1];
  if (!cruisePage || cruisePage.status !== 'read') throw new Error(`page ${spec.cruise.page} of ${doc.filename} has not been read`);
  if (!climbPage || climbPage.status !== 'read') throw new Error(`page ${spec.climb.page} of ${doc.filename} has not been read`);

  // The altitude is printed on the first row of each block only, and the climb's weight on its first row only.
  const cruiseRows: PrintedRow[] = spec.cruise.rows.map((r, i) => {
    const first = i === 0 || spec.cruise.rows[i - 1]!.pressureAltitudeFt !== r.pressureAltitudeFt;
    const values = [...(first ? [r.pressureAltitudeFt] : []), r.rpm, ...r.cells.flat()];
    const names = [...(first ? ['altitude'] : []), 'rpm', ...spec.cruise.columnsC.flatMap((c) => ['bhp', 'ktas', 'gph'].map((f) => `${columnName(c)}.${f}`))];
    return { values, names };
  });
  const climbRows: PrintedRow[] = spec.climb.rows.map((r, i) => {
    const values = [...(i === 0 ? [spec.climb.weightLb] : []), ...(r.pressureAltitudeFt > 0 ? [r.pressureAltitudeFt] : []), r.tempC, r.kias, r.fpm, r.minutes, r.gal, r.nm];
    const names = [...(i === 0 ? ['weight'] : []), ...(r.pressureAltitudeFt > 0 ? ['altitude'] : []), 'temp', 'kias', 'fpm', 'minutes', 'gal', 'nm'];
    return { values, names };
  });

  const cruise = checkRows(cruisePage, cruiseRows);
  const climb = checkRows(climbPage, climbRows);
  const allowance = checkNote(climbPage, spec.climb.allowanceGal.printed, spec.climb.allowanceGal.value, 'allowance');
  const warm = checkNote(climbPage, spec.climb.warmPercentPer10C.printed, spec.climb.warmPercentPer10C.value, 'percent');

  const checked: PerformanceSpec = {
    ...spec,
    cruise: { ...spec.cruise, rows: spec.cruise.rows.map((r, i) => ({ ...r, scan: scanOf(cruise[i]!) })) },
    climb: {
      ...spec.climb,
      allowanceGal: { ...spec.climb.allowanceGal, scan: scanOf(allowance) },
      warmPercentPer10C: { ...spec.climb.warmPercentPer10C, scan: scanOf(warm) },
      rows: spec.climb.rows.map((r, i) => ({ ...r, scan: scanOf(climb[i]!) })),
    },
  };
  const label = (rows: readonly { pressureAltitudeFt: number; rpm?: number }[], checks: readonly RowCheck[]) =>
    checks.flatMap((c, i) => c.unconfirmed.map((n) => `${rows[i]!.pressureAltitudeFt} ft${rows[i]!.rpm ? ` ${rows[i]!.rpm} RPM` : ''} ${n}`));
  return {
    spec: checked,
    cruise: { figures: cruiseRows.reduce((s, r) => s + r.values.length, 0), unconfirmed: label(spec.cruise.rows, cruise) },
    climb: {
      figures: climbRows.reduce((s, r) => s + r.values.length, 0) + 2,
      unconfirmed: [...label(spec.climb.rows, climb), ...allowance.unconfirmed.map((n) => `note 1 ${n}`), ...warm.unconfirmed.map((n) => `note 3 ${n}`)],
    },
  };
}

/** JSON on one line, spaced the way a person writes it. */
function oneLine(value: unknown): string {
  const raw = JSON.stringify(value);
  let out = '';
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    out += ch;
    if (inString) {
      if (ch === '\\') out += raw[++i] ?? '';
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === ',' || ch === ':') out += ' ';
  }
  return out;
}

/** The file as it is kept: one printed row to a line, so it can be read against the page. */
export function formatPerformance(spec: PerformanceSpec): string {
  const rows: string[] = [];
  const text = JSON.stringify(
    spec,
    (key, value: unknown) => {
      if (key !== 'rows' || !Array.isArray(value)) return value;
      return value.map((r) => {
        rows.push(oneLine(r));
        return `\u0000${rows.length - 1}`;
      });
    },
    2,
  );
  return `${text.replace(/"\\u0000(\d+)"/g, (_, i: string) => rows[Number(i)]!)}\n`;
}
