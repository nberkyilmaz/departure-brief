import { useState } from 'react';
import type { LocalEngine, WeatherSource } from './engine.js';
import { aerodromeHref, hrefFor } from './router.js';
import { recordedWhen, weatherAge } from './WeatherNote.js';

/**
 * What a visitor meets.
 *
 * Not a form. Most arrivals want one of two things — to look up a field, or
 * to see what this is — and being handed a flight plan to fill in before
 * either is possible is the reason people leave.
 */
export function StartPage({ engine, weather, home }: { engine: LocalEngine | null; weather: WeatherSource | null; home: string }) {
  const [id, setId] = useState('');
  const code = id.trim().toUpperCase();
  const known = engine?.aerodromes.filter((a) => a.id.startsWith(code) || a.name.toUpperCase().includes(code)).slice(0, 8) ?? [];

  return (
    <section className="start">
      <p className="lede">
        Everything a pilot looks at before a flight, in one place, with the report behind every line. It does not decide whether to fly — that is yours. It
        makes sure nothing you needed was missed.
      </p>

      <form
        className="start-search"
        onSubmit={(e) => {
          e.preventDefault();
          if (code !== '') window.location.hash = aerodromeHref(code);
        }}
      >
        <label>
          Look up an aerodrome
          <input
            value={id}
            onChange={(e) => setId(e.target.value.replace(/[^A-Za-z0-9 ]/g, ''))}
            placeholder="CYSN, Toronto, KIAG…"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <button type="submit" disabled={code === ''}>
          Go
        </button>
      </form>

      {code !== '' && known.length > 0 && (
        <ul className="start-matches">
          {known.map((a) => (
            <li key={a.id}>
              <a href={aerodromeHref(a.id)}>{a.id}</a> <span className="muted">{a.name}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="start-links">
        <a className="start-card" href={aerodromeHref(home)}>
          <b>{home}</b>
          <span className="muted">your home field</span>
        </a>
        <a className="start-card" href={hrefFor({ name: 'brief' })}>
          <b>Brief a flight</b>
          <span className="muted">route, times, your minimums</span>
        </a>
        <a className="start-card" href={hrefFor({ name: 'about' })}>
          <b>How this works</b>
          <span className="muted">and how far to trust it</span>
        </a>
      </div>

      {weather?.mode === 'live' && (
        <p className="field-note">
          The weather here is live: every METAR and TAF in the country, taken from the weather services at {weatherAge(weather.at)}. The whole pipeline runs in
          your browser.
        </p>
      )}
      {weather?.mode === 'recorded' && (
        <p className="field-note">
          The reports here were recorded on {recordedWhen(weather.at)} and are frozen
          {weather.problem ? `, because live weather could not be had: ${weather.problem}` : ': this page fetches nothing'}. Everything else is live — the
          whole pipeline runs in your browser.
        </p>
      )}
    </section>
  );
}
