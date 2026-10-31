import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { AerodromeSearch } from './search.js';

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

type Lookup = { state: 'empty' } | { state: 'looking' } | { state: 'found'; airport: Airport } | { state: 'missing' } | { state: 'offline' };

const cache = new Map<string, Airport | null>();
const looksLikeCode = (s: string) => /^[A-Z0-9]{3,4}$/.test(s);

/**
 * An aerodrome, found by whatever somebody remembers of it: the ICAO code,
 * the FAA one, or part of the name.
 *
 * The value is always an identifier the page knows, or empty. Text that does
 * not yet name one field leaves it empty, so a half-typed "CYK" can never be
 * briefed as if it were a place. Under the box it says what was found, or
 * why nothing was, before any briefing is asked for.
 *
 * Without the page's own list of aerodromes (a build with an API behind it)
 * it takes an identifier as typed and asks the API about it.
 */
export function AerodromeField({
  label,
  value,
  onChange,
  lookup = lookupViaApi,
  optional = false,
  hint,
  search,
}: {
  label: string;
  /** The identifier chosen, or empty. */
  value: string;
  onChange: (id: string) => void;
  /** Where to ask what an identifier is; the local engine answers from the data the page carries. */
  lookup?: AirportLookup;
  optional?: boolean;
  hint?: string;
  /** The page's own search, when it carries the aerodromes. */
  search?: AerodromeSearch | undefined;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [state, setState] = useState<Lookup>({ state: 'empty' });
  /** The last value this field sent, so a change from outside (a swap, a reset) can be told from its own echo. */
  const sent = useRef(value);

  useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      setText(value);
    }
  }, [value]);

  const emit = (next: string) => {
    sent.current = next;
    if (next !== value) onChange(next);
  };

  const query = text.trim();
  const matches = search && open && query.length >= 2 && query.toUpperCase() !== value ? search(query, 6) : [];
  const showList = matches.length > 0;

  const type = (raw: string) => {
    setText(raw);
    setOpen(true);
    setActive(0);
    const code = raw.trim().toUpperCase();
    if (!search) {
      emit(looksLikeCode(code) ? code : '');
      return;
    }
    // Typing a whole identifier picks it; anything else waits for a choice.
    const exact = search(code, 1)[0];
    emit(exact && (exact.id === code || exact.faaId === code) ? exact.id : '');
  };

  const pick = (chosen: string) => {
    setText(chosen);
    setOpen(false);
    emit(chosen);
  };

  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && matches.length > 0) {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp' && matches.length > 0) {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && showList) {
      // Choosing from the list, not submitting the form around it.
      e.preventDefault();
      pick(matches[Math.min(active, matches.length - 1)]!.id);
    } else if (e.key === 'Escape' && showList) {
      e.preventDefault();
      setOpen(false);
    }
  };

  useEffect(() => {
    if (value === '') {
      setState({ state: 'empty' });
      return;
    }
    if (cache.has(value)) {
      const hit = cache.get(value)!;
      setState(hit ? { state: 'found', airport: hit } : { state: 'missing' });
      return;
    }
    let live = true;
    setState({ state: 'looking' });
    // A pause, so a request is not sent for every letter of "CYSN".
    const t = window.setTimeout(() => {
      lookup(value)
        .then((a) => {
          cache.set(value, a);
          if (live) setState(a ? { state: 'found', airport: a } : { state: 'missing' });
        })
        .catch(() => live && setState({ state: 'offline' }));
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [value, lookup]);

  const describe = () => {
    if (value === '' && query !== '') {
      if (!search) return <span className="field-note">three or four letters or digits</span>;
      return search(query, 1).length > 0 ? (
        <span className="field-note">pick one from the list</span>
      ) : (
        <span className="field-bad">no aerodrome in Canada or the US matches “{query}”</span>
      );
    }
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
      case 'empty':
        return <span className="field-note">{hint ?? (optional ? 'optional' : 'code or name')}</span>;
    }
  };

  return (
    <div className="aerodrome">
      <label htmlFor={id}>{label}</label>
      <div className="combo">
        <input
          id={id}
          value={text}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? `${listId}-${active}` : undefined}
          aria-invalid={state.state === 'missing'}
          aria-describedby={`${id}-note`}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder={search ? 'CYSN or St. Catharines' : 'CYSN'}
          onChange={(e) => type(e.target.value)}
          onKeyDown={keys}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            // "mia" picked KMIA; say so in the box.
            if (value !== '' && text !== value) setText(value);
          }}
        />
        {showList && (
          <ul id={listId} role="listbox" aria-label={`${label} suggestions`} className="combo-list">
            {matches.map((a, i) => (
              <li
                key={a.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'active' : undefined}
                // Before the input's blur, so the choice is not lost to it.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(a.id);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <b>{a.id}</b>
                {a.faaId && <span className="muted"> {a.faaId}</span>} <span className="combo-name">{a.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <span id={`${id}-note`} className="field-note-line">
        {describe()}
      </span>
    </div>
  );
}
