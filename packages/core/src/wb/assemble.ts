/**
 * Building a `WeightBalanceSpec` from figures, whoever proposed them.
 *
 * A figure reaches the spec one of two ways: a model read it off the page
 * and the page backed it, or the owner read the page and confirmed it.
 * Both arrive here as the same thing — a value with the ink it came from —
 * and the same assembly turns them into stations and envelopes. Keeping
 * the flat figures in the file alongside the assembled view is what lets a
 * later extraction run add to the owner's confirmations instead of
 * flattening them.
 */
import type { CgEnvelope, DocumentCitation, Figure, ReviewItem, Station, WeightBalanceSpec } from './types.js';

/** A figure's name: a `WB_FIELDS` key, or `cgForwardNormal[0]`-style for a limit point. */
export type FigureName = string;

/** A figure and, for a CG limit point, the weight it belongs to. */
export interface NamedFigure {
  readonly name: FigureName;
  readonly value: number | { readonly weightLb: number; readonly armIn: number };
  readonly source: DocumentCitation | null;
  readonly note: string | null;
}

const CG_POINT = /^(cgForwardNormal|cgForwardUtility)\[(\d+)\]$/;

export function isCgPointName(name: string): boolean {
  return CG_POINT.test(name);
}

/**
 * Assemble the spec. Figures are taken in order, so a later one — the
 * owner's confirmation — replaces an earlier one of the same name.
 */
export function assembleWeightBalance(
  aircraftType: string,
  source: WeightBalanceSpec['source'],
  figures: readonly NamedFigure[],
  review: readonly ReviewItem[],
): WeightBalanceSpec {
  const byName = new Map<FigureName, NamedFigure>();
  for (const f of figures) byName.set(f.name, f);

  const num = (name: FigureName): Figure | null => {
    const f = byName.get(name);
    return f && typeof f.value === 'number' ? { value: f.value, source: f.source, note: f.note } : null;
  };
  const points = (prefix: string) =>
    [...byName.values()]
      .filter((f) => f.name.startsWith(`${prefix}[`) && typeof f.value === 'object')
      .map((f) => ({ ...(f.value as { weightLb: number; armIn: number }), source: f.source }))
      .sort((a, b) => a.weightLb - b.weightLb);

  const station = (id: string, label: string, kind: Station['kind'], arm: FigureName, max: FigureName | null, extra: Partial<Station> = {}): Station | null => {
    const armIn = num(arm);
    if (!armIn) return null;
    return { id, label, kind, armIn, maxLb: max ? num(max) : null, fuel: null, fixedLb: null, ...extra };
  };

  const lbPerGal = num('fuelLbPerGal') ?? { value: 6, source: null, note: 'assumed 6 lb per US gallon; the handbook figure was not read' };
  const usable = num('fuelStandardUsableGal');
  const oilLb = num('oilWeightLb');
  const oilArm =
    num('oilArmIn') ??
    // The 172M prints the oil as a weight and a moment, not an arm.
    (() => {
      const moment = num('oilMomentPer1000');
      if (!moment || !oilLb || oilLb.value === 0) return null;
      return { value: Math.round(((moment.value * 1000) / oilLb.value) * 10) / 10, source: moment.source, note: `arm derived from the printed ${oilLb.value} lb at ${moment.value} moment/1000` };
    })();

  const stations = [
    station('front', 'Pilot and front passenger', 'seat', 'frontSeatArmIn', null),
    station('rear', 'Rear passengers', 'seat', 'rearSeatArmIn', null),
    station('bag1', 'Baggage area 1', 'baggage', 'baggage1ArmIn', 'baggage1MaxLb'),
    station('bag2', 'Baggage area 2', 'baggage', 'baggage2ArmIn', 'baggage2MaxLb'),
    usable ? station('fuel', 'Fuel (standard tanks)', 'fuel', 'fuelArmIn', null, { fuel: { usableGal: usable, lbPerGal } }) : null,
    oilArm && oilLb ? { id: 'oil', label: 'Oil', kind: 'oil' as const, armIn: oilArm, maxLb: null, fuel: null, fixedLb: oilLb } : null,
  ].filter((s): s is Station => s !== null);

  const envelope = (category: CgEnvelope['category'], maxName: FigureName, aftName: FigureName, fwd: string): CgEnvelope | null => {
    const maxWeightLb = num(maxName);
    const aftArmIn = num(aftName);
    const forward = points(fwd);
    return maxWeightLb && aftArmIn && forward.length > 0 ? { category, maxWeightLb, forward, aftArmIn } : null;
  };
  const envelopes = [
    envelope('normal', 'maxTakeoffWeightNormalLb', 'cgAftNormalIn', 'cgForwardNormal'),
    envelope('utility', 'maxTakeoffWeightUtilityLb', 'cgAftUtilityIn', 'cgForwardUtility'),
  ].filter((e): e is CgEnvelope => e !== null);

  const sampleW = num('sampleEmptyWeightLb');
  const sampleM = num('sampleEmptyMomentPer1000');
  return {
    version: 1,
    aircraftType,
    source,
    figures: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    stations,
    envelopes,
    maxLandingWeightLb: num('maxLandingWeightLb'),
    maxRampWeightLb: num('maxRampWeightLb'),
    baggageCombinedMaxLb: num('baggageCombinedMaxLb'),
    demonstratedCrosswindKt: num('demonstratedCrosswindKt'),
    sample: sampleW && sampleM ? { emptyWeightLb: sampleW, emptyMomentPer1000: sampleM, totalWeightLb: null, totalMomentPer1000: null } : null,
    review: [...review],
  };
}

/** What the loading computation still lacks, in the owner's words. */
export function missingFrom(spec: WeightBalanceSpec): string[] {
  const out: string[] = [];
  const has = (n: string) => spec.figures.some((f) => f.name === n);
  if (!spec.envelopes.some((e) => e.category === 'normal')) {
    const want = (['maxTakeoffWeightNormalLb', 'cgAftNormalIn'] as const).filter((n) => !has(n));
    const fwd = spec.figures.filter((f) => f.name.startsWith('cgForwardNormal[')).length;
    out.push(`no normal category envelope — still needs ${[...want, ...(fwd === 0 ? ['cgForwardNormal[0] and cgForwardNormal[1]'] : [])].join(', ') || 'both points of cgForwardNormal'}`);
  } else {
    const normal = spec.envelopes.find((e) => e.category === 'normal')!;
    const top = Math.max(...normal.forward.map((p) => p.weightLb));
    if (top < normal.maxWeightLb.value) out.push(`the normal forward CG limit only reaches ${top} lb of the ${normal.maxWeightLb.value} lb maximum — the heavy end of the line is missing`);
  }
  for (const [id, arm] of [
    ['front', 'frontSeatArmIn'],
    ['rear', 'rearSeatArmIn'],
    ['fuel', 'fuelArmIn'],
  ] as const) {
    if (!spec.stations.some((s) => s.id === id)) out.push(`no "${id}" station — needs ${arm}${id === 'fuel' ? ' and fuelStandardUsableGal' : ''}`);
  }
  return out;
}
