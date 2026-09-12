/**
 * The relevance assessment: one NOTAM, one flight, one small JSON answer.
 * Deterministic filtering has already happened; this is the only place a
 * model sees a NOTAM. The answer is cached on (NOTAM hash, flight-context
 * hash, prompt version, model) so re-briefing an unchanged flight costs
 * nothing, and it is never trusted unless its cited span is verbatim.
 */

import { contentHash } from '../brief/canonical.js';
import type { JsonSchema, LLMProvider, LLMRequest } from '../llm/provider.js';
import type { RawReport } from '../store/types.js';
import type { DecodedNotam } from './types.js';

/** Bump whenever the prompt or the schema changes meaning. */
export const PROMPT_VERSION = 1;

export const RELEVANCES = ['critical', 'advisory', 'irrelevant'] as const;
export type Relevance = (typeof RELEVANCES)[number];
export const CATEGORIES = ['runway', 'taxiway', 'approach', 'airspace', 'lighting', 'navaid', 'obstacle', 'services', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];
export const AFFECTS = ['departure', 'enroute', 'arrival', 'alternate'] as const;
export type Affects = (typeof AFFECTS)[number];

export interface NotamAssessment {
  readonly relevance: Relevance;
  readonly category: Category;
  readonly affects: readonly Affects[];
  /** The NOTAM decoded into plain English. */
  readonly plain_text: string;
  /** Must appear verbatim in the NOTAM text; the assessment is untrusted otherwise. */
  readonly cited_span: string;
  readonly rationale: string;
}

export const ASSESSMENT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    relevance: { type: 'string', enum: [...RELEVANCES] },
    category: { type: 'string', enum: [...CATEGORIES] },
    affects: { type: 'array', items: { type: 'string', enum: [...AFFECTS] } },
    plain_text: { type: 'string' },
    cited_span: { type: 'string' },
    rationale: { type: 'string' },
  },
  required: ['relevance', 'category', 'affects', 'plain_text', 'cited_span', 'rationale'],
  additionalProperties: false,
};

/** Validate by hand; a schema-constrained model can still return the wrong thing. */
export function validateAssessment(x: unknown): NotamAssessment | null {
  if (x === null || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null);
  const relevance = str('relevance');
  const category = str('category');
  const plain = str('plain_text');
  const cited = str('cited_span');
  const rationale = str('rationale');
  if (!relevance || !(RELEVANCES as readonly string[]).includes(relevance)) return null;
  if (!category || !(CATEGORIES as readonly string[]).includes(category)) return null;
  if (plain === null || cited === null || rationale === null) return null;
  if (!Array.isArray(o['affects']) || !o['affects'].every((a) => (AFFECTS as readonly string[]).includes(a as string))) return null;
  return {
    relevance: relevance as Relevance,
    category: category as Category,
    affects: [...new Set(o['affects'] as Affects[])],
    plain_text: plain,
    cited_span: cited,
    rationale,
  };
}

/** What the model is told about the flight. Hashed into the cache key. */
export interface FlightContext {
  readonly departure: string;
  readonly destination: string;
  readonly alternate: string | null;
  readonly route: readonly string[];
  /** ISO instants per point, in order, alternate last when present. */
  readonly times: readonly { readonly id: string; readonly eta: string }[];
  readonly aircraft: string;
  readonly flightRules: 'VFR' | 'IFR';
  readonly cruiseAltitudeFt: number;
  readonly equipment: readonly string[];
}

export function flightContextHash(ctx: FlightContext): string {
  return contentHash(ctx);
}

const SYSTEM = `You assess NOTAMs for one specific general-aviation flight. You are given the flight (aircraft, rules, route, altitude, times) and one NOTAM in ICAO format. Decide whether the NOTAM matters to THIS flight.

relevance:
- "critical": affects whether or how this flight can be flown as planned — a closed runway or taxiway the flight would use, an approach or navaid it would rely on, airspace it would enter during the times it is active, an obstacle near its path, a service it needs.
- "advisory": worth the pilot's knowledge but not decisive — lighting out by day, a distant obstacle, a facility change that changes nothing operationally for this flight, a condition active only outside the flight's times.
- "irrelevant": does not concern this flight — IFR-only items for a VFR flight, other aerodromes, heliport-only matters for an aeroplane, administrative or trigger NOTAMs, geopolitical warnings about other regions.

category: the facility type the NOTAM is about.
affects: which parts of the flight it touches (any of departure, enroute, arrival, alternate); empty when irrelevant.
plain_text: the NOTAM in one or two plain-English sentences a pilot can read at a glance, expanding abbreviations.
cited_span: copy, verbatim and unchanged, the shortest contiguous piece of the NOTAM text that your relevance judgement rests on. It must be an exact substring of the NOTAM.
rationale: one sentence on why this relevance for this flight.

Be conservative: when the effect on this flight is unclear, prefer "advisory" over "irrelevant". Never invent facts not in the NOTAM.`;

