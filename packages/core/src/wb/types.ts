/**
 * Weight and balance: the aircraft's loading data as the POH states it,
 * every figure traceable to the page it came from, and a loading computed
 * against it.
 */

export interface DocumentCitation {
  readonly documentSha256: string;
  readonly filename: string;
  readonly page: number;
  /** In page pixels of the rendered page image. */
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | null;
  readonly citedText: string;
}

/** A figure and where the POH says it. `source` is null for a figure the owner typed in. */
export interface Figure {
  readonly value: number;
  readonly source: DocumentCitation | null;
  readonly note: string | null;
}

export type StationKind = 'seat' | 'baggage' | 'fuel' | 'oil';

export interface Station {
  readonly id: string;
  readonly label: string;
  readonly kind: StationKind;
  readonly armIn: Figure;
  readonly maxLb: Figure | null;
  /** Fuel stations: usable capacity and weight per gallon. */
  readonly fuel: { readonly usableGal: Figure; readonly lbPerGal: Figure } | null;
  /** Oil: a fixed weight carried on every flight. */
  readonly fixedLb: Figure | null;
}

/** Forward limit as a piecewise-linear line in (weight, arm); aft limit constant. */
export interface CgEnvelope {
  readonly category: 'normal' | 'utility';
  readonly maxWeightLb: Figure;
  readonly forward: readonly { readonly weightLb: number; readonly armIn: number; readonly source: DocumentCitation | null }[];
  readonly aftArmIn: Figure;
}

export interface WeightBalanceSpec {
  readonly version: 1;
  readonly aircraftType: string;
  readonly source: { readonly documentSha256: string; readonly filename: string; readonly pages: readonly number[] } | null;
  /**
   * Every figure that survived checking, flat and named, whether a model
   * read it or the owner confirmed it. The stations and envelopes below are
   * assembled from these; keeping them means a later extraction run adds to
   * the owner's confirmations instead of flattening them.
   */
  readonly figures: readonly {
    readonly name: string;
    readonly value: number | { readonly weightLb: number; readonly armIn: number };
    readonly source: DocumentCitation | null;
    readonly note: string | null;
  }[];
  readonly stations: readonly Station[];
  readonly envelopes: readonly CgEnvelope[];
  readonly maxLandingWeightLb: Figure | null;
  readonly maxRampWeightLb: Figure | null;
  /** Combined baggage limit across areas, when the POH states one. */
  readonly baggageCombinedMaxLb: Figure | null;
  readonly demonstratedCrosswindKt: Figure | null;
  /**
   * The POH's own worked example, kept so the computation can be checked
   * against it; never an aircraft's real empty weight.
   */
  readonly sample: { readonly emptyWeightLb: Figure; readonly emptyMomentPer1000: Figure; readonly totalWeightLb: Figure | null; readonly totalMomentPer1000: Figure | null } | null;
  /** Figures the model proposed that the page did not back; for the owner to check, never used. */
  readonly review: readonly ReviewItem[];
}

export interface ReviewItem {
  readonly field: string;
  readonly description: string;
  readonly proposed: number | { readonly weightLb: number; readonly armIn: number };
  readonly page: number;
  readonly citedText: string;
  readonly box: DocumentCitation['box'];
  readonly problem: string;
}

/** What is on board for one flight. Empty weight and moment come from the aircraft's own W&B record. */
export interface Loading {
  readonly emptyWeightLb: number;
  readonly emptyMomentPer1000: number;
  /** Weight at each station by id; fuel stations take gallons. */
  readonly stations: Readonly<Record<string, number>>;
  readonly fuelGal: Readonly<Record<string, number>>;
  readonly category: 'normal' | 'utility';
}

export interface LoadingRow {
  readonly label: string;
  readonly weightLb: number;
  readonly armIn: number;
  readonly momentPer1000: number;
  readonly source: DocumentCitation | null;
}

export interface LoadingResult {
  readonly rows: readonly LoadingRow[];
  readonly totalWeightLb: number;
  readonly totalMomentPer1000: number;
  readonly cgIn: number;
  readonly category: 'normal' | 'utility';
  readonly limits: {
    readonly maxWeightLb: number;
    readonly forwardArmIn: number;
    readonly aftArmIn: number;
  };
  readonly findings: readonly WbFinding[];
  readonly verdict: 'within-limits' | 'outside-limits';
}

export interface WbFinding {
  readonly rule: 'wb.weight' | 'wb.cg.forward' | 'wb.cg.aft' | 'wb.station' | 'wb.baggage';
  readonly severity: 'ok' | 'no-go';
  readonly summary: string;
  readonly values: Readonly<Record<string, number>>;
  readonly citations: readonly DocumentCitation[];
}
