/**
 * Weight-and-balance data out of a POH.
 *
 * The model is shown one page — its OCR lines, and the page image when it
 * can see — and returns each figure together with the line it read it
 * from, quoted. Nothing is believed until that quote is found among the
 * page's words, the figure is found inside the quote, and the quote's line
 * carries the words that name the field. A figure that fails any of those
 * is still reported, as a review item with its region of the page, and is
 * never used in a computation.
 *
 * Quotes rather than token ids: the first version asked for the ids of the
 * words a figure came from, and a 3B vision model cited "4 provides
 * checklist and amplified procedures" for the demonstrated crosswind. The
 * verification is no weaker for quoting — a quote that is not on the page
 * is not found, exactly as a wrong id is not backed — and quoting is
 * something a small model can actually do.
 */
import { contentHash } from '../../brief/canonical.js';
import type { JsonSchema, LLMRequest } from '../../llm/provider.js';
import { alignNumbers, locateText, type Alignment } from '../align.js';
import type { DocumentOcr, PageOcr } from '../types.js';

/** Bump when the prompt or the schema changes meaning. */
export const WB_PROMPT_VERSION = 2;

/** A figure the model read, with the line it read it from, quoted verbatim. */
export interface CitedNumber {
  readonly value: number;
  readonly quote: string;
}
export interface CitedPoint {
  readonly weightLb: number;
  readonly armIn: number;
  readonly quote: string;
}

const cited: JsonSchema = {
  type: 'object',
  properties: { value: { type: 'number' }, quote: { type: 'string' } },
  required: ['value', 'quote'],
  additionalProperties: false,
};
const citedPoint: JsonSchema = {
  type: 'object',
  properties: { weightLb: { type: 'number' }, armIn: { type: 'number' }, quote: { type: 'string' } },
  required: ['weightLb', 'armIn', 'quote'],
  additionalProperties: false,
};
const nullable = (s: JsonSchema): JsonSchema => ({ anyOf: [s, { type: 'null' }] });

/**
 * Everything the loading computation needs, as the POH prints it. All
 * optional: a page has what it has. `keywords` are the words the quoted
 * line must carry (one from each group), so a number that is on the page
 * but belongs to some other field is caught; `category` names the
 * "NORMAL CATEGORY" / "UTILITY CATEGORY" heading the figure must sit under,
 * since the 172M prints both sets of limits in the same layout.
 */
export interface WbFieldSpec {
  readonly description: string;
  readonly keywords: readonly (readonly string[])[];
  readonly category: 'normal' | 'utility' | null;
}
const f = (description: string, keywords: readonly (readonly string[])[], category: 'normal' | 'utility' | null = null): WbFieldSpec => ({ description, keywords, category });

export const WB_FIELDS = {
  maxTakeoffWeightNormalLb: f('maximum takeoff (or gross) weight, normal category, lb', [['takeoff', 'take-off', 'gross']], 'normal'),
  maxTakeoffWeightUtilityLb: f('maximum takeoff weight, utility category, lb', [['takeoff', 'take-off', 'gross']], 'utility'),
  maxLandingWeightLb: f('maximum landing weight, normal category, lb', [['landing']], 'normal'),
  maxRampWeightLb: f('maximum ramp weight, lb', [['ramp']]),
  frontSeatArmIn: f('pilot and front passenger station arm, inches aft of datum', [['pilot', 'front']]),
  rearSeatArmIn: f('rear passengers station arm, inches', [['rear']]),
  baggage1ArmIn: f('baggage area 1 arm, inches', [['baggage']]),
  baggage1MaxLb: f('baggage area 1 maximum, lb', [['baggage', 'area 1']]),
  baggage2ArmIn: f('baggage area 2 arm, inches', [['baggage']]),
  baggage2MaxLb: f('baggage area 2 maximum, lb', [['baggage', 'area 2']]),
  baggageCombinedMaxLb: f('combined maximum for all baggage areas, lb', [['combined', 'baggage']]),
  fuelArmIn: f('fuel station arm, inches', [['fuel', 'tank']]),
  fuelLbPerGal: f('fuel weight per US gallon, lb', [['gal']]),
  fuelStandardUsableGal: f('usable fuel with standard tanks, US gal', [['standard'], ['gal']]),
  fuelLongRangeUsableGal: f('usable fuel with long range tanks, US gal', [['long range', 'long-range'], ['gal']]),
  oilWeightLb: f('weight of full oil, lb', [['oil']]),
  oilArmIn: f('oil station arm, inches (negative if forward of datum)', [['oil']]),
  oilMomentPer1000: f('oil moment/1000 as printed (negative if forward of datum)', [['oil']]),
  sampleEmptyWeightLb: f('the SAMPLE airplane licensed/basic empty weight in the worked example, lb', [['empty']]),
  sampleEmptyMomentPer1000: f('the SAMPLE airplane empty moment/1000 in the worked example', [['empty']]),
  cgAftNormalIn: f('aft centre of gravity limit, normal category, inches', [['aft', 'aff']], 'normal'),
  cgAftUtilityIn: f('aft centre of gravity limit, utility category, inches', [['aft', 'aff']], 'utility'),
  demonstratedCrosswindKt: f('maximum demonstrated crosswind velocity, knots', [['crosswind']]),
} as const;
export type WbFieldName = keyof typeof WB_FIELDS;

