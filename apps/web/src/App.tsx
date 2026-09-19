import { useCallback, useEffect, useRef, useState } from 'react';
import { About } from './About.js';
import { BriefingView } from './BriefingView.js';
import { DiffPanel } from './DiffPanel.js';
import { loadEngine, type LocalEngine } from './engine.js';
import { FlightForm, defaultPlan, planProblems } from './FlightForm.js';
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
import type { AircraftInput, BriefingDiff, FlightPlanInput, ProfileInput, StoredBriefing } from './types.js';

/**
 * Two ways to brief, one form.
 *
 * With an API behind it, the form briefs a flight happening now: the server
 * fetches what it needs and judges it. The published build has no server, so
 * it carries the reports themselves and judges them here, in the page. The
 * pipeline is the same code either way — what differs is only where the
 * reports come from and how old they are.
 */
const DEMO = import.meta.env.VITE_DEMO === '1';
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

  useEffect(() => {
    if (!DEMO) return;
    let live = true;
    loadEngine(base)
      .then((e) => {
        if (!live) return;
        setEngine(e);
        /*
         * Start from the flight the reports cover. A form that defaults to
         * two hours from now is right when a server can fetch for that time
         * and useless here, where the weather is frozen: every point would
         * say "no forecast covers this" and nothing a visitor changed would
         * make any difference.
         */
        setPlan(e.plan);
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

  const recorded = engine ? new Date(engine.recordedAt) : null;
  const recordedText = recorded
    ? `${recorded.toUTCString().slice(5, 16)} at ${String(recorded.getUTCHours()).padStart(2, '0')}:${String(recorded.getUTCMinutes()).padStart(2, '0')}Z`
    : '';

  return (
    <>
      <div className="banner" role="alert">
        <strong>Not for operational use.</strong> Departure Brief is a study and planning aid, not an official weather briefing or weight-and-balance computation.
        Obtain an official briefing from an approved source before any flight.
      </div>
      {/* Keyboard and screen reader users should not have to walk the form to reach the answer. */}
      <a className="skip" href="#verdict">
        Skip to the verdict
      </a>
      <main>
        <header>
          <h1>
            <a href={hrefFor({ name: 'brief' })}>Departure Brief</a>
          </h1>
          <p className="tagline">Stop before the line and brief before you cross it.</p>
          <Nav route={route} attention={attentionOf(briefing)} />
        </header>

        {route.name === 'brief' && (
          <>
            {DEMO && (
              <div className="frozen" role="note">
                <b>The weather here is frozen.</b> These are the real reports{' '}
                {engine ? `for ${engine.aerodromes.map((a) => a.id).join(', ')}, taken on ${recordedText}` : 'as recorded'} — this page fetches nothing.
                Everything else is live: change your minimums, your aircraft, the route or the departure time and the briefing below is rebuilt in your
                browser, by the same code the server runs.
              </div>
            )}

            <FlightLine plan={plan} aircraft={aircraft} />

            <section className="inputs">
              <FlightForm plan={plan} onChange={change(setPlan)} lookup={engine ? engine.airport : null} aerodromes={engine?.aerodromes ?? []} />
              <ProfileForm profile={profile} aircraft={aircraft} onProfile={change(setProfile)} onAircraft={change(setAircraft)} />
              <div className="actions">
                {DEMO ? (
                  <>
                    <p className="field-note" aria-live="polite">
                      {busy ? 'Rebuilding the briefing…' : briefing ? `Rebuilt from the recorded reports${touched ? ' with your changes' : ''}.` : ''}
                    </p>
                    {touched && engine && (
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
                  {DEMO ? 'Loading the recorded reports…' : 'Fetching and judging…'}
                </p>
              )
            )}
          </>
        )}

        {route.name === 'home' && <StartPage engine={engine} recordedAt={recordedText} home={plan.departure || 'CYSN'} />}

        {route.name === 'aerodrome' && <AerodromePage id={route.id} engine={engine} />}

        {route.name === 'navlog' && <NavLogPage briefing={briefing} />}

        {route.name === 'reports' && <ReportsPage held={engine?.reports ?? []} briefing={briefing} recordedAt={DEMO ? recordedText : null} />}

        {route.name === 'aircraft' && <WbPanel aircraftType={aircraft.type} spec={engine?.wb ?? null} crops={!DEMO} />}

        {route.name === 'about' && <About recordedAt={recordedText} aerodromes={engine?.aerodromes ?? []} />}

        <footer>
          <p>
            Departure Brief is a study and planning aid. Nothing here is an official weather briefing, an official weight-and-balance computation, or a substitute
            for either. <a href="https://github.com/nberkyilmaz/departure-brief">Source and work log</a>.
          </p>
        </footer>
      </main>
    </>
  );
}
