/**
 * Reading the handbook's tables for one flight.
 *
 * Between the printed rows and columns the handbook leaves the reader to
 * choose. Its own worked example takes the nearest printed figure: 5,500 ft
 * and 16 °C above standard read as 6,000 ft and 20 °C above. This takes
 * every printed figure on either side of the flight and uses the highest
 * burn and the lowest speed among them, because what it feeds is a legal
 * reserve. Every number it uses is one the handbook prints, and none is
 * kinder than the table on either side. Outside the table it gives nothing
 * and says why, rather than carry a printed figure past where it was
 * measured.
 */
import type { Altimeter } from '../decode/groups/pressure.js';
import type { ClimbTable, CruiseTable, DistanceTable } from './types.js';

/** The standard atmosphere the handbook's columns are measured from: 15 °C at sea level, 2 °C colder a thousand feet. */
export const standardTempC = (pressureAltitudeFt: number): number => 15 - (2 * pressureAltitudeFt) / 1000;

/**
 * Pressure altitude by the rule a pilot uses: a thousand feet an inch of
 * mercury, thirty feet a hectopascal. Null setting, null answer: the
 * caller decides what to do without one.
 */
export function pressureAltitudeFt(altitudeFt: number, setting: Altimeter | null): number | null {
  if (!setting || setting.value === null) return null;
  return Math.round(setting.unit === 'inHg' ? altitudeFt + (29.92 - setting.value) * 1000 : altitudeFt + (1013.25 - setting.value) * 30);
}

/**
 * Degrees from standard, to the whole degree: the temperatures it is worked
 * from are whole degrees, so a tenth here would be precision nobody has.
 */
export const deviationC = (tempC: number, pressureAltitudeFt: number): number => Math.round(tempC - standardTempC(pressureAltitudeFt));

const ft = (n: number) => `${n.toLocaleString('en')} ft`;
const signed = (c: number) => (c === 0 ? 'standard' : `${Math.abs(c)} °C ${c > 0 ? 'above' : 'below'} standard`);

/** One printed cell, with what the scan made of it. */
export interface CruiseCellRef {
  readonly pressureAltitudeFt: number;
  readonly rpm: number;
  /** The column, in degrees from standard. */
  readonly columnC: number;
  readonly bhp: number;
  readonly ktas: number;
  readonly gph: number;
  /** Whether the scan's line for the row carries this cell's speed and burn. */
  readonly scanned: { readonly ktas: boolean; readonly gph: boolean };
}

export type CruiseReading =
  | {
      readonly gph: number;
      readonly ktas: number;
      /** The cell the burn was taken from, and the cell the speed was. */
      readonly burnCell: CruiseCellRef;
      readonly speedCell: CruiseCellRef;
      /** Every printed cell either side of the flight, which the two above were chosen among. */
      readonly around: readonly CruiseCellRef[];
    }
  | { readonly problem: string };

/** A column's name in a row's `unconfirmed` list: `-20`, `0`, `+20`. */
export const columnName = (c: number): string => (c > 0 ? `+${c}` : String(c));

/** The printed values either side of `x`: the one value when `x` is printed, none when it is outside them. */
function either(printed: readonly number[], x: number): number[] | null {
  const sorted = [...new Set(printed)].sort((a, b) => a - b);
  if (x < sorted[0]! || x > sorted[sorted.length - 1]!) return null;
  if (sorted.includes(x)) return [x];
  const above = sorted.find((v) => v > x)!;
  return [sorted[sorted.indexOf(above) - 1]!, above];
}

/**
 * The cruise table at one pressure altitude, temperature and power setting.
 * With no temperature, every column is read, since the burn could be any of
 * them.
 */
