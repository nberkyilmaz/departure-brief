import { performanceFor } from '@depbrief/core/judge';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { About } from './About.js';
import { BriefingView } from './BriefingView.js';
import { DiffPanel } from './DiffPanel.js';
import { loadEngine, type LocalEngine } from './engine.js';
import { FlightForm, defaultDeparture, defaultPlan, departureTimeNote, planProblems } from './FlightForm.js';
import { FlightLine } from './FlightLine.js';
import { Nav, TabBar, usePhone } from './Nav.js';
import { NavLogPage } from './NavLogPage.js';
import { ProfileForm, defaultAircraft, defaultProfile } from './ProfileForm.js';
import { ReportsPage } from './ReportsPage.js';
import { StartPage } from './StartPage.js';
import { AerodromePage } from './AerodromePage.js';
import { hrefFor, useRoute } from './router.js';
import { concernsOf } from './summary.js';
import { useStored } from './useStored.js';
import { WbPanel } from './WbPanel.js';
import { WeatherNote, weatherPhrase } from './WeatherNote.js';
import { WhenCanIGo } from './WhenCanIGo.js';
import type { AircraftInput, BriefingDiff, DepartureSlot, FlightPlanInput, ProfileInput, RoutePicture, StoredBriefing } from './types.js';

/**
 * Two ways to brief, one form.
 *
 * With an API behind it, the form briefs a flight happening now: the server
 * fetches what it needs and judges it. The published build has no server, so
 * it judges the reports here, in the page — live ones fetched through the
 * relay when there is one, or the recorded ones it carries. The pipeline is
 * the same code every way — what differs is only where the reports come
 * from and how old they are.
 */
const DEMO = import.meta.env.VITE_DEMO === '1';
const RELAY = import.meta.env.VITE_RELAY?.trim() || null;
const base = import.meta.env.BASE_URL;

/**
 * How much of the briefing wants reading: the lines under "Worth a look",
 * and the most any of them asks for. A count, never a verdict.
 */
function attentionOf(b: StoredBriefing | null): { level: 'caution' | 'alert'; count: number } | null {
  if (!b) return null;
  const wanting = concernsOf(b);
  if (wanting.length === 0) return null;
  return { level: wanting.some((c) => c.attention === 'alert') ? 'alert' : 'caution', count: wanting.length };
}

/**
 * The published build has no server to ask about an identifier, and asking
 * anyway gets a 404 that the field would remember as "no such aerodrome".
 * Until the page's own data has loaded, a lookup simply waits; the field asks
 * again when the real one arrives.
 */
const untilLoaded = (): Promise<null> => new Promise<null>(() => {});

/** How long to wait after a change before rebuilding the briefing, locally. */
const SETTLE_MS = 250;

