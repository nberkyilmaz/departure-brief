import { useEffect, useState } from 'react';
import { About } from './About.js';
import { BriefingView } from './BriefingView.js';
import { DiffPanel } from './DiffPanel.js';
import { FlightForm, defaultPlan } from './FlightForm.js';
import { ProfileForm, defaultAircraft, defaultProfile } from './ProfileForm.js';
import { WbPanel } from './WbPanel.js';
import type { AircraftInput, BriefingDiff, FlightPlanInput, ProfileInput, StoredBriefing } from './types.js';

/**
 * The public build has no API behind it: it shows one briefing, recorded
 * and frozen, from data committed to the repository. That keeps the page
 * free to host, unable to fall over, and — the reason that matters — unable
 * to put load on NAV CANADA or the weather service on behalf of strangers,
 * or to be mistaken for a live briefing by someone about to fly.
 */
const DEMO = import.meta.env.VITE_DEMO === '1';
const base = import.meta.env.BASE_URL;

/** The moment the recorded reports were taken, for the page to say so plainly. */
const RECORDED_AT = '12 September 2026';

export function App() {
  const [plan, setPlan] = useState<FlightPlanInput>(defaultPlan);
  const [profile, setProfile] = useState<ProfileInput>(defaultProfile);
  const [aircraft, setAircraft] = useState<AircraftInput>(defaultAircraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<StoredBriefing | null>(null);
  const [diff, setDiff] = useState<BriefingDiff | null>(null);

  useEffect(() => {
    if (!DEMO) return;
    let live = true;
    setBusy(true);
    fetch(`${base}demo/briefing.json`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`the recorded briefing could not be loaded (HTTP ${r.status})`);
        return (await r.json()) as StoredBriefing;
      })
      .then((b) => {
        if (!live) return;
        setBriefing(b);
        setPlan(b.document.plan);
      })
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, []);

  async function brief() {
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
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="banner" role="alert">
        <strong>Not for operational use.</strong> Hold Short is a study and planning aid, not an official weather briefing or weight-and-balance computation.
        Obtain an official briefing from an approved source before any flight.
      </div>
      <main>
        <header>
          <h1>Hold Short</h1>
          <p className="tagline">Stop before the line and brief before you cross it.</p>
        </header>

        {DEMO ? (
          <>
            <About recordedAt={RECORDED_AT} />
            <div className="frozen" role="note">
              Everything below is a <b>recorded briefing</b>, computed from reports taken on {RECORDED_AT} and frozen. This page fetches no weather and judges
              no flight of yours. To brief a real one, run it yourself — the repository has the instructions.
            </div>
          </>
        ) : (
          <section className="inputs">
            <FlightForm plan={plan} onChange={setPlan} />
            <ProfileForm profile={profile} aircraft={aircraft} onProfile={setProfile} onAircraft={setAircraft} />
            <div className="actions">
              <button onClick={brief} disabled={busy}>
                {busy ? 'Fetching and judging…' : 'Brief this flight'}
              </button>
              {error && <p className="error">{error}</p>}
            </div>
          </section>
        )}

        {DEMO && busy && <p className="explain">Loading the recorded briefing…</p>}
        {DEMO && error && <p className="error">{error}</p>}
        {diff && <DiffPanel d={diff} />}
        {briefing && <BriefingView stored={briefing} />}
        {!DEMO && <WbPanel aircraftType={aircraft.type} />}
      </main>
    </>
  );
}
