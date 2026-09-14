/**
 * NOTAMs for a resolved flight: fetch (optional), store, decode, dedupe,
 * classify deterministically, assess the in-scope ones with a model when
 * one is available, verify citations, rank. Every NOTAM the sources
 * returned is in the output — ranking and classification decide order
 * and collapse state, never presence.
 */

import type { NavCanadaClient } from '../fetch/navcanada.js';
import { storeAndDecode } from '../store/decode.js';
import type { LLMProvider } from '../llm/provider.js';
import { isNight } from '../domain/sun.js';
import type { ResolvedFlight } from '../resolve/flight.js';
import type { RawReport, Store } from '../store/types.js';
import { assessNotam, flightContextHash, PROMPT_VERSION, type AssessmentRow, type FlightContext, type NotamFacts } from './assess.js';
import { dedupeNotams } from './dedupe.js';
import { classifyNotam, type NotamClassification } from './filter.js';
import { ruleRelevance, type RuleDecision } from './rules.js';
import type { DecodedNotam } from './types.js';

/** Display rank, best first. `unverified`: the model answered but its citation is not in the NOTAM. */
export type NotamRank = 'critical' | 'advisory' | 'unverified' | 'not-assessed' | 'irrelevant' | 'out-of-scope';

export const RANK_ORDER: readonly NotamRank[] = ['critical', 'advisory', 'unverified', 'not-assessed', 'irrelevant', 'out-of-scope'];

export interface RankedNotam {
  readonly report: RawReport;
  readonly decoded: DecodedNotam;
  /** Sites this NOTAM was fetched for (a FIR-wide one lists several). */
  readonly sites: readonly string[];
  readonly duplicates: number;
  readonly supersededBy: string | null;
  readonly classification: NotamClassification;
  readonly assessment: AssessmentRow | null;
  readonly assessmentCached: boolean;
  readonly assessmentError: string | null;
  /** Relevance settled by a deterministic rule from the Q code and the flight; the model was not asked. */
  readonly rule: RuleDecision | null;
  readonly rank: NotamRank;
}

export interface NotamBriefing {
  readonly sites: readonly string[];
  readonly context: FlightContext;
  readonly contextHash: string;
  readonly promptVersion: number;
  readonly model: string | null;
  readonly items: readonly RankedNotam[];
  readonly counts: Readonly<Record<NotamRank, number>>;
  /** Fetch failures by site — shown, never swallowed. */
  readonly fetchErrors: readonly { readonly site: string; readonly error: string }[];
}

export interface NotamDeps {
  readonly store: Store & import('./assess.js').AssessmentStore;
  /** Fetches fresh NOTAMs per site when present. */
  readonly navcanada?: NavCanadaClient | null;
  /** Assesses in-scope NOTAMs when present. */
  readonly provider?: LLMProvider | null;
  readonly model?: string | null;
  readonly now?: () => Date;
}

/** Margin around the flight's times, so a NOTAM starting just after arrival is still in scope. */
export const WINDOW_MARGIN_MS = 60 * 60_000;

export function flightContextOf(flight: ResolvedFlight, aircraft: string): FlightContext {
  const times = flight.points.map((p) => ({ id: p.point.waypoint.id, eta: p.point.eta.toISOString() }));
  if (flight.alternate) times.push({ id: flight.alternate.point.waypoint.id, eta: flight.alternate.point.eta.toISOString() });
  return {
    departure: flight.plan.departure,
    destination: flight.plan.destination,
    alternate: flight.plan.alternate,
    route: flight.plan.route,
    times,
    aircraft,
    flightRules: 'VFR',
    cruiseAltitudeFt: flight.plan.cruise.altitude,
    equipment: [],
    aerodromes: [...flight.points, ...(flight.alternate ? [flight.alternate] : [])]
      .filter((p) => p.point.waypoint.airport)
      .map((p) => ({ id: p.point.waypoint.id, role: p.point.waypoint.role, runways: p.point.waypoint.airport!.runways.map((r) => r.id) })),
    daylight: [...flight.points, ...(flight.alternate ? [flight.alternate] : [])].every((p) => !isNight(p.point.waypoint.position, p.point.eta)),
  };
}

/** The deterministic facts about one NOTAM for this flight, phrased for the model. */
export function notamFactsOf(ctx: FlightContext, decoded: DecodedNotam, classification: NotamClassification): NotamFacts {
  const locations = decoded.locations?.value ?? [];
  const named = locations.map((loc) => {
    const a = ctx.aerodromes.find((x) => x.id === loc);
    return a ? `${loc}, this flight's ${a.role} aerodrome` : /^C[XY]|^K/.test(loc) && loc.length === 4 && !locations.every((l) => l.startsWith('CZ')) ? `${loc}, an aerodrome this flight does not use` : `${loc}`;
  });
  const fir = locations.length > 0 && locations.every((l) => /^CZ[A-Z]{2}$|^[A-Z]{4}$/.test(l) && !ctx.aerodromes.some((a) => a.id === l) && l.startsWith('CZ'));
  const concerns = fir
    ? `It applies FIR-wide (${locations.join(', ')}); the whole flight is inside that airspace.`
    : locations.length
      ? `It concerns ${named.join(' and ')}.`
      : 'It names no location.';
  const activeDuringFlight: NotamFacts['activeDuringFlight'] = classification.time === 'active' ? 'yes' : classification.time === 'unknown' ? 'unknown' : 'no';
  return { concerns, activeDuringFlight, distanceFromRouteNm: classification.distanceNm };
}

