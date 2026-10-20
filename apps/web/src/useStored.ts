import { useEffect, useRef, useState } from 'react';

/**
 * State that survives a reload.
 *
 * Losing a half-entered flight plan to a stray refresh is the kind of small
 * insult that makes a tool feel unfinished, and a pilot planning a flight
 * has better things to retype. Storage is per-browser and never leaves it.
 */
export function useStored<T>(key: string, initial: T): [T, (next: T) => void] {
  const storageKey = `depbrief.${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw === null) return initial;
      // A stored shape from an older version is not worth crashing over.
      return { ...(initial as object), ...(JSON.parse(raw) as object) } as T;
    } catch {
      return initial;
    }
  });

  // Writing on every keystroke is wasteful; a moment after the last one is enough.
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(value));
      } catch {
        // A browser refusing storage is not a reason to stop working.
      }
    }, 300);
    return () => window.clearTimeout(timer.current);
  }, [storageKey, value]);

  return [value, setValue];
}
