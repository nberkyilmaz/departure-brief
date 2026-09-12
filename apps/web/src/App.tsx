import { useState } from 'react';
import { BriefingView } from './BriefingView.js';
import { DiffPanel } from './DiffPanel.js';
import { FlightForm, defaultPlan } from './FlightForm.js';
import { ProfileForm, defaultAircraft, defaultProfile } from './ProfileForm.js';
import type { AircraftInput, BriefingDiff, FlightPlanInput, ProfileInput, StoredBriefing } from './types.js';

export function App() {
  const [plan, setPlan] = useState<FlightPlanInput>(defaultPlan);
  const [profile, setProfile] = useState<ProfileInput>(defaultProfile);
  const [aircraft, setAircraft] = useState<AircraftInput>(defaultAircraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<StoredBriefing | null>(null);
  const [diff, setDiff] = useState<BriefingDiff | null>(null);

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
        <strong>Not for operational use.</strong> Hold Short is a study and planning aid, not an official weather briefing.
        Obtain an official briefing from an approved source before any flight.
      </div>
      <main>
        <header>
          <h1>Hold Short</h1>
          <p className="tagline">Stop before the line and brief before you cross it.</p>
        </header>
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
        {diff && <DiffPanel d={diff} />}
        {briefing && <BriefingView stored={briefing} />}
      </main>
    </>
  );
}
