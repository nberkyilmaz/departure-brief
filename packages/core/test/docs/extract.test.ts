/**
 * How well a small local vision model reads a 1976 POH scan — measured,
 * not assumed.
 *
 * The gate that matters is **precision**: a figure the pipeline marks
 * verified must be the figure the page actually prints, because verified
 * figures go straight into a weight-and-balance computation. Recall is
 * reported but not gated: what the model misses lands in the review queue,
 * where it is the owner's to confirm, and missing a figure is safe in a way
 * that inventing one is not.
 *
 * Replays the answers recorded from qwen2.5vl:3b against the OCR of the
 * owner's own POH. Both are local and neither is committed, so the whole
 * file skips when they are absent, with a message rather than silently.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { alignWbExtraction, validateWbExtraction, type ExtractedField } from '../../src/docs/extract/wb.js';
import { isPending, readCachedDocument } from '../../src/docs/reader/ingest.js';
import { PAGE_ID_STRIDE, type DocumentOcr } from '../../src/docs/types.js';
import { transcribed } from '../helpers/wbspec.js';

const ROOT = join(__dirname, '..', '..', '..', '..');
const CACHE = process.env['DEPBRIEF_DOC_CACHE'] ?? join(ROOT, 'data', 'docs');
const POH_SHA = 'a87f58e0f28c7ad0ffb0512249d10e44ee23199f01e6c3f2f9f1b1d698bb4446';
const FIXTURES = join(__dirname, '..', 'fixtures', 'llm', 'qwen2.5vl_3b');

interface Recorded {
  request: { prompt: string };
  response: { json: unknown };
}

const doc: DocumentOcr | null = existsSync(join(CACHE, POH_SHA)) ? readCachedDocument(CACHE, POH_SHA) : null;
const recordings: Recorded[] = existsSync(FIXTURES)
  ? readdirSync(FIXTURES)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')) as Recorded)
  : [];
const ready = doc !== null && recordings.length > 0;

/** Which page a recorded call was about, from the prompt it was sent. */
function pageOf(r: Recorded): number | null {
  const m = /page (\d+) of \d+/.exec(r.request.prompt);
  return m ? Number(m[1]) : null;
}

const t = ready ? transcribed() : null;

/** The figure the POH really prints, for each field the extractor can report. */
function truthFor(name: string): number | { weightLb: number; armIn: number } | null {
  if (!t) return null;
  const l = t.limits;
  const s = t.stations;
  const point = (key: 'cgForwardNormal' | 'cgForwardUtility', i: number) => l[key][i] ?? null;
  const m = /^(cgForwardNormal|cgForwardUtility)\[(\d+)\]$/.exec(name);
  if (m) return point(m[1] as 'cgForwardNormal' | 'cgForwardUtility', Number(m[2]));
  const table: Record<string, number> = {
    maxTakeoffWeightNormalLb: l.maxTakeoffWeightNormalLb,
    maxTakeoffWeightUtilityLb: l.maxTakeoffWeightUtilityLb,
    maxLandingWeightLb: l.maxLandingWeightNormalLb,
    baggage1MaxLb: l.baggage1MaxLb,
    baggage2MaxLb: l.baggage2MaxLb,
    baggageCombinedMaxLb: l.baggageCombinedMaxLb,
    cgAftNormalIn: l.cgAftNormalIn,
    cgAftUtilityIn: l.cgAftUtilityIn,
    demonstratedCrosswindKt: l.demonstratedCrosswindKt,
    frontSeatArmIn: s.frontSeatArmIn,
    rearSeatArmIn: s.rearSeatArmIn,
    baggage1ArmIn: s.baggage1ArmIn,
    baggage2ArmIn: s.baggage2ArmIn,
    fuelArmIn: s.fuelArmIn,
    fuelStandardUsableGal: s.fuelStandardUsableGal,
    fuelLongRangeUsableGal: s.fuelLongRangeUsableGal,
    fuelLbPerGal: s.fuelLbPerGal,
    oilWeightLb: s.oilWeightLb,
    oilMomentPer1000: s.oilMomentPer1000,
    sampleEmptyWeightLb: t.sampleLoadingProblem.rows[0]!.weightLb,
    sampleEmptyMomentPer1000: t.sampleLoadingProblem.rows[0]!.momentPer1000,
  };
  return table[name] ?? null;
}

const same = (a: number, b: number) => Math.abs(a - b) < 0.051;

function fieldsFromRecordings(): ExtractedField[] {
  const out: ExtractedField[] = [];
  for (const r of recordings) {
    const page = pageOf(r);
    if (page === null) continue;
    const ex = validateWbExtraction(r.response.json);
    if (!ex) continue;
    out.push(...alignWbExtraction(doc!, page, ex));
  }
  return out;
}

