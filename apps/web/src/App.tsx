import { useCallback, useEffect, useRef, useState } from 'react';
import { About } from './About.js';
import { BriefingView } from './BriefingView.js';
import { DiffPanel } from './DiffPanel.js';
import { loadEngine, type LocalEngine } from './engine.js';
import { FlightForm, defaultDeparture, defaultPlan, planProblems } from './FlightForm.js';
import { FlightLine } from './FlightLine.js';
import { Nav } from './Nav.js';
import { NavLogPage } from './NavLogPage.js';
import { ProfileForm, defaultAircraft, defaultProfile } from './ProfileForm.js';
import { ReportsPage } from './ReportsPage.js';
import { StartPage } from './StartPage.js';
import { AerodromePage } from './AerodromePage.js';
import { hrefFor, useRoute } from './router.js';
import { useStored } from './useStored.js';
import { WbPanel } from './WbPanel.js';
import { WeatherNote, weatherPhrase } from './WeatherNote.js';
import type { AircraftInput, BriefingDiff, FlightPlanInput, ProfileInput, StoredBriefing } from './types.js';

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
 * How much of the briefing wants reading: the count of lines asking for
 * attention, and the most any of them asks for. A count, never a verdict.
 */
function attentionOf(b: StoredBriefing | null): { level: 'caution' | 'alert'; count: number } | null {
  if (!b) return null;
  const points = [...b.document.briefing.points, ...(b.document.briefing.alternate ? [b.document.briefing.alternate] : [])];
  const wanting = points.flatMap((p) => p.findings.filter((f) => f.attention === 'alert' || f.attention === 'caution'));
  if (wanting.length === 0) return null;
  return { level: wanting.some((f) => f.attention === 'alert') ? 'alert' : 'caution', count: wanting.length };
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
  const [plan, setPlan] = useStored<FlightPlanInput>('plan', defaultPlan);
  const [profile, setProfile] = useStored<ProfileInput>('profile', defaultProfile);
  const [aircraft, setAircraft] = useStored<AircraftInput>('aircraft', defaultAircraft);
  const [busy, setBusy] = useState(DEMO);
  const [error, setError] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<StoredBriefing | null>(null);
  const [diff, setDiff] = useState<BriefingDiff | null>(null);
  /** Set once the visitor has changed something, so the page can stop calling it "recorded". */
  const [touched, setTouched] = useState(false);
  /** Whether the visitor has opened the flight form. With an API behind the page it starts open: there is nothing to show until it is filled in. */
  const [editing, setEditing] = useState(!DEMO);

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
        } else if (!(Date.parse(plan.departureTime) > Date.now())) {
          /*
           * Live, the visitor's own plan stands — except a departure that has
           * already happened, which is what a plan saved last week, or one
           * left over from the recorded flight, will have. Briefing a
           * departure in the past against this morning's weather answers no
           * question anybody asked.
           */
          setPlan({ ...plan, departureTime: defaultDeparture() });
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

  const problems = planProblems(plan);
  const ready = problems.length === 0;

  /*
   * Open the form by itself when the plan cannot be briefed, and leave it
   * open: closing it the moment a typo is fixed would snatch it away from
   * somebody halfway through typing the next field.
   */
  useEffect(() => {
    if (!ready || error !== null) setEditing(true);
  }, [ready, error]);

  /*
   * Rebuild as the form settles. Judging is arithmetic over reports already
   * in memory — a few milliseconds — so there is no reason to make somebody
   * press a button to find out what raising their ceiling minimum does.
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
            setDiff(r.diff);
            setError(null);
          })
          // A NoDataError already says which aerodromes there are reports for.
          .catch((e: Error) => live && setError(e.message))
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

  const change = useCallback(<T,>(set: (v: T) => void) => {
    return (v: T) => {
      setTouched(true);
      set(v);
    };
  }, []);

  /** The API path: the server fetches, judges, stores, and can say what changed since last time. */
  async function briefRemotely() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/briefings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan, profile, aircraft, fetch: true }),
      });
      const body = (await res.json()) as StoredBriefing | { error: string };
      if (!res.ok || 'error' in body) throw new Error('error' in body ? body.error : `HTTP ${res.status}`);
      setBriefing(body);
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

  return (
    <>
      <div className="banner" role="alert">
        <strong>Not for operational use.</strong>{' '}
        <span className="banner-long">
          Departure Brief is a study and planning aid, not an official weather briefing or weight-and-balance computation. Obtain an official briefing from an
          approved source before any flight.
        </span>
        <span className="banner-short">A study aid, not an official briefing.</span>
      </div>
      {/* Keyboard and screen reader users should not have to walk the form to reach the answer. */}
      <a className="skip" href="#verdict">
        Skip to the verdict
      </a>
      <header className="masthead">
        <div className="masthead-inner">
          <div className="brand">
            <span className="sign" aria-hidden="true">
              DB
            </span>
            <div>
              <h1>
                <a href={hrefFor({ name: 'home' })}>Departure Brief</a>
              </h1>
              <p className="tagline">Stop before the line and brief before you cross it.</p>
            </div>
          </div>
          <Nav route={route} attention={attentionOf(briefing)} />
        </div>
      </header>
      <main>

        {route.name === 'brief' && (
          <>
            {DEMO && weather && <WeatherNote weather={weather} />}

            {/*
              The briefing is what a visitor came for, so the flight is one
              line above it and the form that spells it out opens on request —
              or by itself, when the plan is missing something or the last
              change made it impossible to brief.
            */}
            <section className="inputs flight-bar">
              <FlightLine plan={plan} aircraft={aircraft} />
              <p className="limits-line">
                Judged against your minimums: ceiling {profile.ceilingAglFt.toLocaleString('en')} ft · visibility {profile.visibilitySm} SM · crosswind{' '}
                {profile.crosswindKt} kt{profile.crosswindIncludesGust ? ' including gusts' : ''}
                {profile.nightAllowed ? '' : ' · day only'} — <a href={hrefFor({ name: 'minimums' })}>change</a>
              </p>
              <details className="edit-flight" open={editing} onToggle={(e) => setEditing(e.currentTarget.open)}>
                <summary>Edit the flight</summary>
                <FlightForm plan={plan} onChange={change(setPlan)} lookup={engine ? engine.airport : DEMO ? untilLoaded : null} aerodromes={engine?.aerodromes ?? []} />
              </details>
              <div className="actions">
                {DEMO ? (
                  <>
                    <p className="field-note" aria-live="polite">
                      {busy ? 'Rebuilding the briefing…' : briefing ? `Rebuilt from the ${isLive ? 'live' : 'recorded'} reports${touched ? ' with your changes' : ''}.` : ''}
                    </p>
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
                  <>
                    <button onClick={briefRemotely} disabled={busy || !ready}>
                      {busy ? 'Fetching and judging…' : 'Brief this flight'}
                    </button>
                    {!ready && <p className="field-note">Still needs {problems.join(', ')}.</p>}
                  </>
                )}
                {error && (
                  <p className="error" role="alert">
                    {error}
                  </p>
                )}
              </div>
            </section>

            {diff && <DiffPanel d={diff} />}
            {briefing ? (
              <BriefingView stored={briefing} />
            ) : (
              busy && (
                <p className="explain" role="status">
                  {DEMO ? (RELAY ? 'Fetching the live reports…' : 'Loading the recorded reports…') : 'Fetching and judging…'}
                </p>
              )
            )}
          </>
        )}

        {route.name === 'home' && <StartPage engine={engine} weather={weather} home={plan.departure || 'CYSN'} />}

        {route.name === 'minimums' && (
          <section className="minimums-page">
            <h2>Your minimums</h2>
            <p className="explain">
              Every briefing and every field page is checked against these. They are yours, not the regulation's — the regulatory VFR minima are checked
              separately, and both are shown. They are kept in this browser and nowhere else.
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
          <p>
            Departure Brief is a study and planning aid. Nothing here is an official weather briefing, an official weight-and-balance computation, or a substitute
            for either. <a href="https://github.com/nberkyilmaz/departure-brief">Source code</a>. Built by{' '}
            <a href="https://nberkyilmaz.com/">Berk Yilmaz</a>.
          </p>
        </footer>
      </main>
    </>
  );
}
