import type { CgEnvelope, DocumentCitation, Loading, LoadingResult, LoadingRow, WbFinding, WeightBalanceSpec } from './types.js';

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The forward limit at a weight: linear between the stated points, flat beyond the ends. */
export function forwardLimitAt(env: CgEnvelope, weightLb: number): number {
  const pts = [...env.forward].sort((a, b) => a.weightLb - b.weightLb);
  if (pts.length === 0) return Number.NaN;
  if (weightLb <= pts[0]!.weightLb) return pts[0]!.armIn;
  const last = pts[pts.length - 1]!;
  if (weightLb >= last.weightLb) return last.armIn;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (weightLb <= b.weightLb) {
      const t = (weightLb - a.weightLb) / (b.weightLb - a.weightLb);
      return a.armIn + t * (b.armIn - a.armIn);
    }
  }
  return last.armIn;
}

export class IncompleteSpecError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`the weight-and-balance data is incomplete: ${missing.join('; ')}`);
    this.name = 'IncompleteSpecError';
  }
}

/**
 * Sum the loading, find the centre of gravity, and judge it against the
 * envelope for the chosen category. Every limit applied is cited back to
 * the POH page it came from. Pure.
 */
export function computeLoading(spec: WeightBalanceSpec, loading: Loading): LoadingResult {
  const env = spec.envelopes.find((e) => e.category === loading.category);
  const missing: string[] = [];
  if (!env) missing.push(`no ${loading.category} category envelope`);
  else if (env.forward.length === 0) missing.push(`${loading.category} category has no forward CG limit`);
  if (missing.length > 0 || !env) throw new IncompleteSpecError(missing);

  /*
   * The forward limit is a sloped line, and `forwardLimitAt` holds the last
   * stated point flat above it. That is right for a POH that says "35.0
   * inches at 1950 lbs. or less", and wrong — dangerously so — if the
   * heavier end of the line was never extracted: a loading at 2300 lb would
   * then be judged against the 35.0 in limit that applies at 1950 lb, and a
   * nose-heavy aeroplane would come back within limits. So refuse to judge
   * a weight the stated line does not reach.
   */
  const heaviestStated = Math.max(...env.forward.map((p) => p.weightLb));

  /*
   * Every load must land on a station this spec knows, or it would simply
   * not be counted: `computeLoading` walks the spec's stations and reads
   * the loading by id. A station whose arm failed extraction is absent from
   * the spec, so 340 lb of rear passengers typed against it would vanish
   * from the total and the aeroplane would come back lighter than it is.
   */
  const known = new Set(spec.stations.map((s) => s.id));
  const stray = [...Object.entries(loading.stations), ...Object.entries(loading.fuelGal)].filter(([id, v]) => v !== 0 && !known.has(id)).map(([id]) => id);
  if (stray.length > 0) {
    throw new IncompleteSpecError(
      stray.map((id) => `something is loaded at "${id}", which this weight-and-balance data has no station for${spec.review.some((r) => r.field.toLowerCase().includes(id)) ? ' (its arm is in the review queue)' : ''}`),
    );
  }
  const badNumber = [...Object.entries(loading.stations), ...Object.entries(loading.fuelGal), ['empty weight', loading.emptyWeightLb] as const, ['empty moment', loading.emptyMomentPer1000] as const].filter(
    ([, v]) => !Number.isFinite(v),
  );
  if (badNumber.length > 0) throw new IncompleteSpecError(badNumber.map(([id]) => `"${id}" is not a number`));
  if (!(loading.emptyWeightLb > 0)) throw new IncompleteSpecError(['the empty weight must be greater than zero']);

  const rows: LoadingRow[] = [
    { label: 'Empty weight (from the aircraft W&B record)', weightLb: loading.emptyWeightLb, armIn: round1((loading.emptyMomentPer1000 * 1000) / loading.emptyWeightLb), momentPer1000: loading.emptyMomentPer1000, source: null },
  ];
  const findings: WbFinding[] = [];
  let baggageLb = 0;
  for (const s of spec.stations) {
    let weightLb: number;
    if (s.kind === 'fuel') {
      const gal = loading.fuelGal[s.id] ?? 0;
      if (s.fuel && gal > s.fuel.usableGal.value + 1e-9) {
        findings.push({
          rule: 'wb.station',
          severity: 'no-go',
          summary: `${s.label}: ${gal} gal exceeds the usable ${s.fuel.usableGal.value} gal`,
          values: { gal, usableGal: s.fuel.usableGal.value },
          citations: [s.fuel.usableGal.source].filter((c): c is DocumentCitation => c !== null),
        });
      }
      weightLb = gal * (s.fuel?.lbPerGal.value ?? 6);
    } else if (s.kind === 'oil') {
      weightLb = s.fixedLb?.value ?? 0;
    } else {
      weightLb = loading.stations[s.id] ?? 0;
      if (s.kind === 'baggage') baggageLb += weightLb;
      if (s.maxLb && weightLb > s.maxLb.value + 1e-9) {
        findings.push({
          rule: 'wb.station',
          severity: 'no-go',
          summary: `${s.label}: ${weightLb} lb exceeds the ${s.maxLb.value} lb limit`,
          values: { weightLb, maxLb: s.maxLb.value },
          citations: [s.maxLb.source].filter((c): c is DocumentCitation => c !== null),
        });
      }
    }
    if (weightLb === 0 && s.kind !== 'oil') continue;
    // Rounded per row before summing, which is what the POH's own worked
    // example does; summing unrounded moments and rounding at the end
    // misses its printed total by a tenth.
    rows.push({ label: s.label, weightLb, armIn: s.armIn.value, momentPer1000: round1((weightLb * s.armIn.value) / 1000), source: s.armIn.source });
  }
  if (spec.baggageCombinedMaxLb && baggageLb > spec.baggageCombinedMaxLb.value + 1e-9) {
    findings.push({
      rule: 'wb.baggage',
      severity: 'no-go',
      summary: `baggage ${baggageLb} lb exceeds the combined ${spec.baggageCombinedMaxLb.value} lb limit`,
      values: { baggageLb, maxLb: spec.baggageCombinedMaxLb.value },
      citations: [spec.baggageCombinedMaxLb.source].filter((c): c is DocumentCitation => c !== null),
    });
  }

  const totalWeightLb = round1(rows.reduce((s, r) => s + r.weightLb, 0));
  const beyondStatedLine = totalWeightLb > heaviestStated + 1e-9;
  if (beyondStatedLine && totalWeightLb <= env.maxWeightLb.value + 1e-9) {
    throw new IncompleteSpecError([
      `the ${loading.category} category forward CG limit is only stated up to ${heaviestStated} lb, and this loading is ${totalWeightLb} lb — the rest of the limit line is missing, so the centre of gravity cannot be judged`,
    ]);
  }
  const totalMomentPer1000 = round1(rows.reduce((s, r) => s + r.momentPer1000, 0));
  const cgIn = round1((totalMomentPer1000 * 1000) / totalWeightLb);
  const forwardArmIn = round1(forwardLimitAt(env, totalWeightLb));
  const aftArmIn = env.aftArmIn.value;
  const maxWeightLb = env.maxWeightLb.value;
  const cite = (f: { source: DocumentCitation | null } | undefined) => (f?.source ? [f.source] : []);

  findings.push({
    rule: 'wb.weight',
    severity: totalWeightLb > maxWeightLb + 1e-9 ? 'no-go' : 'ok',
    summary:
      totalWeightLb > maxWeightLb
        ? `takeoff weight ${totalWeightLb} lb exceeds the ${loading.category} category maximum ${maxWeightLb} lb by ${round1(totalWeightLb - maxWeightLb)} lb`
        : `takeoff weight ${totalWeightLb} lb is within the ${loading.category} category maximum ${maxWeightLb} lb (${round1(maxWeightLb - totalWeightLb)} lb to spare)`,
    values: { totalWeightLb, maxWeightLb },
    citations: cite(env.maxWeightLb),
  });
  const fwdPoint = [...env.forward].sort((a, b) => a.weightLb - b.weightLb).find((p) => totalWeightLb <= p.weightLb) ?? env.forward[env.forward.length - 1];
  /*
   * Only reachable when the aeroplane is already over gross, since an
   * otherwise-legal weight beyond the stated line is refused above. Say so
   * rather than implying the forward limit was applied at this weight.
   */
  const beyondNote = beyondStatedLine ? ` (the forward limit is only stated up to ${heaviestStated} lb, so this is the limit there, not at ${totalWeightLb} lb)` : '';
  findings.push({
    rule: 'wb.cg.forward',
    severity: cgIn < forwardArmIn - 1e-9 ? 'no-go' : 'ok',
    summary:
      (cgIn < forwardArmIn
        ? `CG ${cgIn} in is forward of the ${forwardArmIn} in forward limit at ${totalWeightLb} lb`
        : `CG ${cgIn} in is aft of the ${forwardArmIn} in forward limit at ${totalWeightLb} lb`) + beyondNote,
    values: { cgIn, forwardArmIn, totalWeightLb },
    citations: cite(fwdPoint),
  });
  findings.push({
    rule: 'wb.cg.aft',
    severity: cgIn > aftArmIn + 1e-9 ? 'no-go' : 'ok',
    summary: cgIn > aftArmIn ? `CG ${cgIn} in is behind the ${aftArmIn} in aft limit` : `CG ${cgIn} in is ahead of the ${aftArmIn} in aft limit`,
    values: { cgIn, aftArmIn },
    citations: cite(env.aftArmIn),
  });

  return {
    rows,
    totalWeightLb,
    totalMomentPer1000,
    cgIn,
    category: loading.category,
    limits: { maxWeightLb, forwardArmIn, aftArmIn },
    findings,
    verdict: findings.some((f) => f.severity === 'no-go') ? 'outside-limits' : 'within-limits',
  };
}