export function App() {
  const route = useRoute();
  const [engine, setEngine] = useState<LocalEngine | null>(null);
  // A new key: plans saved under the old one were the sample flight, not the visitor's.
  const [plan, setPlan] = useStored<FlightPlanInput>('flight', defaultPlan);
  const [profile, setProfile] = useStored<ProfileInput>('profile', defaultProfile);
  const [aircraft, setAircraft] = useStored<AircraftInput>('aircraft', defaultAircraft);
  const [busy, setBusy] = useState(DEMO);
  const [error, setError] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<StoredBriefing | null>(null);
  const [picture, setPicture] = useState<RoutePicture | null>(null);
  const [diff, setDiff] = useState<BriefingDiff | null>(null);
  /** Set once the visitor has changed something, so the page can stop calling it "recorded". */
  const [touched, setTouched] = useState(false);
  /**
   * The flight being entered, while the form is open. The briefing is always
   * of the flight last asked for, never of one half typed: a destination of
   * "CYK" on its way to "CYKF" is not a place to brief. It opens by itself
   * when there is no flight yet, which is how every visit begins.
   */
  const [draft, setDraft] = useState<FlightPlanInput | null>(() => (planProblems(plan).length > 0 ? plan : null));

  useEffect(() => {
    if (!DEMO) return;
    let live = true;
    loadEngine(base, RELAY)
      .then((e) => {
        if (!live) return;
        setEngine(e);
        if (e.weather.mode === 'recorded') {
          /*
           * Start from the flight the reports cover. A form that defaults to
           * two hours from now is right when the weather is current and
           * useless when it is frozen: every point would say "no forecast
           * covers this" and nothing a visitor changed would make any
           * difference.
           */
          setPlan(e.plan);
          setDraft(null);
        } else {
          /*
           * Live, the visitor's own plan stands — except a departure that has
           * already happened, which is what a plan saved last week will
           * have. Briefing a departure in the past against this morning's
           * weather answers no question anybody asked.
           */
          const stale = (p: FlightPlanInput) => !(Date.parse(p.departureTime) > Date.now());
          if (stale(plan)) setPlan({ ...plan, departureTime: defaultDeparture() });
          setDraft((d) => (d && stale(d) ? { ...d, departureTime: defaultDeparture() } : d));
        }
      })
      .catch((e: Error) => {
        if (!live) return;
        setError(e.message);
        setBusy(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const ready = planProblems(plan).length === 0;

  /*
   * Rebuild whenever the flight, the minimums or the aircraft change.
   * Judging is arithmetic over reports already in memory — a few
   * milliseconds — so there is no reason to make somebody press a button to
   * find out what raising their ceiling minimum does.
   */
  const firstRun = useRef(true);
  useEffect(() => {
    if (!engine || !ready) return;
    let live = true;
    const t = window.setTimeout(
      () => {
        setBusy(true);
        engine
          .brief(plan, profile, aircraft)
          .then((r) => {
            if (!live) return;
            setBriefing(r.briefing);
            setPicture(r.picture);
            setDiff(r.diff);
            setError(null);
          })
          // A NoDataError already says which aerodromes there are reports for.
          .catch((e: Error) => {
            if (!live) return;
            setError(e.message);
            // The last flight's briefing under this flight's name would be worse than none.
            setBriefing(null);
            setPicture(null);
            setDiff(null);
          })
          .finally(() => {
            if (!live) return;
            setBusy(false);
            firstRun.current = false;
          });
      },
      firstRun.current ? 0 : SETTLE_MS,
    );
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [engine, plan, profile, aircraft, ready]);

  /*
   * When can I go: the same flight judged at each hour ahead. It does not
   * depend on the departure time, so briefing a picked hour does not redo
   * it; a different route, minimums or aircraft does. Started after the
   * briefing has had its turn, so it never holds the briefing up.
   */
  const [slots, setSlots] = useState<DepartureSlot[]>([]);
  const shape = JSON.stringify({ ...plan, departureTime: null });
  useEffect(() => {
    setSlots([]);
    if (!engine || !ready) return;
    let live = true;
    const t = window.setTimeout(() => {
      engine
        .window(plan, profile, aircraft)
        .then((s) => live && setSlots(s))
        // The briefing says what is wrong with a flight that cannot be judged; the strip just stays away.
        .catch(() => live && setSlots([]));
    }, SETTLE_MS * 2);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [engine, ready, shape, profile, aircraft]);

  /*
   * Whether the flight touches the United States, so a note about American
   * products — NOAA's balloons, its AIRMETs — is shown to the flights it
   * concerns rather than to everyone.
   */
  const [usFlight, setUsFlight] = useState(false);
  const places = [plan.departure, plan.destination, ...plan.route, plan.alternate].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  const placesKey = places.join(' ');
  useEffect(() => {
    if (!engine) return;
    let live = true;
    Promise.all(places.map((id) => engine.airport(id).catch(() => null))).then((found) => {
      if (live) setUsFlight(found.some((a) => a?.country === 'US'));
    });
    return () => {
      live = false;
    };
  }, [engine, placesKey]);

  /** Brief the hour picked in the strip: the same flight, leaving then. */
  function pickHour(departAt: string) {
    setTouched(true);
    setPlan({ ...plan, departureTime: new Date(departAt).toISOString().replace(/\.000Z$/, 'Z') });
  }

  const change = useCallback(<T,>(set: (v: T) => void) => {
    return (v: T) => {
      setTouched(true);
      set(v);
    };
  }, []);

  /** The API path: the server fetches, judges, stores, and can say what changed since last time. */
  async function briefRemotely(flight: FlightPlanInput) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/briefings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan: flight, profile, aircraft, fetch: true }),
      });
      const body = (await res.json()) as (StoredBriefing & { picture?: RoutePicture }) | { error: string };
      if (!res.ok || 'error' in body) throw new Error('error' in body ? body.error : `HTTP ${res.status}`);
      setBriefing(body);
      setPicture(body.picture ?? null);
      // A 404 here just means this is the first briefing of this flight.
      const d = await fetch(`/api/briefings/${body.sha256}/diff`);
      setDiff(d.ok ? ((await d.json()) as BriefingDiff) : null);
      document.getElementById('verdict')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const weather = engine?.weather ?? null;
  const isLive = weather?.mode === 'live';

  /** What the flight being entered still needs before it can be briefed, in words. */
  const draftProblems = draft
    ? [...planProblems(draft), ...((isLive || !DEMO) && departureTimeNote(draft.departureTime)?.blocks ? ['a departure time still to come'] : [])]
    : [];

  function commit() {
    if (!draft || draftProblems.length > 0) return;
    setTouched(true);
    setPlan(draft);
    setDraft(null);
    // The last flight's cards under this flight's name, even for the moment it takes to rebuild, would be the wrong flight.
    setBriefing(null);
    setPicture(null);
    setDiff(null);
    setError(null);
    if (!DEMO) void briefRemotely(draft);
    document.querySelector('main')?.scrollIntoView?.({ block: 'start' });
  }

  const phone = usePhone();
  const attention = attentionOf(briefing);
  const names = useMemo(() => new Map((engine?.aerodromes ?? []).map((a) => [a.id, a.name])), [engine]);
  const nameOf = useCallback((id: string) => names.get(id) ?? null, [names]);

  return (
    <>
      {/* Keyboard and screen reader users should not have to walk the form to reach the answer. */}
      <a className="skip" href="#verdict">
        Skip to the verdict
      </a>
      <header className="masthead">
        <div className="masthead-inner">
          <h1>
            <a className="brand" href={hrefFor({ name: 'home' })}>
              {/* A chart's symbol for an aerodrome with services. */}
              <svg viewBox="0 0 30 30" aria-hidden="true">
                <circle cx="15" cy="15" r="8" fill="none" stroke="currentColor" strokeWidth="3" />
                <path d="M15 2v5M15 23v5M2 15h5M23 15h5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
              <span className="brand-name">Departure Brief</span>
            </a>
          </h1>
          {!phone && <Nav route={route} attention={attention} />}
        </div>
        <p className="disclaimer" role="note">
          <strong>Not for operational use.</strong> A study aid, not an official briefing: get one from an approved source before you fly.
        </p>
      </header>
      <main>

        {route.name === 'brief' && (
          <>
            {DEMO && weather && <WeatherNote weather={weather} usFlight={usFlight} />}

            {/*
              Asked first, in three fields: where from, where to, and when.
              Once a flight has been briefed it is one line above its
              briefing, and the form is one button away.
            */}
            {DEMO && !engine && !error ? (
              // Until the reports are in, there is no telling whether this is a live visit or the recorded flight.
              <p className="explain" role="status">
                {RELAY ? 'Fetching the live reports…' : 'Loading the recorded reports…'}
              </p>
            ) : draft ? (
              <form
                className="inputs plan-card"
                onSubmit={(e) => {
                  e.preventDefault();
                  commit();
                }}
              >
                <h2>{ready ? 'Change the flight' : 'Where are you flying?'}</h2>
                <FlightForm
                  plan={draft}
                  onChange={setDraft}
                  lookup={engine ? engine.airport : DEMO ? untilLoaded : null}
                  aerodromes={engine?.aerodromes ?? []}
                  live={isLive || !DEMO}
                  handbook={performanceFor(aircraft, engine?.performance ?? null)}
                  typedGph={aircraft.cruiseFuelGph}
                />
                <div className="actions">
                  <button type="submit" disabled={draftProblems.length > 0}>
                    Brief this flight
                  </button>
                  {ready && (
                    <button type="button" className="quiet" onClick={() => setDraft(null)}>
                      Cancel
                    </button>
                  )}
                  {draftProblems.length > 0 && <p className="field-note">Still needs {draftProblems.join(', ')}.</p>}
                </div>
              </form>
            ) : (
              <section className="inputs flight-bar">
                <div className="flight-bar-top">
                  <FlightLine plan={plan} aircraft={aircraft} />
                  <button type="button" className="quiet change-flight" onClick={() => setDraft(plan)}>
                    Change flight
                  </button>
                </div>
                <p className="limits-line">
                  Your minimums: ceiling {profile.ceilingAglFt.toLocaleString('en')} ft · visibility {profile.visibilitySm} SM · crosswind {profile.crosswindKt} kt
                  {profile.crosswindIncludesGust ? ' including gusts' : ''} · runway margin {profile.runwayMarginPercent}%
                  {profile.nightAllowed ? '' : ' · day only'} — <a href={hrefFor({ name: 'minimums' })}>change</a>
                </p>
                <div className="actions">
                  {DEMO ? (
                    <>
                      {busy && (
                        <p className="field-note" aria-live="polite">
                          Building the briefing…
                        </p>
                      )}
                      {touched && engine && !isLive && (
                        <button
                          className="quiet"
                          onClick={() => {
                            setPlan(engine.plan);
                            setProfile(engine.profile);
                            setAircraft(engine.aircraft);
                            setTouched(false);
                          }}
                        >
                          Back to the recorded flight
                        </button>
                      )}
                    </>
                  ) : (
                    <button onClick={() => void briefRemotely(plan)} disabled={busy || !ready}>
                      {busy ? 'Fetching and judging…' : 'Brief again'}
                    </button>
                  )}
                  {error && (
                    <p className="error" role="alert">
                      {error}
                    </p>
                  )}
                </div>
              </section>
            )}

            {!draft && diff && <DiffPanel d={diff} />}
            {draft ? null : briefing ? (
              <BriefingView
                stored={briefing}
                picture={picture}
                nameOf={nameOf}
                aerodromes={engine?.aerodromes}
                whenCanIGo={slots.length > 0 ? <WhenCanIGo slots={slots} departure={plan.departureTime} onPick={pickHour} /> : null}
              />
            ) : (
              busy &&
              !DEMO && (
                <p className="explain" role="status">
                  Fetching and judging…
                </p>
              )
            )}
          </>
        )}

        {route.name === 'home' && <StartPage engine={engine} weather={weather} home={plan.departure || null} />}

        {route.name === 'minimums' && (
          <section className="minimums-page">
            <h2>Your minimums</h2>
            <p className="explain">
              Every briefing and field page is checked against these, and against the legal VFR minima separately. They stay in this browser.
            </p>
            <ProfileForm profile={profile} aircraft={aircraft} onProfile={change(setProfile)} onAircraft={change(setAircraft)} />
            {briefing && (
              <p className="field-note" aria-live="polite">
                {busy ? 'Rebuilding the briefing…' : 'The briefing has been rebuilt with these.'} <a href={hrefFor({ name: 'brief' })}>Back to the briefing</a>
              </p>
            )}
          </section>
        )}

        {/*
          The field page compares against the same limits as a briefing, so
          a runway that is inside your crosswind here is inside it there.
        */}
        {route.name === 'aerodrome' && <AerodromePage id={route.id} engine={engine} crosswindLimitKt={profile.crosswindKt ?? null} />}

        {route.name === 'navlog' && <NavLogPage briefing={briefing} />}

        {route.name === 'reports' && <ReportsPage held={engine?.reports ?? []} briefing={briefing} when={DEMO && weather ? weatherPhrase(weather) : null} />}

        {route.name === 'aircraft' && <WbPanel aircraftType={aircraft.type} spec={engine?.wb ?? null} crops={!DEMO} />}

        {route.name === 'about' && <About weather={weather} aerodromes={engine?.aerodromes ?? []} />}

        <footer>
          <p className="footer-tagline">Stop before the line and brief before you cross it.</p>
          <p>
            Departure Brief is a study and planning aid. Nothing here is an official weather briefing, an official weight-and-balance computation, or a substitute
            for either. <a href="https://github.com/nberkyilmaz/departure-brief">Source code</a>. Built by{' '}
            <a href="https://nberkyilmaz.com/">Berk Yilmaz</a>.
          </p>
        </footer>
      </main>
      {phone && <TabBar route={route} attention={attention} />}
    </>
  );
}
