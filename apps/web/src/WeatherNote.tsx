/**
 * Where the weather came from and how old it is, said before anything that
 * was judged on it.
 *
 * Live and recorded get the same prominence. Live weather a few minutes old
 * is still a few minutes old, and the age is the thing a pilot needs to
 * weigh it; recorded weather has to say so where nobody can miss it, and if
 * the page tried for live and could not get it, it says that too — a
 * fallback that passes itself off as current is the one thing it must not
 * be.
 */
import type { WeatherSource } from './engine.js';
import { hhmmZ } from './time.js';

/** "05:05Z, 3 min ago": the age is the point, and the clock time lets it be checked. */
export function weatherAge(at: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  return `${hhmmZ(at)}${minutes < 1 ? ', just now' : minutes < 120 ? `, ${minutes} min ago` : ''}`;
}

/** "19 Sep 2026 at 00:52Z". */
export function recordedWhen(at: string): string {
  const d = new Date(at);
  return `${d.toUTCString().slice(5, 16)} at ${hhmmZ(at)}`;
}

/** One phrase for wherever a page mentions the reports in passing. */
export function weatherPhrase(weather: WeatherSource): string {
  return weather.mode === 'live' ? `taken from the weather services at ${weatherAge(weather.at)}` : `recorded on ${recordedWhen(weather.at)}`;
}

export function WeatherNote({ weather }: { weather: WeatherSource }) {
  if (weather.mode === 'live') {
    return (
      <div className="frozen live" role="note">
        <b>Live weather.</b> Every METAR and TAF in Canada and the United States, taken from the weather services at {weatherAge(weather.at)}, and NOTAMs
        fetched for the Canadian aerodromes you brief. The briefing below is built in your browser, by the same code the server runs.
        {weather.missing.length > 0 && <> Not available just now: {weather.missing.join(' and ')}; the briefing says where that matters.</>}
      </div>
    );
  }
  return (
    <div className="frozen" role="note">
      <b>The weather here is frozen.</b>{' '}
      {weather.problem ? (
        <>
          Live weather could not be had — {weather.problem} — so these are the reports recorded on {recordedWhen(weather.at)}, not current ones.
        </>
      ) : (
        <>These are the real reports recorded on {recordedWhen(weather.at)} — this page fetches nothing.</>
      )}{' '}
      Everything else is live: change your minimums, your aircraft, the route or the departure time and the briefing below is rebuilt in your browser, by the
      same code the server runs.
    </div>
  );
}