describe.skipIf(!doc)('the read handbook', () => {
  it('gives every word an id that depends only on where it is, so a citation cannot drift', () => {
    /*
     * The bug this pins: ids used to come from a counter advanced in page
     * order, so reading page 90 alone and then page 88 alone handed both
     * pages ids starting at 1, and a figure quoted on one page was checked
     * against the other page's words.
     */
    const seen = new Map<number, number>();
    for (const p of doc!.pages) {
      for (const [i, w] of p.words.entries()) {
        expect(w.id).toBe(p.page * PAGE_ID_STRIDE + i);
        expect(w.page).toBe(p.page);
        expect(seen.has(w.id)).toBe(false);
        seen.set(w.id, p.page);
      }
      expect(p.words.length).toBeLessThan(PAGE_ID_STRIDE);
    }
    expect(seen.size).toBeGreaterThan(1000);
  });

  it('records how every page turned out, so a failure is retried rather than cached as blank', () => {
    for (const p of doc!.pages) {
      expect(['read', 'blank', 'failed', 'pending']).toContain(p.status);
      if (p.status === 'read') expect(p.words.length).toBeGreaterThan(0);
      if (p.status === 'blank') expect(p.words.length).toBe(0);
      expect(isPending(p)).toBe(p.status === 'failed' || p.status === 'pending');
    }
    // Every line's words belong to the page that lists them.
    for (const p of doc!.pages) for (const l of p.lines) expect(l.page).toBe(p.page);
  });
});

describe.skipIf(!ready)('POH weight-and-balance extraction — qwen2.5vl:3b on the owner 172M scan', () => {
  it('never marks a wrong figure verified', () => {
    const fields = fieldsFromRecordings();
    expect(fields.length).toBeGreaterThan(10);
    const verified = fields.filter((f) => f.verified);
    const wrong: string[] = [];
    const unchecked: string[] = [];
    for (const f of verified) {
      const truth = truthFor(f.name);
      if (truth === null) {
        unchecked.push(f.name);
        continue;
      }
      const ok =
        typeof truth === 'number' && typeof f.value === 'number'
          ? same(truth, f.value)
          : typeof truth === 'object' && typeof f.value === 'object'
            ? same(truth.weightLb, f.value.weightLb) && same(truth.armIn, f.value.armIn)
            : false;
      if (!ok) wrong.push(`${f.name} = ${JSON.stringify(f.value)} but the POH says ${JSON.stringify(truth)} (quoted "${f.context.slice(0, 70)}")`);
    }
    const checked = verified.length - unchecked.length;
    console.log(
      `extraction: ${fields.length} figures proposed, ${verified.length} verified (${checked} checkable against the transcription), ${fields.length - verified.length} sent to review`,
    );
    if (unchecked.length) console.log(`  no transcribed truth for: ${unchecked.join(', ')}`);
    expect(wrong).toEqual([]);
  });

  it('rejects the errors this model actually makes, and says why', () => {
    const fields = fieldsFromRecordings();
    const rejected = fields.filter((f) => !f.verified);
    expect(rejected.length).toBeGreaterThan(0);
    // Every rejection carries a reason a reviewer can act on.
    for (const f of rejected) expect(f.alignment.problem ?? f.labelProblem).toBeTruthy();

    // The two failure modes seen on this document, both caught:
    // quoting a line that is on a different page of the handbook,
    const offPage = rejected.filter((f) => (f.alignment.problem ?? '').includes('not on page'));
    expect(offPage.length).toBeGreaterThan(0);
    // and reading a utility-category limit as if it were the normal-category one.
    const wrongCategory = rejected.filter((f) => (f.labelProblem ?? '').includes('CATEGORY heading'));
    expect(wrongCategory.length).toBeGreaterThan(0);
    for (const f of wrongCategory) expect(f.name.startsWith('max')).toBe(true);
  });

  it('reports how much of the handbook it recovered, so the gap is visible', () => {
    const fields = fieldsFromRecordings();
    const verifiedNames = new Set(fields.filter((f) => f.verified).map((f) => f.name));
    const wanted = [
      'maxTakeoffWeightNormalLb',
      'maxLandingWeightLb',
      'maxTakeoffWeightUtilityLb',
      'baggage1MaxLb',
      'baggage2MaxLb',
      'cgAftNormalIn',
      'cgAftUtilityIn',
      'demonstratedCrosswindKt',
      'frontSeatArmIn',
      'rearSeatArmIn',
      'baggage1ArmIn',
      'baggage2ArmIn',
      'fuelArmIn',
      'fuelStandardUsableGal',
      'oilWeightLb',
      'cgForwardNormal[0]',
      'cgForwardNormal[1]',
    ];
    const got = wanted.filter((w) => verifiedNames.has(w));
    console.log(`  recovered ${got.length} of ${wanted.length} figures the loading computation needs: ${got.join(', ')}`);
    console.log(`  left for the owner to confirm: ${wanted.filter((w) => !verifiedNames.has(w)).join(', ')}`);
    // A floor, so a regression that recovers nothing is a failure rather than a quiet zero.
    expect(got.length).toBeGreaterThanOrEqual(4);
  });
});

if (!ready) {
  describe('POH weight-and-balance extraction', () => {
    it.skip(`skipped: needs the owner's POH OCR cache (${CACHE}/${POH_SHA.slice(0, 12)}…) and recorded model answers in ${FIXTURES}; neither is committed`, () => {});
  });
}