export interface WbPageExtraction {
  readonly fields: Partial<Record<WbFieldName, CitedNumber | null>>;
  /** Forward CG limit as a piecewise line: each point is a (weight, arm) the page states. */
  readonly cgForwardNormal: readonly CitedPoint[];
  readonly cgForwardUtility: readonly CitedPoint[];
  readonly pageSummary: string;
}

export const WB_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    pageSummary: { type: 'string' },
    fields: {
      type: 'object',
      properties: Object.fromEntries(Object.keys(WB_FIELDS).map((k) => [k, nullable(cited)])),
      additionalProperties: false,
    },
    cgForwardNormal: { type: 'array', items: citedPoint, maxItems: 4 },
    cgForwardUtility: { type: 'array', items: citedPoint, maxItems: 4 },
  },
  required: ['pageSummary', 'fields', 'cgForwardNormal', 'cgForwardUtility'],
  additionalProperties: false,
};

const SYSTEM = `You read weight-and-balance figures off one page of an aircraft Pilot's Operating Handbook. You are given the page as OCR text lines, and usually the page image as well.

For every figure you report, quote the line you read it from, copied from the OCR lines exactly as they appear — including their spelling mistakes. The quote is checked against the page: a figure whose quote is not on the page, or whose number is not inside the quote, is thrown away.

Rules:
- Report only figures printed on THIS page. Any field the page does not state is null. Never fill a gap from what you know about the aircraft type.
- The quote must be a run of words from ONE line, long enough to contain both the number and the words that name it. Do not join lines, do not fix the OCR's spelling, do not paraphrase.
- Report the number exactly as printed, in the page's units (lb, inches aft of datum, US gallons, knots). Where the page prints moment/1000, report moment/1000.
- Many POHs print the same limits twice, once under "NORMAL CATEGORY" and once under "UTILITY CATEGORY". Put each figure in the field for the heading it appears under, and do not report a utility figure as a normal one.
- Centre of gravity: the forward limit is a sloped line given as two points ("35.0 inches aft of datum at 1950 lbs. or less, with straight line variation to 38.5 inches aft of datum at 2300 lbs.") — report both points, each with its weight and its arm, quoting the line it came from. The aft limit is a single arm at all weights.
- A worked example ("SAMPLE LOADING PROBLEM") states the sample airplane's own weights, which are not limits. Report its empty weight and empty moment in the sample fields, and take nothing else from it.
- pageSummary: one line saying what this page is.`;

/** The page as the model sees it: one line per printed line, no ids to copy. */
export function pageLines(page: PageOcr): string {
  return page.lines.map((l) => l.text).join('\n');
}

export function buildWbRequest(model: string, doc: DocumentOcr, page: PageOcr, imagePng: Buffer | null): LLMRequest {
  const prompt = `Document: ${doc.filename}, page ${page.page} of ${doc.pageCount}${page.rotation ? ` (printed sideways; rotated ${page.rotation}° to read)` : ''}.\n\nOCR lines:\n${pageLines(page)}`;
  return {
    model,
    system: SYSTEM,
    prompt,
    schema: WB_SCHEMA,
    maxTokens: 1200,
    images: imagePng ? [imagePng.toString('base64')] : [],
  };
}

export function wbContextHash(doc: DocumentOcr, page: number): string {
  return contentHash({ sha256: doc.sha256, page, readerVersion: doc.reader.readerVersion, promptVersion: WB_PROMPT_VERSION });
}

/** One figure after checking: what the model said, where on the page, and whether the page backs it. */
export interface ExtractedField {
  readonly name: string;
  readonly description: string;
  readonly value: number | { readonly weightLb: number; readonly armIn: number };
  readonly page: number;
  /** What the model quoted. */
  readonly quote: string;
  readonly alignment: Alignment;
  /** The line the quote was found on, as the page has it. */
  readonly context: string;
  readonly labelProblem: string | null;
  /** The quote is on the page, the figure is in it, and the line names this field. */
  readonly verified: boolean;
}

