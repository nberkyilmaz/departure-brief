/**
 * The pipeline, in the browser.
 *
 * Neither weather service lets a page call it directly, so a briefing of a
 * flight happening now needs a server to do the fetching. Judging one does
 * not: decoding, resolution and the rules are ordinary deterministic code.
 * So the published site carries the reports themselves, loads them into an
 * in-memory store, and builds the briefing here — the same code the API
 * runs, producing a briefing with the same content hash.
 *
 * That is why changing a personal minimum on this page changes the verdict
 * immediately and honestly, rather than showing a different picture of a
 * result decided somewhere else.
 */
import {
  aerodromeReport,
  assembleBriefing,
  diffBriefings,
  loadBundle,
  MemoryStore,
  notamsForFlight,
  parseAircraftLimits,
  parseFlightPlan,
  parsePilotProfile,
  resolveFlight,
  UnknownWaypointError,
  withHandbookLimits,
  type DemoBundle,
  type LLMProvider,
  type WeightBalanceSpec as CoreWeightBalanceSpec,
} from '@depbrief/core/judge';
import type { AerodromeReport, AircraftInput, BriefingDiff, FlightPlanInput, ProfileInput, StoredBriefing, WeightBalanceSpec } from './types.js';

export type { AerodromeReport };

/**
 * A model cannot run here. Answers recorded when the demo was built are
 * read from the store before a provider is ever consulted, so the NOTAMs
 * that were assessed then keep their ranking, and anything else is
 * reported as not assessed rather than guessed at.
 */
const noModel: LLMProvider = {
  id: 'none',
  async complete() {
    throw new Error('no model runs in a browser; this NOTAM was not among the recorded answers');
  },
};

/** What the API would have sent: dates as ISO strings, nothing else changed. */
function asJson<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class NoDataError extends Error {
  constructor(
    readonly waypoint: string,
    readonly available: readonly string[],
  ) {
    super(`This page carries recorded reports for ${available.join(', ')} only, and "${waypoint}" is not one of them.`);
    this.name = 'NoDataError';
  }
}

export interface Aerodrome {
  readonly id: string;
  readonly name: string;
}

/** A briefing, and what changed since the one before it. */
export interface LocalBriefing {
  readonly briefing: StoredBriefing;
  /** Null for the first briefing, or when nothing worth showing moved. */
  readonly diff: BriefingDiff | null;
}

/** A report the page is holding, as it arrived. */
export interface HeldReport {
  readonly sha256: string;
  readonly kind: string;
  readonly station: string | null;
  readonly issuedAt: string | null;
  readonly body: string;
  readonly fetchedFor: readonly string[];
}

export interface LocalEngine {
  /** When the reports it holds were taken. */
  readonly recordedAt: string;
  /** The aerodromes there is data for; anything else cannot be briefed here. */
  readonly aerodromes: readonly Aerodrome[];
  /** The flight, profile and aircraft the bundle was built around. */
  readonly plan: FlightPlanInput;
  readonly profile: ProfileInput;
  readonly aircraft: AircraftInput;
  /** The handbook data published beside the reports, in the shape the API serves it. */
  readonly wb: WeightBalanceSpec | null;
  /** Which model ranked the NOTAMs when this was recorded, if any. */
  readonly model: string | null;
  /** Every report it holds, verbatim — the whole of what a briefing here can see. */
  readonly reports: readonly HeldReport[];
  brief(plan: FlightPlanInput, profile: ProfileInput, aircraft: AircraftInput): Promise<LocalBriefing>;
  /**
   * Everything about one field at the recorded instant, needing no flight
   * plan: a pilot looking a place up has usually not planned one yet.
   */
  aerodrome(id: string): Promise<AerodromeReport | null>;
  /** What the store knows about an identifier, for the form to answer as it is typed. */
  airport(id: string): Promise<{ icaoId: string | null; faaId: string | null; name: string; city: string | null; country: string | null; runways: { id: string }[] } | null>;
}