function describeFlight(ctx: FlightContext): string {
  const times = ctx.times.map((t) => `${t.id} at ${t.eta.replace(/\.\d{3}Z$/, 'Z')}`).join(', ');
  return [
    `Aircraft: ${ctx.aircraft}, ${ctx.flightRules}, cruise ${ctx.cruiseAltitudeFt} ft MSL.`,
    `Route: ${[ctx.departure, ...ctx.route, ctx.destination].join(' → ')}${ctx.alternate ? `, alternate ${ctx.alternate}` : ''}.`,
    `Times (UTC): ${times}.`,
    `Equipment: ${ctx.equipment.length ? ctx.equipment.join(', ') : 'basic VFR (GNSS)'}.`,
  ].join('\n');
}

export function buildAssessmentRequest(model: string, notam: DecodedNotam, ctx: FlightContext): LLMRequest {
  const q = notam.q?.value;
  const meta = [
    notam.id ? `NOTAM ${notam.id.value.text}` : 'NOTAM',
    q ? `Q code ${q.code.text} (traffic ${q.traffic}, scope ${q.scope}, FL${q.lower}–FL${q.upper}${q.radiusNm !== null ? `, radius ${q.radiusNm} nm` : ''})` : null,
    notam.locations ? `Location(s): ${notam.locations.value.join(' ')}` : null,
    notam.from ? `From ${notam.from.value.iso}` : null,
    notam.to ? `To ${'permanent' in notam.to.value ? 'PERM' : notam.to.value.iso + (notam.to.value.estimated ? ' (EST)' : '')}` : null,
    notam.schedule ? `Schedule: ${notam.schedule.value.replace(/\s+/g, ' ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    model,
    system: SYSTEM,
    prompt: `${describeFlight(ctx)}\n\n${meta}\n\nNOTAM text (cite from this, verbatim):\n${notam.text?.value ?? notam.raw}`,
    schema: ASSESSMENT_SCHEMA,
    maxTokens: 400,
  };
}

export type CitationMatch = 'exact' | 'whitespace' | 'none';

/**
 * The free correctness signal: a span the model claims to quote must be in
 * the NOTAM. Exact match, or a match after collapsing whitespace (the E
 * text wraps lines); anything else is unverified.
 */
export function verifyCitation(assessment: NotamAssessment, notam: DecodedNotam): CitationMatch {
  const haystack = notam.text?.value ?? notam.raw;
  const needle = assessment.cited_span.trim();
  if (needle.length === 0) return 'none';
  if (haystack.includes(needle)) return 'exact';
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toUpperCase();
  if (norm(haystack).includes(norm(needle))) return 'whitespace';
  return 'none';
}

export interface AssessmentRow {
  readonly notamSha256: string;
  readonly contextHash: string;
  readonly promptVersion: number;
  readonly model: string;
  readonly assessment: NotamAssessment;
  readonly citation: CitationMatch;
  readonly provider: string;
  readonly usage: { readonly input: number; readonly output: number };
  readonly createdAt: Date;
}

export interface AssessmentStore {
  putAssessment(row: AssessmentRow): Promise<{ inserted: boolean }>;
  getAssessment(notamSha256: string, contextHash: string, promptVersion: number, model: string): Promise<AssessmentRow | null>;
}

export interface AssessOutcome {
  readonly row: AssessmentRow | null;
  readonly cached: boolean;
  /** Set when the model answered but the answer failed validation; the NOTAM is then "not assessed". */
  readonly invalid: string | null;
}

/** Assess one NOTAM, reading the cache first and writing to it after. */
export async function assessNotam(
  provider: LLMProvider,
  model: string,
  store: AssessmentStore,
  report: RawReport,
  notam: DecodedNotam,
  ctx: FlightContext,
  now: () => Date = () => new Date(),
): Promise<AssessOutcome> {
  const contextHash = flightContextHash(ctx);
  const cached = await store.getAssessment(report.sha256, contextHash, PROMPT_VERSION, model);
  if (cached) return { row: cached, cached: true, invalid: null };
  const res = await provider.complete(buildAssessmentRequest(model, notam, ctx));
  const assessment = validateAssessment(res.json);
  if (!assessment) return { row: null, cached: false, invalid: `model output failed validation: ${res.text.slice(0, 200)}` };
  const row: AssessmentRow = {
    notamSha256: report.sha256,
    contextHash,
    promptVersion: PROMPT_VERSION,
    model,
    assessment,
    citation: verifyCitation(assessment, notam),
    provider: res.provider,
    usage: res.usage,
    createdAt: now(),
  };
  await store.putAssessment(row);
  return { row, cached: false, invalid: null };
}
