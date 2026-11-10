/**
 * Takeoff and landing distances from the handbook: the copied tables and
 * the rule for reading them.
 *
 * The yardstick is the 172M handbook's own sample problem on pages 5-4 to
 * 5-7: a takeoff from 1,500 ft pressure altitude at 28 °C into a 12 kt
 * headwind, read at 2,000 ft and 30 °C, and a landing at 2,000 ft and
 * 25 °C into 6 kt, read at 2,000 ft and 30 °C.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchedFigures, wordReadings } from '../../src/docs/extract/table.js';
import { readDistance, type RunwayConditions } from '../../src/perf/read.js';
import type { DistanceTable, PerformanceSpec } from '../../src/perf/types.js';

const ROOT = join(__dirname, '..', '..', '..', '..');
const spec = JSON.parse(readFileSync(join(ROOT, 'aircraft', 'c172.performance.json'), 'utf8')) as PerformanceSpec;
const tables = [
  ['takeoff', spec.takeoff],
  ['landing', spec.landing],
] as const;

const read = (table: DistanceTable, what: 'takeoff' | 'landing', c: Partial<RunwayConditions>) => {
  const r = readDistance(table, what, { pressureAltitudeFt: 0, tempC: 0, windKt: 0, surface: 'paved', ...c });
  if ('problem' in r) throw new Error(r.problem);
  return r;
};

describe('the copied tables', () => {
  it.each(tables)('%s: a row for every thousand feet from sea level to 8,000, a column every 10 °C from 0 to 40', (_, t) => {
    expect(t.weightLb).toBe(2300);
    expect(t.columnsC).toEqual([0, 10, 20, 30, 40]);
    expect(t.rows.map((r) => r.pressureAltitudeFt)).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000]);
    expect(t.rows.every((r) => r.cells.length === 5)).toBe(true);
  });

  it.each(tables)('%s: lengthens with every row up and every column across, so no figure sits in the wrong place', (_, t) => {
    for (const [i, r] of t.rows.entries()) {
      for (const [k, cell] of r.cells.entries()) {
        if (!cell) continue;
        expect(cell[1]).toBeGreaterThan(cell[0]);
        const left = r.cells[k - 1];
        if (left) for (const f of [0, 1]) expect(cell[f]).toBeGreaterThan(left[f]!);
        const below = t.rows[i - 1]?.cells[k];
        if (below) for (const f of [0, 1]) expect(cell[f]).toBeGreaterThan(below[f]!);
      }
    }
  });

  it('prints dashes only in the hot, high corner of the takeoff table, and none in the landing table', () => {
    const dashes = (t: DistanceTable) => t.rows.flatMap((r) => r.cells.flatMap((c, k) => (c ? [] : [`${r.pressureAltitudeFt}/${t.columnsC[k]}`])));
    expect(dashes(spec.takeoff)).toEqual(['6000/40', '7000/30', '7000/40', '8000/20', '8000/30', '8000/40']);
    expect(dashes(spec.landing)).toEqual([]);
    expect(spec.landing.dashClimbBelowFpm).toBeNull();
  });

  it('keeps the one figure that does not end in 0 or 5 as the ink has it', () => {
    // Landing, 6,000 ft and 30 °C: the page reads 1536 and so does the scan ("1636"). Elsewhere every figure is a multiple of five.
    const odd = tables.flatMap(([, t]) => t.rows.flatMap((r) => r.cells.flatMap((c) => (c ?? []).filter((x) => x % 5 !== 0))));
    expect(odd).toEqual([1536]);
  });
});

describe('what the scan bears out', () => {
  it.each(tables)('%s: agrees with the scan line recorded for each row, figure by figure', (_, t) => {
    t.rows.forEach((r, i) => {
      if (!r.scan || r.scan.text === '') return;
      const values: number[] = [];
      const names: string[] = [];
      if (i === 0) {
        values.push(t.weightLb, ...(t.liftOffKias === null ? [] : [t.liftOffKias]), t.at50FtKias);
        names.push('weight', ...(t.liftOffKias === null ? [] : ['liftOff']), 'at50Ft');
      }
      if (r.pressureAltitudeFt > 0) {
        values.push(r.pressureAltitudeFt);
        names.push('altitude');
      }
      r.cells.forEach((c, k) => {
        if (!c) return;
        values.push(...c);
        names.push(`${t.columnsC[k]}.roll`, `${t.columnsC[k]}.total`);
      });
      const found = new Set(matchedFigures(values, r.scan.text.split(' ').map(wordReadings)));
      expect(names.filter((_, k) => !found.has(k))).toEqual(r.scan.unconfirmed);
    });
  });

  it('names the landing row the scan lost, every figure in it', () => {
    // The scan reads 6,000 ft as "BOCG | 615 1498 840 1455 630 1480 686 1636 705 i570 OSE": two of its eleven, in order.
    const row = spec.landing.rows.find((r) => r.pressureAltitudeFt === 6000)!;
    expect(row.scan!.text).toBe('');
    expect(row.scan!.unconfirmed).toHaveLength(11);
  });

  it('finds the tailwind and grass notes, but not the headwind\'s 9 knots, which the scan reads as 2 and as 8', () => {
    for (const [, t] of tables) {
      expect(t.tailwindKtPer10Percent.scan!.unconfirmed).toEqual([]);
      expect(t.tailwindMaxKt.scan!.unconfirmed).toEqual([]);
      expect(t.grassPercentOfGroundRoll.scan!.unconfirmed).toEqual([]);
      expect(t.headwindKtPer10Percent.scan!.unconfirmed).toEqual(['headwindKtPer10Percent']);
    }
    expect(spec.takeoff.headwindKtPer10Percent.scan!.text).toContain('for gach 2 knots headwind');
    expect(spec.landing.headwindKtPer10Percent.scan!.text).toContain('for each 8 knots headwind');
    // And note 4's 150 fpm as 160.
    expect(spec.takeoff.dashClimbBelowFpm!.scan!.unconfirmed).toEqual(['dashClimbBelowFpm']);
  });
});

describe('reading a distance', () => {
  it('works the handbook\'s takeoff: 1,500 ft and 28 °C read at 2,000 ft and 30 °C, less 13% for 12 kt of headwind', () => {
    const r = read(spec.takeoff, 'takeoff', { pressureAltitudeFt: 1500, tempC: 28, windKt: 12 });
    expect([r.cell.pressureAltitudeFt, r.cell.columnC, r.cell.groundRollFt, r.cell.totalFt]).toEqual([2000, 30, 1155, 2030]);
    expect(r.windPercent).toBe(-13);
    // "Corrected ground roll 1005 Feet", "Corrected total distance to clear 50-foot obstacle 1766 Feet".
    expect([r.groundRollFt, r.totalFt]).toEqual([1005, 1766]);
  });

  it('works the handbook\'s landing: 2,000 ft and 25 °C read at 30 °C, less 7% for 6 kt of headwind', () => {
    const r = read(spec.landing, 'landing', { pressureAltitudeFt: 2000, tempC: 25, windKt: 6 });
    expect([r.cell.pressureAltitudeFt, r.cell.columnC, r.cell.groundRollFt, r.cell.totalFt]).toEqual([2000, 30, 590, 1370]);
    expect(r.windPercent).toBe(-7);
    expect([r.groundRollFt, r.totalFt]).toEqual([549, 1274]);
  });

  it('reads a printed altitude and temperature as themselves, and below sea level or freezing as the first row and column', () => {
    expect(read(spec.takeoff, 'takeoff', { pressureAltitudeFt: 3000, tempC: 20 }).cell).toMatchObject({ pressureAltitudeFt: 3000, columnC: 20, totalFt: 2085 });
    expect(read(spec.takeoff, 'takeoff', { pressureAltitudeFt: -400, tempC: -12 }).cell).toMatchObject({ pressureAltitudeFt: 0, columnC: 0, totalFt: 1380 });
  });

  it('adds 10% for every 2 kt of tailwind, rounding the percent and the feet up', () => {
    const r = read(spec.takeoff, 'takeoff', { windKt: -3 });
    expect(r.windPercent).toBe(15);
    expect([r.groundRollFt, r.totalFt]).toEqual([775 + 117, 1380 + 207]);
    expect(read(spec.takeoff, 'takeoff', { windKt: -2.2 }).windPercent).toBe(11);
    expect(read(spec.takeoff, 'takeoff', { windKt: -10 }).windPercent).toBe(50);
  });

  it('adds the grass note\'s share of the printed ground roll to both distances: 15% taking off, 45% landing', () => {
    const t = read(spec.takeoff, 'takeoff', { surface: 'grass' });
    expect([t.grassFt, t.groundRollFt, t.totalFt]).toEqual([117, 775 + 117, 1380 + 117]);
    const l = read(spec.landing, 'landing', { surface: 'grass' });
    expect([l.grassFt, l.groundRollFt, l.totalFt]).toEqual([223, 495 + 223, 1205 + 223]);
  });

  it('on grass, is never kinder than working the wind and the grass in either order', () => {
    for (const windKt of [-10, -7, -3, -1, 0, 4, 9, 13, 20]) {
      for (const [what, table] of tables) {
        const r = read(table, what, { pressureAltitudeFt: 2500, tempC: 14, windKt, surface: 'grass' });
        const f = 1 + r.windPercent / 100;
        const pct = table.grassPercentOfGroundRoll.value / 100;
        const roll = r.cell.groundRollFt;
        for (const [x, got] of [
          [r.cell.groundRollFt, r.groundRollFt],
          [r.cell.totalFt, r.totalFt],
        ] as const) {
          // Grass first and then the wind on the lot; or the wind first and the grass on the corrected roll.
          expect(got).toBeGreaterThanOrEqual(Math.floor((x + roll * pct) * f));
          expect(got).toBeGreaterThanOrEqual(Math.floor(x * f + roll * f * pct));
        }
      }
    }
  });

  it('gives no figure past the table, and says why', () => {
    const problem = (table: DistanceTable, what: 'takeoff' | 'landing', c: Partial<RunwayConditions>) => {
      const r = readDistance(table, what, { pressureAltitudeFt: 0, tempC: 0, windKt: 0, surface: 'paved', ...c });
      return 'problem' in r ? r.problem : null;
    };
    expect(problem(spec.takeoff, 'takeoff', { pressureAltitudeFt: 8200 })).toBe("8,200 ft pressure altitude is above the handbook's takeoff table, which ends at 8,000 ft");
    expect(problem(spec.landing, 'landing', { tempC: 41 })).toBe("41 °C is hotter than the handbook's landing table, which ends at 40 °C");
    expect(problem(spec.takeoff, 'takeoff', { pressureAltitudeFt: 6500, tempC: 22 })).toBe(
      "the handbook's takeoff table prints no distance at 7,000 ft and 30 °C: climb after lift-off would be under 150 fpm",
    );
    expect(problem(spec.landing, 'landing', { windKt: -11 })).toBe("11 kt of tailwind is more than the 10 kt the handbook's landing table allows for");
  });

  it('says whether the scan carries the figures it read', () => {
    // Takeoff at sea level and 0 °C: the scan has "778" for 775 and "1380" right.
    expect(read(spec.takeoff, 'takeoff', {}).cell.scanned).toEqual({ groundRoll: false, total: true });
    expect(read(spec.landing, 'landing', { pressureAltitudeFt: 5500 }).cell.scanned).toEqual({ groundRoll: false, total: false });
  });
});
