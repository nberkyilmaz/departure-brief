import { useEffect, useId, useState } from 'react';

export interface Airport {
  icaoId: string | null;
  faaId: string | null;
  name: string;
  city: string | null;
  country: string | null;
  runways?: { id: string }[];
}

/** Answers what the tool knows about an identifier. `null` for one it does not. */
export type AirportLookup = (code: string) => Promise<Airport | null>;

/** The API's answer, for builds that have one behind them. */
export const lookupViaApi: AirportLookup = async (code) => {
  const r = await fetch(`/api/airports/${encodeURIComponent(code)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()) as Airport;
};

type Lookup = { state: 'empty' } | { state: 'short' } | { state: 'looking' } | { state: 'found'; airport: Airport } | { state: 'missing' } | { state: 'offline' };

const cache = new Map<string, Airport | null>();

/**
 * An aerodrome identifier that tells you straight away whether the tool
 * knows the place.
 *
 * Typing four letters and finding out only after a briefing that the field
 * is not in the data is the single most annoying way this can waste
 * somebody's time, and it is entirely avoidable: the airport store is one
 * request away.
 */
export function AerodromeField({
  label,
  value,
  onChange,
  lookup = lookupViaApi,
  optional = false,
  hint,
  listId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** Where to ask; the local engine answers from the reports the page carries. */
  lookup?: AirportLookup;
  optional?: boolean;
  hint?: string;
  /** A datalist of identifiers there is data for, when that set is small and known. */
  listId?: string | undefined;
}) {
  const id = useId();
  const [state, setState] = useState<Lookup>({ state: 'empty' });
  const code = value.trim().toUpperCase();

  useEffect(() => {
    if (code === '') {
      setState({ state: 'empty' });
      return;
    }
    if (code.length < 3) {
      setState({ state: 'short' });
      return;
    }
    if (cache.has(code)) {
      const hit = cache.get(code)!;
      setState(hit ? { state: 'found', airport: hit } : { state: 'missing' });
      return;
    }
    let live = true;
    setState({ state: 'looking' });
    // A pause, so a request is not sent for every letter of "CYSN".
    const t = window.setTimeout(() => {
      lookup(code)
        .then((a) => {
          cache.set(code, a);
          if (live) setState(a ? { state: 'found', airport: a } : { state: 'missing' });
        })
        .catch(() => live && setState({ state: 'offline' }));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [code, lookup]);

  const describe = () => {
    switch (state.state) {
      case 'found': {
        const a = state.airport;
        const where = [a.city, a.country].filter(Boolean).join(', ');
        const runways = a.runways?.length ? ` · ${a.runways.length} runway${a.runways.length === 1 ? '' : 's'}` : '';
        return <span className="field-ok">{`${a.name}${where ? ` — ${where}` : ''}${runways}`}</span>;
      }
      case 'missing':
        return <span className="field-bad">not in the data behind this page — check the identifier</span>;
      case 'looking':
        return <span className="field-note">looking…</span>;
      case 'offline':
        return <span className="field-note">cannot check identifiers right now</span>;
      case 'short':
        return <span className="field-note">three or four characters</span>;
      case 'empty':
        return optional ? <span className="field-note">{hint ?? 'optional'}</span> : <span className="field-note">{hint ?? 'required'}</span>;
    }
  };

  return (
    <label htmlFor={id} className="aerodrome">
      {label}
      <input
        id={id}
        value={value}
        inputMode="text"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        maxLength={4}
        placeholder="CYSN"
        list={listId}
        aria-invalid={state.state === 'missing'}
        aria-describedby={`${id}-note`}
        onChange={(e) => onChange(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
      />
      <span id={`${id}-note`} className="field-note-line">
        {describe()}
      </span>
    </label>
  );
}