/**
 * Load the recorded reports and hand back something that can brief over
 * them. The store is built once; briefing again is a few milliseconds of
 * arithmetic, which is why the page can recompute as the form is typed in.
 */
export async function loadEngine(base: string): Promise<LocalEngine> {
  const [bundleRes, wbRes] = await Promise.all([fetch(`${base}demo/bundle.json`), fetch(`${base}demo/wb.json`)]);
  if (!bundleRes.ok) throw new Error(`the recorded reports could not be loaded (HTTP ${bundleRes.status})`);
  const bundle = (await bundleRes.json()) as DemoBundle;
  const wb = wbRes.ok ? ((await wbRes.json()) as WeightBalanceSpec) : null;

  const store = new MemoryStore();
  // Throws if a report's bytes do not hash to the name it arrived under.
  await loadBundle(store, bundle);
  const asOf = new Date(bundle.asOf);
  /** The last briefing produced here, so the next one can say what changed. */
  let previous: ReturnType<typeof assembleBriefing> | null = null;

  return {
    recordedAt: bundle.recordedAt,
    aerodromes: bundle.airports
      .map((a) => ({ id: a.icaoId ?? a.faaId, name: a.name }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    plan: asJson<FlightPlanInput>(bundle.plan),
    profile: asJson<ProfileInput>(bundle.profile),
    aircraft: asJson<AircraftInput>(bundle.aircraft),
    wb,
    model: bundle.model,
    reports: bundle.reports.map((r) => ({
      sha256: r.sha256,
      kind: r.kind,
      station: r.station,
      issuedAt: r.issuedAt,
      body: r.body,
      fetchedFor: r.fetchedFor,
    })),
    async brief(planInput, profileInput, aircraftInput) {
      const plan = parseFlightPlan(planInput);
      const profile = parsePilotProfile(profileInput);
      // The handbook's demonstrated crosswind, with the citation it came from.
      const aircraft = withHandbookLimits(parseAircraftLimits(aircraftInput), wb as CoreWeightBalanceSpec | null);
      let resolved;
      try {
        resolved = await resolveFlight(store, plan, asOf);
      } catch (e) {
        if (e instanceof UnknownWaypointError) throw new NoDataError(e.id, bundle.airports.map((a) => a.icaoId ?? a.faaId));
        throw e;
      }
      const notams = await notamsForFlight({ store, navcanada: null, provider: noModel, model: bundle.model, now: () => asOf }, resolved, aircraft.type);
      const briefing = assembleBriefing(resolved, profile, aircraft, asOf, notams);
      /*
       * What moved since the last briefing of this flight. The API answers
       * the same question from the database; here the store is the session,
       * so it is "since you last changed something" — which is the useful
       * reading when the reports are frozen and the minimums are not.
       */
      /*
       * Only against the same flight. Change the destination and the
       * previous briefing is about somewhere else — "what changed" has no
       * answer, and asking for one throws.
       */
      const before = previous && previous.sha256 !== briefing.sha256 && previous.flightKey === briefing.flightKey ? previous : null;
      previous = briefing;
      await store.putBriefing(briefing);
      const diff = before ? diffBriefings(before, briefing) : null;
      return { briefing: asJson<StoredBriefing>(briefing), diff: diff && !diff.quiet ? asJson<BriefingDiff>(diff) : null };
    },
    async aerodrome(id) {
      const report = await aerodromeReport(store, id, asOf, parsePilotProfile(bundle.profile), withHandbookLimits(parseAircraftLimits(bundle.aircraft), wb as CoreWeightBalanceSpec | null));
      return report ? asJson<AerodromeReport>(report) : null;
    },
    async airport(id) {
      const a = await store.getAirport(id);
      return a ? { icaoId: a.icaoId, faaId: a.faaId, name: a.name, city: a.city, country: a.country, runways: a.runways.map((r) => ({ id: r.id })) } : null;
    },
  };
}
