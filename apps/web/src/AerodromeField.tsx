import { useEffect, useId, useState } from 'react';

interface Airport {
  icaoId: string | null;
  faaId: string | null;
  name: string;
  city: string | null;
  country: string | null;
  runways?: { id: string }[];
}

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
  optional = false,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  optional?: boolean;
  hint?: string;
}) {
  const id = useId();
  const [lookup, setLookup] = useState<Lookup>({ state: 'empty' });
  const code = value.trim().toUpperCase();

  useEffect(() => {
    if (code === '') {
      setLookup({ state: 'empty' });
      return;
    }
    if (code.length < 3) {
      setLookup({ state: 'short' });
      return;
    }
    if (cache.has(code)) {
      const hit = cache.get(code)!;
      setLookup(hit ? { state: 'found', airport: hit } : { state: 'missing' });
      return;
    }
    let live = true;
    setLookup({ state: 'looking' });
    // A pause, so a request is not sent for every letter of "CYSN".
    const t = window.setTimeout(() => {
      fetch(`/api/airports/${encodeURIComponent(code)}`)
        .then(async (r) => {
          if (r.status === 404) return null;
          if (!r.ok) throw new Error(String(r.status));
          return (await r.json()) as Airport;
        })
        .then((a) => {
          cache.set(code, a);
          if (live) setLookup(a ? { state: 'found', airport: a } : { state: 'missing' });
        })
        .catch(() => live && setLookup({ state: 'offline' }));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [code]);

  const describe = () => {
    switch (lookup.state) {
      case 'found': {
        const a = lookup.airport;
        const where = [a.city, a.country].filter(Boolean).join(', ');
        const runways = a.runways?.length ? ` · ${a.runways.length} runway${a.runways.length === 1 ? '' : 's'}` : '';
        return <span className="field-ok">{`${a.name}${where ? ` — ${where}` : ''}${runways}`}</span>;
      }
      case 'missing':
        return <span className="field-bad">not in the airport data — check the identifier, or load a cycle that has it</span>;
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
        aria-invalid={lookup.state === 'missing'}
        aria-describedby={`${id}-note`}
        onChange={(e) => onChange(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
      />
      <span id={`${id}-note`} className="field-note-line">
        {describe()}
      </span>
    </label>
  );
}
