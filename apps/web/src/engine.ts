/**
 * The pipeline, in the browser.
 *
 * Neither weather service lets a page call it directly, so the reports
 * reach the page one of two ways: live, through the relay, which fetches
 * the whole country on a timer and keeps the latest copy; or recorded,
 * carried with the page and frozen at the moment they were taken. Judging
 * them needs no server either way: decoding, resolution and the rules are
 * ordinary deterministic code, so the page loads the reports into an
 * in-memory store and builds the briefing here — the same code the API
 * runs, producing a briefing with the same content hash.
 *
 * Live is tried first when there is a relay to try. If it cannot be had,
 * the page falls back to the recorded reports and says so where nobody can
 * miss it; it never mixes the two, because a briefing that took this
 * morning's METAR and last month's TAF would be worse than either.
 *
 * That is why changing a personal minimum on this page changes the verdict
 * immediately and honestly, rather than showing a different picture of a
 * result decided somewhere else.
 */
import {
  aerodromeReport,
  assembleBriefing,
  AwcCacheClient,
  AwcClient,
  CANADIAN_UPPERWIND_SITES,
  diffBriefings,
  loadBundle,
  MemoryStore,
  NavCanadaClient,
  notamsForFlight,
  parseAircraftLimits,
  parseFlightPlan,
  parsePilotProfile,
  recordFetchAttempt,
  resolveFlight,
  storeAndDecode,
  UnknownWaypointError,
  withHandbookLimits,
  type Airport,
  type DemoBundle,
  type HttpClient,
  type LLMProvider,
  type NotamSource,
  type RawReport,
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
    // Fifteen hundred identifiers is not an error message.
    super(
      available.length > 12
        ? `"${waypoint}" is not among the ${available.length.toLocaleString('en')} aerodromes this page carries.`
        : `This page carries reports for ${available.join(', ')} only, and "${waypoint}" is not one of them.`,
    );
    this.name = 'NoDataError';
  }
}

/** Where the weather on the page came from, said wherever the weather is shown. */
export interface WeatherSource {
  readonly mode: 'live' | 'recorded';
  /** When the reports were taken from the services: by the relay when live, at the recording otherwise. */
  readonly at: string;
  /** Why the page is showing recorded weather when it tried for live; null when it did not try, or live worked. */
  readonly problem: string | null;
  /** Live products that could not be had. The briefing says what each costs where it matters. */
  readonly missing: readonly string[];
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
  /** Live or recorded, and how old. */
  readonly weather: WeatherSource;
  /** The aerodromes there is data for; anything else cannot be briefed here. */
  readonly aerodromes: readonly Aerodrome[];
  /** The flight, profile and aircraft the bundle was built around. */
  readonly plan: FlightPlanInput;
  readonly profile: ProfileInput;
  readonly aircraft: AircraftInput;
  /** The handbook data published beside the reports, in the shape the API serves it. */
  readonly wb: WeightBalanceSpec | null;
  /** Which model ranked the NOTAMs, if any: the recorded one, or none when live. */
  readonly model: string | null;
  /**
   * Every report it holds, verbatim — the whole of what a briefing here can
   * see. Read when shown: live NOTAMs arrive as flights are briefed.
   */
  readonly reports: readonly HeldReport[];
  brief(plan: FlightPlanInput, profile: ProfileInput, aircraft: AircraftInput): Promise<LocalBriefing>;
  /**
   * Everything about one field now, or at the recorded instant, needing no
   * flight plan: a pilot looking a place up has usually not planned one yet.
   */
  aerodrome(id: string): Promise<AerodromeReport | null>;
  /** What the store knows about an identifier, for the form to answer as it is typed. */
  airport(id: string): Promise<{ icaoId: string | null; faaId: string | null; name: string; city: string | null; country: string | null; runways: { id: string }[] } | null>;
}

/** The products a live briefing cannot do without are missing. Upper winds and hazards it can, and says so. */
class LiveUnavailable extends Error {}

interface Live {
  /** When the relay took the METARs from the service: the age the page shows. */
  readonly at: string;
  readonly missing: string[];
  /** NOTAMs through the relay, holding each batch so the reports page can list it. */
  readonly notams: NotamSource;
}