export function readCruise(table: CruiseTable, pressureAltitude: number, deviation: number | null, rpm: number): CruiseReading {
  const altitudes = table.rows.map((r) => r.pressureAltitudeFt);
  const rows = either(altitudes, pressureAltitude);
  const low = Math.min(...altitudes);
  const high = Math.max(...altitudes);
  if (!rows) {
    return { problem: `${ft(pressureAltitude)} pressure altitude is ${pressureAltitude < low ? 'below' : 'above'} the handbook's cruise table, which runs from ${ft(low)} to ${ft(high)}` };
  }
  const columns = deviation === null ? [...table.columnsC] : either(table.columnsC, deviation);
  if (!columns) {
    const edge = Math.max(...table.columnsC.map(Math.abs));
    return { problem: `the temperature at cruise is ${signed(deviation!)}, past the ${edge} °C either side of standard the handbook's cruise table covers` };
  }
  const around: CruiseCellRef[] = [];
  for (const altitude of rows) {
    const row = table.rows.find((r) => r.pressureAltitudeFt === altitude && r.rpm === rpm);
    if (!row) {
      const printed = table.rows.filter((r) => r.pressureAltitudeFt === altitude).map((r) => r.rpm);
      return { problem: `the handbook's cruise table does not print ${rpm} RPM at ${ft(altitude)}; it gives ${Math.min(...printed)} to ${Math.max(...printed)} there` };
    }
    for (const c of columns) {
      const k = table.columnsC.indexOf(c);
      const [bhp, ktas, gph] = row.cells[k]!;
      const missed = new Set(row.scan?.unconfirmed ?? []);
      const scanned = row.scan !== null;
      around.push({
        pressureAltitudeFt: altitude,
        rpm,
        columnC: c,
        bhp,
        ktas,
        gph,
        scanned: { ktas: scanned && !missed.has(`${columnName(c)}.ktas`), gph: scanned && !missed.has(`${columnName(c)}.gph`) },
      });
    }
  }
  const burnCell = around.reduce((a, b) => (b.gph > a.gph ? b : a));
  const speedCell = around.reduce((a, b) => (b.ktas < a.ktas ? b : a));
  return { gph: burnCell.gph, ktas: speedCell.ktas, burnCell, speedCell, around };
}

export type ClimbReading =
  | {
      /** The printed rows the climb was read between: the field's rounded down, the cruise's rounded up. */
      readonly fromRowFt: number;
      readonly toRowFt: number;
      /** Note 3's increase for a climb warmer than standard, in percent; 0 at or below standard. */
      readonly percent: number;
      readonly gal: number;
      readonly nm: number;
      readonly minutes: number;
    }
  | { readonly problem: string };

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Time, fuel and distance to climb from one pressure altitude to another,
 * the way the handbook's example does it: the difference of the two rows
 * from sea level, the field's row taken at or below it and the cruise's at
 * or above, then increased for a warm day. A field below sea level pressure
 * altitude climbs from the sea level row, which is the lowest printed.
 */
export function readClimb(table: ClimbTable, fromFt: number, toFt: number, deviation: number | null): ClimbReading {
  const rows = [...table.rows].sort((a, b) => a.pressureAltitudeFt - b.pressureAltitudeFt);
  const top = rows[rows.length - 1]!;
  if (toFt > top.pressureAltitudeFt) return { problem: `${ft(toFt)} pressure altitude is above the handbook's climb table, which ends at ${ft(top.pressureAltitudeFt)}` };
  const from = [...rows].reverse().find((r) => r.pressureAltitudeFt <= Math.max(fromFt, 0))!;
  const to = rows.find((r) => r.pressureAltitudeFt >= toFt)!;
  if (to.pressureAltitudeFt <= from.pressureAltitudeFt) return { fromRowFt: from.pressureAltitudeFt, toRowFt: from.pressureAltitudeFt, percent: 0, gal: 0, nm: 0, minutes: 0 };
  const percent = deviation === null ? 0 : (Math.max(0, deviation) / 10) * table.warmPercentPer10C.value;
  const factor = 1 + percent / 100;
  return {
    fromRowFt: from.pressureAltitudeFt,
    toRowFt: to.pressureAltitudeFt,
    percent: Math.round(percent),
    gal: round1((to.gal - from.gal) * factor),
    nm: Math.round((to.nm - from.nm) * factor),
    minutes: Math.round((to.minutes - from.minutes) * factor),
  };
}

/** One printed distance cell, with what the scan made of it. */
export interface DistanceCellRef {
  readonly pressureAltitudeFt: number;
  /** The column, in °C. */
  readonly columnC: number;
  readonly groundRollFt: number;
  readonly totalFt: number;
  /** Whether the scan's line for the row carries each figure. */
  readonly scanned: { readonly groundRoll: boolean; readonly total: boolean };
}