function rankOf(item: Omit<RankedNotam, 'rank'>): NotamRank {
  if (!item.classification.inScope) return 'out-of-scope';
  if (item.rule) return item.rule.relevance;
  if (!item.assessment) return 'not-assessed';
  if (item.assessment.citation === 'none') return 'unverified';
  return item.assessment.assessment.relevance;
}

export async function notamsForFlight(deps: NotamDeps, flight: ResolvedFlight, aircraft: string): Promise<NotamBriefing> {
  const now = deps.now ?? (() => new Date());
  const sites = [...new Set([...flight.points, ...(flight.alternate ? [flight.alternate] : [])].map((p) => p.point.waypoint.airport?.icaoId).filter((s): s is string => !!s))];
  const fetchErrors: { site: string; error: string }[] = [];

  let fetchedAt: Date | null = null;
  if (deps.navcanada) {
    for (const site of sites) {
      try {
        const fetched = await deps.navcanada.notams(site);
        fetchedAt = now();
        // The fetch is recorded as being for this site, so a FIR-wide NOTAM
        // stored under the first site is still listed under the others.
        await storeAndDecode(deps.store, fetched.reports, fetched.request, fetchedAt, site);
      } catch (e) {
        fetchErrors.push({ site, error: (e as Error).message });
      }
    }
  }

  /*
   * "Known by" the briefing instant — but a briefing also knows whatever it
   * just fetched for itself, and that fetch necessarily lands after `asOf`
   * was taken. Without this, briefing a flight and fetching for it in the
   * same breath would discard every NOTAM it had only now retrieved.
   * Re-briefing an old instant without fetching still sees only what was
   * stored by then, which is what makes a briefing reproducible.
   */
  const knownBy = fetchedAt && fetchedAt.getTime() > flight.asOf.getTime() ? fetchedAt : flight.asOf;

  const bySha = new Map<string, { report: RawReport; sites: Set<string> }>();
  for (const site of sites) {
    for (const r of await deps.store.listRaw({ station: site, kind: 'notam', limit: 500, knownBy })) {
      const cur = bySha.get(r.sha256);
      if (cur) cur.sites.add(site);
      else bySha.set(r.sha256, { report: r, sites: new Set([site]) });
    }
  }

  const window = {
    start: new Date(new Date(flight.plan.departureTime).getTime() - WINDOW_MARGIN_MS),
    end: new Date(Math.max(...[...flight.points, ...(flight.alternate ? [flight.alternate] : [])].map((p) => p.point.eta.getTime())) + WINDOW_MARGIN_MS),
  };
  const route = [...flight.points, ...(flight.alternate ? [flight.alternate] : [])].map((p) => p.point.waypoint.position);
  const context = flightContextOf(flight, aircraft);
  const contextHash = flightContextHash(context);
  const model = deps.provider ? (deps.model ?? null) : null;

  const items: RankedNotam[] = [];
  for (const d of dedupeNotams([...bySha.values()].map((v) => v.report))) {
    const siteSet = new Set<string>();
    for (const r of [d.report, ...d.duplicates]) for (const s of bySha.get(r.sha256)?.sites ?? []) siteSet.add(s);
    const classification = classifyNotam(d.decoded, window, route);
    const rule = classification.inScope ? ruleRelevance(d.decoded, classification, context) : null;
    let assessment: AssessmentRow | null = null;
    let cached = false;
    let assessmentError: string | null = null;
    if (classification.inScope && !rule && deps.provider && model) {
      try {
        const outcome = await assessNotam(deps.provider, model, deps.store, d.report, d.decoded, context, now, notamFactsOf(context, d.decoded, classification));
        assessment = outcome.row;
        cached = outcome.cached;
        assessmentError = outcome.invalid;
      } catch (e) {
        assessmentError = (e as Error).message;
      }
    }
    const base = { report: d.report, decoded: d.decoded, sites: [...siteSet].sort(), duplicates: d.duplicates.length, supersededBy: d.supersededBy, classification, assessment, assessmentCached: cached, assessmentError, rule };
    items.push({ ...base, rank: rankOf(base) });
  }
  items.sort((a, b) => RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank) || (a.decoded.id?.value.text ?? '').localeCompare(b.decoded.id?.value.text ?? ''));

  const counts = Object.fromEntries(RANK_ORDER.map((r) => [r, items.filter((i) => i.rank === r).length])) as Record<NotamRank, number>;
  return { sites, context, contextHash, promptVersion: PROMPT_VERSION, model, items, counts, fetchErrors };
}
