/**
 * The 172M weight-and-balance data as a `WeightBalanceSpec`, built from the
 * hand-transcribed POH fixture through the same assembler the CLI uses.
 * Sources are null: these figures were typed from the page images, not
 * extracted, and the extraction is checked against them rather than the
 * other way round.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleWeightBalance, type NamedFigure } from '../../src/wb/assemble.js';
import type { WeightBalanceSpec } from '../../src/wb/types.js';

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

const NOTE = 'transcribed by hand from the POH page image';

export function transcribedFigures(): NamedFigure[] {
  const t = transcribed();
  const l = t.limits;
  const s = t.stations;
  const sample = t.sampleLoadingProblem.rows[0]!;
  const num = (name: string, value: number): NamedFigure => ({ name, value, source: null, note: NOTE });
  const figures: NamedFigure[] = [
    num('maxTakeoffWeightNormalLb', l.maxTakeoffWeightNormalLb),
    num('maxTakeoffWeightUtilityLb', l.maxTakeoffWeightUtilityLb),
    num('maxLandingWeightLb', l.maxLandingWeightNormalLb),
    num('baggage1MaxLb', l.baggage1MaxLb),
    num('baggage2MaxLb', l.baggage2MaxLb),
    num('baggageCombinedMaxLb', l.baggageCombinedMaxLb),
    num('cgAftNormalIn', l.cgAftNormalIn),
    num('cgAftUtilityIn', l.cgAftUtilityIn),
    num('demonstratedCrosswindKt', l.demonstratedCrosswindKt),
    num('frontSeatArmIn', s.frontSeatArmIn),
    num('rearSeatArmIn', s.rearSeatArmIn),
    num('baggage1ArmIn', s.baggage1ArmIn),
    num('baggage2ArmIn', s.baggage2ArmIn),
    num('fuelArmIn', s.fuelArmIn),
    num('fuelStandardUsableGal', s.fuelStandardUsableGal),
    num('fuelLongRangeUsableGal', s.fuelLongRangeUsableGal),
    num('fuelLbPerGal', s.fuelLbPerGal),
    num('oilWeightLb', s.oilWeightLb),
    num('oilMomentPer1000', s.oilMomentPer1000),
    num('sampleEmptyWeightLb', sample.weightLb),
    num('sampleEmptyMomentPer1000', sample.momentPer1000),
  ];
  l.cgForwardNormal.forEach((p, i) => figures.push({ name: `cgForwardNormal[${i}]`, value: p, source: null, note: NOTE }));
  l.cgForwardUtility.forEach((p, i) => figures.push({ name: `cgForwardUtility[${i}]`, value: p, source: null, note: NOTE }));
  return figures;
}

export function transcribedSpec(): WeightBalanceSpec {
  return assembleWeightBalance('C172', null, transcribedFigures(), []);
}