/**
 * Fill the store from the relay: every METAR and TAF, the hazard
 * advisories and the upper winds — the products that cover the whole
 * country, which the relay keeps current on its own timer. NOTAMs are per
 * aerodrome and come later, when a flight is briefed.
 *
 * Parsed by the same clients the server fetches with, pointed at the relay
 * instead of the services, so a report is named by the same hash here as
 * there. Only stations the page has an aerodrome for are kept: a report
 * from a station with no position cannot be resolved to anywhere.
 */
async function fetchLive(store: MemoryStore, relay: string, airports: readonly Airport[], hold: (reports: readonly RawReport[], site: string | null) => void): Promise<Live> {
  const fetchedAt = new Map<string, string>();
  const http: HttpClient = {
    async get(url, init) {
      let res: Response;
      try {
        res = await fetch(url, init?.headers ? { headers: { ...init.headers } } : undefined);
      } catch (e) {
        // A refused connection or a CORS refusal looks the same from here, and both mean the relay is not there.
        throw new LiveUnavailable(`the relay could not be reached (${(e as Error).message})`);
      }
      const at = res.headers.get('x-fetched-at');
      if (at) fetchedAt.set(url, at);
      return { status: res.status, body: await res.text(), headers: {} };
    },
  };
  const known = new Set(airports.flatMap((a) => [a.icaoId, a.faaId]).filter((id): id is string => !!id).map((id) => id.toUpperCase()));
  const cache = new AwcCacheClient(http, `${relay}/awc/cache`);
  const awc = new AwcClient(http, `${relay}/awc`);
  const cfps = new NavCanadaClient(http, `${relay}/cfps/`);

  const [metars, tafs, hazards, winds] = await Promise.allSettled([cache.metars(), cache.tafs(), awc.sigmets(), cfps.upperWinds([...CANADIAN_UPPERWIND_SITES])]);
  /*
   * Observations and forecasts are the briefing. Without either there is no
   * live briefing to give, and the recorded one, labelled as recorded, is
   * more honest than half of a live one.
   */
  if (metars.status === 'rejected') throw new LiveUnavailable(`the live METARs could not be fetched: ${(metars.reason as Error).message}`);
  if (tafs.status === 'rejected') throw new LiveUnavailable(`the live TAFs could not be fetched: ${(tafs.reason as Error).message}`);

  const now = new Date();
  for (const batch of [metars.value, tafs.value]) {
    const ours = batch.reports.filter((r) => r.station !== null && known.has(r.station.toUpperCase()));
    await storeAndDecode(store, ours, batch.request, now);
    hold(ours, null);
  }
  const missing: string[] = [];
  if (hazards.status === 'fulfilled') {
    // Recorded under the same name the server uses for a product with no station of its own.
    await recordFetchAttempt(store, 'WORLD', 'sigmet', now, hazards.value.request);
    await storeAndDecode(store, hazards.value.reports, hazards.value.request, now, 'WORLD');
    hold(hazards.value.reports, null);
  } else missing.push('hazard advisories');
  if (winds.status === 'fulfilled') {
    for (const site of CANADIAN_UPPERWIND_SITES) {
      const mine = winds.value.reports.filter((r) => r.station === site);
      await storeAndDecode(store, mine, winds.value.request, now, site);
      hold(mine, site);
    }
  } else missing.push('upper winds');

  return {
    at: fetchedAt.get(metars.value.request) ?? now.toISOString(),
    missing,
    notams: {
      async notams(site) {
        const fetched = await cfps.notams(site);
        hold(fetched.reports, site);
        return fetched;
      },
    },
  };
}

/**
 * Load the reports — live through the relay when there is one, recorded
 * otherwise — and hand back something that can brief over them. The store
 * is built once; briefing again is a few milliseconds of arithmetic, which
 * is why the page can recompute as the form is typed in.
 */
