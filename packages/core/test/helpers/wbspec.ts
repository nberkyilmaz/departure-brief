/**
 * The 172M weight-and-balance data as a `WeightBalanceSpec`, built from the
 * hand-transcribed POH fixture. Sources are null: these figures were typed
 * from the page images, not extracted; the extraction is checked against
 * them, not the other way round.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Figure, WeightBalanceSpec } from '../../src/wb/types.js';

export interface Transcribed {
  limits: {
    maxTakeoffWeightNormalLb: number;
    maxLandingWeightNormalLb: number;
    maxTakeoffWeightUtilityLb: number;
    baggage1MaxLb: number;
    baggage2MaxLb: number;
    baggageCombinedMaxLb: number;
    cgForwardNormal: { weightLb: number; armIn: number }[];
    cgAftNormalIn: number;
    cgForwardUtility: { weightLb: number; armIn: number }[];
    cgAftUtilityIn: number;
    demonstratedCrosswindKt: number;
  };
  stations: {
    frontSeatArmIn: number;
    rearSeatArmIn: number;
    baggage1ArmIn: number;
    baggage2ArmIn: number;
    fuelArmIn: number;
    fuelStandardUsableGal: number;
    fuelLongRangeUsableGal: number;
    fuelLbPerGal: number;
    oilWeightLb: number;
    oilMomentPer1000: number;
  };
  sampleLoadingProblem: { rows: { item: string; weightLb: number; momentPer1000: number }[]; totalWeightLb: number; totalMomentPer1000: number };
}

export const TRANSCRIBED_PATH = join(__dirname, '..', 'fixtures', 'docs', 'c172m-poh-transcribed.json');

export function transcribed(): Transcribed {
  return JSON.parse(readFileSync(TRANSCRIBED_PATH, 'utf8')) as Transcribed;
}

const fig = (value: number, note = 'transcribed by hand from the POH page image'): Figure => ({ value, source: null, note });

export function transcribedSpec(): WeightBalanceSpec {
  const t = transcribed();
  const s = t.stations;
  const l = t.limits;
  const sample = t.sampleLoadingProblem.rows[0]!;
  return {
    version: 1,
    aircraftType: 'C172',
    source: null,
    stations: [
      { id: 'front', label: 'Pilot and front passenger', kind: 'seat', armIn: fig(s.frontSeatArmIn), maxLb: null, fuel: null, fixedLb: null },
      { id: 'rear', label: 'Rear passengers', kind: 'seat', armIn: fig(s.rearSeatArmIn), maxLb: null, fuel: null, fixedLb: null },
      { id: 'bag1', label: 'Baggage area 1', kind: 'baggage', armIn: fig(s.baggage1ArmIn), maxLb: fig(l.baggage1MaxLb), fuel: null, fixedLb: null },
      { id: 'bag2', label: 'Baggage area 2', kind: 'baggage', armIn: fig(s.baggage2ArmIn), maxLb: fig(l.baggage2MaxLb), fuel: null, fixedLb: null },
      { id: 'fuel', label: 'Fuel (standard tanks)', kind: 'fuel', armIn: fig(s.fuelArmIn), maxLb: null, fuel: { usableGal: fig(s.fuelStandardUsableGal), lbPerGal: fig(s.fuelLbPerGal) }, fixedLb: null },
      // The POH gives the oil as 15 lb at -0.2 moment/1000, i.e. an arm of about -13.3 in.
      { id: 'oil', label: 'Oil (8 qts)', kind: 'oil', armIn: fig(Math.round(((s.oilMomentPer1000 * 1000) / s.oilWeightLb) * 10) / 10, 'arm derived from the printed 15 lb at -0.2 moment/1000'), maxLb: null, fuel: null, fixedLb: fig(s.oilWeightLb) },
    ],
    envelopes: [
      { category: 'normal', maxWeightLb: fig(l.maxTakeoffWeightNormalLb), forward: l.cgForwardNormal.map((p) => ({ ...p, source: null })), aftArmIn: fig(l.cgAftNormalIn) },
      { category: 'utility', maxWeightLb: fig(l.maxTakeoffWeightUtilityLb), forward: l.cgForwardUtility.map((p) => ({ ...p, source: null })), aftArmIn: fig(l.cgAftUtilityIn) },
    ],
    maxLandingWeightLb: fig(l.maxLandingWeightNormalLb),
    maxRampWeightLb: null,
    baggageCombinedMaxLb: fig(l.baggageCombinedMaxLb),
    demonstratedCrosswindKt: fig(l.demonstratedCrosswindKt),
    sample: { emptyWeightLb: fig(sample.weightLb), emptyMomentPer1000: fig(sample.momentPer1000), totalWeightLb: fig(t.sampleLoadingProblem.totalWeightLb), totalMomentPer1000: fig(t.sampleLoadingProblem.totalMomentPer1000) },
    review: [],
  };
}