export interface RunwayConditions {
  readonly pressureAltitudeFt: number;
  readonly tempC: number;
  /** Along the runway, in knots: positive is a headwind, negative a tailwind. */
  readonly windKt: number;
  readonly surface: 'paved' | 'grass';
}

export type DistanceReading =
  | {
      /** The printed cell it was read at: the next row and column up. */
      readonly cell: DistanceCellRef;
      /** The wind note's correction in percent: below zero for a headwind, above for a tailwind. */
      readonly windPercent: number;
      /** Added for dry grass: the note's share of the printed ground roll. 0 on a paved runway. */
      readonly grassFt: number;
      readonly groundRollFt: number;
      readonly totalFt: number;
    }
  | { readonly problem: string };

/**
 * A takeoff or landing distance the way the handbook's sample problem works
 * it: "conservative distances can be established by reading the chart at
 * the next higher value of weight, altitude and temperature", then the
 * notes' corrections for wind and grass. Since every distance grows with
 * altitude and temperature, the next printed value up is also the longest
 * either side, the rule the fuel plan reads its table by.
 *
 * The notes say nothing about the order of wind and grass. A tailwind is
 * worked on the grass increase as well as the printed figure, and a
 * headwind on the printed figure alone, so neither order is kinder than
 * the other. Increases round up to the foot; a headwind's decrease rounds
 * as the handbook's example does, to the whole percent and then the foot.
 */
export function readDistance(table: DistanceTable, what: 'takeoff' | 'landing', c: RunwayConditions): DistanceReading {
  const rows = [...table.rows].sort((a, b) => a.pressureAltitudeFt - b.pressureAltitudeFt);
  const row = rows.find((r) => r.pressureAltitudeFt >= c.pressureAltitudeFt);
  if (!row) return { problem: `${ft(Math.round(c.pressureAltitudeFt))} pressure altitude is above the handbook's ${what} table, which ends at ${ft(rows[rows.length - 1]!.pressureAltitudeFt)}` };
  const k = table.columnsC.findIndex((col) => col >= c.tempC);
  if (k < 0) return { problem: `${c.tempC} °C is hotter than the handbook's ${what} table, which ends at ${table.columnsC[table.columnsC.length - 1]} °C` };
  const columnC = table.columnsC[k]!;
  const at = `${row.pressureAltitudeFt === 0 ? 'sea level' : ft(row.pressureAltitudeFt)} and ${columnC} °C`;
  const printed = row.cells[k];
  if (!printed) {
    const why = table.dashClimbBelowFpm ? `: climb after lift-off would be under ${table.dashClimbBelowFpm.value} fpm` : '';
    return { problem: `the handbook's ${what} table prints no distance at ${at}${why}` };
  }
  const tailMax = table.tailwindMaxKt.value;
  const tail = -c.windKt;
  // Whole knots, unless rounding would make it read as the limit itself.
  const said = Math.round(tail) > tailMax ? Math.round(tail) : Math.round(tail * 10) / 10;
  if (tail > tailMax) return { problem: `${said} kt of tailwind is more than the ${tailMax} kt the handbook's ${what} table allows for` };

  const missed = new Set(row.scan?.unconfirmed ?? []);
  const scanned = row.scan !== null;
  const cell: DistanceCellRef = {
    pressureAltitudeFt: row.pressureAltitudeFt,
    columnC,
    groundRollFt: printed[0],
    totalFt: printed[1],
    scanned: { groundRoll: scanned && !missed.has(`${columnC}.roll`), total: scanned && !missed.has(`${columnC}.total`) },
  };
  const grassFt = c.surface === 'grass' ? Math.ceil((printed[0] * table.grassPercentOfGroundRoll.value) / 100) : 0;
  const windPercent =
    c.windKt > 0
      ? -Math.round((c.windKt / table.headwindKtPer10Percent.value) * 10)
      : Math.max(0, Math.ceil((-c.windKt / table.tailwindKtPer10Percent.value) * 10 - 1e-9));
  const corrected = (x: number) =>
    windPercent < 0 ? x - Math.round((x * -windPercent) / 100) + grassFt : x + grassFt + Math.ceil(((x + grassFt) * windPercent) / 100 - 1e-9);
  return { cell, windPercent, grassFt, groundRollFt: corrected(printed[0]), totalFt: corrected(printed[1]) };
}