export async function loadEngine(base: string, relay: string | null = null): Promise<LocalEngine> {
  const [bundleRes, wbRes] = await Promise.all([fetch(`${base}demo/bundle.json`), fetch(`${base}demo/wb.json`)]);
  if (!bundleRes.ok) throw new Error(`the recorded reports could not be loaded (HTTP ${bundleRes.status})`);
  const bundle = (await bundleRes.json()) as DemoBundle;
  const wb = wbRes.ok ? ((await wbRes.json()) as WeightBalanceSpec) : null;

  const held = new Map<string, HeldReport>();
  const hold = (reports: readonly RawReport[], site: string | null): void => {
    for (const r of reports) {
      const sites = new Set(held.get(r.sha256)?.fetchedFor ?? []);
      if (site) sites.add(site);
      held.set(r.sha256, { sha256: r.sha256, kind: r.kind, station: r.station, issuedAt: r.issuedAt?.toISOString() ?? null, body: r.body, fetchedFor: [...sites].sort() });
    }
  };

  /** The recorded reports, exactly as carried. Throws if a report's bytes do not hash to the name it arrived under. */
  const recorded = async (): Promise<MemoryStore> => {
    const s = new MemoryStore();
    await loadBundle(s, bundle);
    held.clear();
    for (const r of bundle.reports) held.set(r.sha256, { sha256: r.sha256, kind: r.kind, station: r.station, issuedAt: r.issuedAt, body: r.body, fetchedFor: r.fetchedFor });
    return s;
  };

  let store: MemoryStore;
  let live: Live | null = null;
  let weather: WeatherSource;
  if (relay) {
    try {
      store = new MemoryStore();
      // The aerodromes, and nothing recorded: no report, and no model answer about a NOTAM that may no longer exist.
      await loadBundle(store, { ...bundle, reports: [], assessments: [] });
      live = await fetchLive(store, relay.replace(/\/+$/, ''), bundle.airports, hold);
      weather = { mode: 'live', at: live.at, problem: null, missing: live.missing };
    } catch (e) {
      // Anything else is a bug in this page, and should surface as one rather than be relabelled as weather.
      if (!(e instanceof LiveUnavailable)) throw e;
      live = null;
      store = await recorded();
      weather = { mode: 'recorded', at: bundle.recordedAt, problem: e.message, missing: [] };
    }
  } else {
    store = await recorded();
    weather = { mode: 'recorded', at: bundle.recordedAt, problem: null, missing: [] };
  }

  const recordedAsOf = new Date(bundle.asOf);
  /** Live weather is judged at the moment of asking; recorded weather at the moment it was recorded. */
  const asOf = (): Date => (live ? new Date() : recordedAsOf);
  /** The last briefing produced here, so the next one can say what changed. */
  let previous: ReturnType<typeof assembleBriefing> | null = null;

  return {
    weather,
    aerodromes: bundle.airports
      .map((a) => ({ id: a.icaoId ?? a.faaId, name: a.name }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    plan: asJson<FlightPlanInput>(bundle.plan),
    profile: asJson<ProfileInput>(bundle.profile),
    aircraft: asJson<AircraftInput>(bundle.aircraft),
    wb,
    model: live ? null : bundle.model,
    get reports() {
      return [...held.values()];
    },
    async brief(planInput, profileInput, aircraftInput) {
      const plan = parseFlightPlan(planInput);
      const profile = parsePilotProfile(profileInput);
      // The handbook's demonstrated crosswind, with the citation it came from.
      const aircraft = withHandbookLimits(parseAircraftLimits(aircraftInput), wb as CoreWeightBalanceSpec | null);
      const at = asOf();
      let resolved;
      try {
        resolved = await resolveFlight(store, plan, at);
      } catch (e) {
        if (e instanceof UnknownWaypointError) throw new NoDataError(e.id, bundle.airports.map((a) => a.icaoId ?? a.faaId));
        throw e;
      }
      /*
       * Live, the NOTAMs are fetched for this flight's aerodromes through the
       * relay, once per site per half hour, and ranked by the rules alone:
       * no model runs here. Recorded, the answers the model gave when the
       * reports were taken are replayed.
       */
      const notams = live
        ? await notamsForFlight({ store, navcanada: live.notams, provider: null, model: null }, resolved, aircraft.type)
        : await notamsForFlight({ store, navcanada: null, provider: noModel, model: bundle.model, now: () => recordedAsOf }, resolved, aircraft.type);
      const briefing = assembleBriefing(resolved, profile, aircraft, at, notams);
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
      const report = await aerodromeReport(store, id, asOf(), parsePilotProfile(bundle.profile), withHandbookLimits(parseAircraftLimits(bundle.aircraft), wb as CoreWeightBalanceSpec | null));
      return report ? asJson<AerodromeReport>(report) : null;
    },
    async airport(id) {
      const a = await store.getAirport(id);
      return a ? { icaoId: a.icaoId, faaId: a.faaId, name: a.name, city: a.city, country: a.country, runways: a.runways.map((r) => ({ id: r.id })) } : null;
    },
  };
}
