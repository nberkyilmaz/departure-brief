/**
 * Performance tables out of a POH: what the aeroplane burns at a power
 * setting, what the climb to it takes, and the runway it needs at each end.
 *
 * Copied by hand from the page images, because a 1976 scan's OCR reads
 * these tables too poorly to lift numbers from: on the 172M's cruise page
 * it took 8.8 for 8.5 and lost the decimal point from a dozen others. Each
 * row then keeps the scan's own line for it, and names every printed
 * figure that line does not bear out, so a figure nothing corroborates is
 * still used but says so, the way a weight-and-balance figure entered by
 * hand does.
 */

/** Where a row sits on the scanned page, as the scan's OCR read it. */
export interface RowScan {
  /** The scan's line for this row, mistakes and all. */
  readonly text: string;
  /** In page pixels of the rendered page image. */
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | null;
  /**
   * Printed figures the scan's line does not carry, by name (`rpm`,
   * `+20.gph`): read from the page image alone, so check them against the
   * handbook.
   */
  readonly unconfirmed: readonly string[];
}

/** A figure printed in a note rather than a table, quoted. */
export interface NoteFigure {
  readonly value: number;
  /** The note as printed. */
  readonly printed: string;
  readonly scan: RowScan | null;
}

/** `[percent BHP, KTAS, GPH]`, in the order the handbook prints them. */
export type CruiseCell = readonly [bhp: number, ktas: number, gph: number];

export interface CruiseRow {
  readonly pressureAltitudeFt: number;
  readonly rpm: number;
  /** One per column of `CruiseTable.columnsC`, coldest first. */
  readonly cells: readonly CruiseCell[];
  readonly scan: RowScan | null;
}

export interface CruiseTable {
  readonly figure: string;
  /** The PDF's page, which is what a citation names. */
  readonly page: number;
  /** The page number printed on it. */
  readonly printedPage: string;
  readonly conditions: readonly string[];
  /** Each column's temperature, in degrees from standard. */
  readonly columnsC: readonly number[];
  readonly rows: readonly CruiseRow[];
}

export interface ClimbRow {
  /** 0 for the row printed "S.L.". */
  readonly pressureAltitudeFt: number;
  readonly tempC: number;
  readonly kias: number;
  readonly fpm: number;
  /** From sea level. */
  readonly minutes: number;
  readonly gal: number;
  readonly nm: number;
  readonly scan: RowScan | null;
}

export interface ClimbTable {
  readonly figure: string;
  readonly page: number;
  readonly printedPage: string;
  readonly conditions: readonly string[];
  readonly weightLb: number;
  /** Note 1: added once, for engine start, taxi and takeoff. */
  readonly allowanceGal: NoteFigure;
  /** Note 3: time, fuel and distance go up by this many percent for every 10 °C above standard. */
  readonly warmPercentPer10C: NoteFigure;
  readonly rows: readonly ClimbRow[];
}

/** `[ground roll, total to clear a 50 ft obstacle]` in feet; null where the handbook prints a dash. */
export type DistanceCell = readonly [groundRollFt: number, totalFt: number] | null;

export interface DistanceRow {
  /** 0 for the row printed "S.L.". */
  readonly pressureAltitudeFt: number;
  /** One per column of `DistanceTable.columnsC`, coldest first. */
  readonly cells: readonly DistanceCell[];
  readonly scan: RowScan | null;
}

/** A takeoff or landing distance table, at one weight. */
export interface DistanceTable {
  readonly figure: string;
  readonly page: number;
  readonly printedPage: string;
  readonly conditions: readonly string[];
  readonly weightLb: number;
  /** Takeoff only: the speed the table lifts off at. */
  readonly liftOffKias: number | null;
  readonly at50FtKias: number;
  /** Each column's temperature, in °C as read on the field's thermometer, not from standard. */
  readonly columnsC: readonly number[];
  /** Distances come down 10% for each this many knots of headwind. */
  readonly headwindKtPer10Percent: NoteFigure;
  /** And go up 10% for each this many knots of tailwind... */
  readonly tailwindKtPer10Percent: NoteFigure;
  /** ...up to this many knots of it, past which the handbook says nothing. */
  readonly tailwindMaxKt: NoteFigure;
  /** On dry grass, both distances go up by this percent of the ground roll. */
  readonly grassPercentOfGroundRoll: NoteFigure;
  /** Takeoff only: why a figure is a dash. Climb after lift-off would be under this many feet a minute. */
  readonly dashClimbBelowFpm: NoteFigure | null;
  readonly rows: readonly DistanceRow[];
}

export interface PerformanceSpec {
  readonly version: 1;
  /** The type it applies to, as the aircraft settings name it. */
  readonly aircraftType: string;
  /** The model and year the handbook is for, which the type alone does not say. */
  readonly model: string;
  readonly source: { readonly documentSha256: string; readonly filename: string };
  readonly cruise: CruiseTable;
  readonly climb: ClimbTable;
  readonly takeoff: DistanceTable;
  readonly landing: DistanceTable;
}