/** The lines a located quote covers, and the category heading above them. */
function contextOf(page: PageOcr, lineIndex: number, lineCount: number): { text: string; category: 'normal' | 'utility' | null } {
  const text = page.lines
    .slice(lineIndex, lineIndex + Math.max(1, lineCount))
    .map((l) => l.text)
    .join(' ');
  let category: 'normal' | 'utility' | null = null;
  for (let i = lineIndex; i >= 0; i--) {
    const t = (page.lines[i]?.text ?? '').toUpperCase();
    if (/\bUTILITY\s+CATEGORY\b/.test(t)) {
      category = 'utility';
      break;
    }
    if (/\bNORMAL\s+CATEGORY\b/.test(t)) {
      category = 'normal';
      break;
    }
  }
  return { text, category };
}

function checkLabel(spec: WbFieldSpec, ctx: { text: string; category: 'normal' | 'utility' | null }): string | null {
  const text = ctx.text.toLowerCase();
  for (const group of spec.keywords) {
    if (!group.some((k) => text.includes(k))) return `the quoted line does not mention ${group.join(' or ')}`;
  }
  if (spec.category && ctx.category !== spec.category) {
    return `expected this under a ${spec.category.toUpperCase()} CATEGORY heading, but the nearest heading above is ${ctx.category ? ctx.category.toUpperCase() : 'none'}`;
  }
  return null;
}

export function validateWbExtraction(x: unknown): WbPageExtraction | null {
  if (x === null || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const fieldsIn = (o['fields'] ?? {}) as Record<string, unknown>;
  if (typeof fieldsIn !== 'object' || fieldsIn === null) return null;
  const fields: Partial<Record<WbFieldName, CitedNumber | null>> = {};
  for (const name of Object.keys(WB_FIELDS) as WbFieldName[]) {
    const v = fieldsIn[name];
    if (v === null || v === undefined) {
      fields[name] = null;
      continue;
    }
    if (typeof v !== 'object') return null;
    const c = v as Record<string, unknown>;
    if (typeof c['value'] !== 'number' || typeof c['quote'] !== 'string') return null;
    fields[name] = { value: c['value'], quote: c['quote'] };
  }
  const points = (key: string): CitedPoint[] => {
    const arr = o[key];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object')
      .filter((p) => typeof p['weightLb'] === 'number' && typeof p['armIn'] === 'number' && typeof p['quote'] === 'string')
      .map((p) => ({ weightLb: p['weightLb'] as number, armIn: p['armIn'] as number, quote: p['quote'] as string }));
  };
  return { fields, cgForwardNormal: points('cgForwardNormal'), cgForwardUtility: points('cgForwardUtility'), pageSummary: typeof o['pageSummary'] === 'string' ? o['pageSummary'] : '' };
}

/** Check every figure: quote on the page, number in the quote, line names the field. */
export function alignWbExtraction(doc: DocumentOcr, page: number, ex: WbPageExtraction): ExtractedField[] {
  const pageOcr = doc.pages[page - 1];
  const out: ExtractedField[] = [];
  if (!pageOcr) return out;
  // Scoped to this page: a word id must never resolve to another page's ink.
  const tokens = new Map(pageOcr.words.map((w) => [w.id, w]));

  const push = (name: string, spec: WbFieldSpec, value: ExtractedField['value'], quote: string, numbers: number[]) => {
    const found = locateText(pageOcr, quote);
    if (!found) {
      out.push({
        name,
        description: spec.description,
        value,
        page,
        quote,
        alignment: { match: 'none', page, tokenIds: [], citedText: '', box: null, problem: `the quoted line is not on page ${page}` },
        context: '',
        labelProblem: null,
        verified: false,
      });
      return;
    }
    const alignment = alignNumbers(tokens, found.tokenIds, numbers);
    const ctx = contextOf(pageOcr, found.lineIndex, found.lineCount);
    const labelProblem = alignment.match === 'none' ? null : checkLabel(spec, ctx);
    out.push({
      name,
      description: spec.description,
      value,
      page,
      quote,
      alignment,
      context: ctx.text,
      labelProblem,
      verified: alignment.match !== 'none' && labelProblem === null,
    });
  };

  for (const [name, c] of Object.entries(ex.fields) as [WbFieldName, CitedNumber | null][]) {
    if (!c) continue;
    push(name, WB_FIELDS[name], c.value, c.quote, [c.value]);
  }
  const forwardSpec = (category: 'normal' | 'utility'): WbFieldSpec => ({
    description: `${category} category forward CG limit point (weight lb, arm in)`,
    keywords: [['forward', 'variation', 'inches']],
    category,
  });
  ex.cgForwardNormal.forEach((p, i) => push(`cgForwardNormal[${i}]`, forwardSpec('normal'), { weightLb: p.weightLb, armIn: p.armIn }, p.quote, [p.weightLb, p.armIn]));
  ex.cgForwardUtility.forEach((p, i) => push(`cgForwardUtility[${i}]`, forwardSpec('utility'), { weightLb: p.weightLb, armIn: p.armIn }, p.quote, [p.weightLb, p.armIn]));
  return out;
}