export function loadingText(r: LoadingResult): string {
  const lines: string[] = [`Weight and balance — ${r.category} category`, ''];
  lines.push(`${'item'.padEnd(46)}${'lb'.padStart(8)}${'arm in'.padStart(9)}${'mom/1000'.padStart(10)}`);
  for (const row of r.rows) lines.push(`${row.label.padEnd(46)}${row.weightLb.toFixed(1).padStart(8)}${row.armIn.toFixed(1).padStart(9)}${row.momentPer1000.toFixed(1).padStart(10)}`);
  lines.push(`${'TOTAL'.padEnd(46)}${r.totalWeightLb.toFixed(1).padStart(8)}${r.cgIn.toFixed(1).padStart(9)}${r.totalMomentPer1000.toFixed(1).padStart(10)}`);
  lines.push('', `VERDICT: ${r.verdict === 'within-limits' ? 'WITHIN LIMITS' : 'OUTSIDE LIMITS'}`);
  for (const f of r.findings) {
    lines.push(`  ${f.severity.padEnd(6)} ${f.summary}`);
    for (const c of f.citations) lines.push(`         ← ${c.filename} p.${c.page}: "${c.citedText}"`);
  }
  lines.push('', 'Study aid only, not an official computation — verify against the aircraft W&B record and the POH.');
  return lines.join('\n');
}
