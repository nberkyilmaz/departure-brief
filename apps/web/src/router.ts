/**
 * Where in the application you are.
 *
 * Hash routing rather than paths, because this is served two ways — from
 * GitHub Pages under a repository prefix, and from the API's own static
 * handler — and a hash needs neither of them configured. A deep link works
 * from either, a reload does not 404, and the back button behaves.
 *
 * A route is a value rather than a string, because one of them carries an
 * aerodrome identifier and the old "first segment wins" parser silently
 * resolved `#/aerodrome/CYSN` to the briefing page. Sending a bad deep link
 * somewhere that looks like it worked is the one routing behaviour that
 * actively misleads, and these are the addresses people paste to each other.
 */
import { useEffect, useRef, useState } from 'react';

export type Route =
  | { readonly name: 'home' }
  | { readonly name: 'brief' }
  | { readonly name: 'aerodrome'; readonly id: string }
  | { readonly name: 'navlog' }
  | { readonly name: 'aircraft' }
  | { readonly name: 'minimums' }
  | { readonly name: 'reports' }
  | { readonly name: 'about' };

export type RouteName = Route['name'];

/** The sections that appear in the navigation, in order. */
export const NAV_ROUTES: readonly Route[] = [
  { name: 'brief' },
  { name: 'navlog' },
  { name: 'aircraft' },
  { name: 'minimums' },
  { name: 'reports' },
  { name: 'about' },
];

const TITLES: Readonly<Record<RouteName, string>> = {
  home: 'Hold Short',
  brief: 'Brief a flight',
  aerodrome: 'Aerodrome',
  navlog: 'Nav log',
  aircraft: 'Aircraft',
  minimums: 'Your minimums',
  reports: 'The reports',
  about: 'How this works',
};

/** What to call a route in the navigation and the browser tab. */
export function titleOf(route: Route): string {
  return route.name === 'aerodrome' ? route.id : TITLES[route.name];
}

export function hrefFor(route: Route): string {
  return route.name === 'aerodrome' ? `#/aerodrome/${route.id}` : route.name === 'home' ? '#/' : `#/${route.name}`;
}

/** The address of one field, from an identifier alone. */
export function aerodromeHref(id: string): string {
  return `#/aerodrome/${id.trim().toUpperCase()}`;
}

/**
 * The route a hash names. An identifier is carried through exactly as
 * given — parsing never rejects one, because the page can say far more
 * about what went wrong than a redirect can.
 */
export function parseHash(hash: string): Route {
  const [first = '', second = ''] = hash
    .replace(/^#\/?/, '')
    .split('?')[0]!
    .split('/');
  const name = first.toLowerCase();
  if (name === 'aerodrome' || name === 'airport') return { name: 'aerodrome', id: decodeURIComponent(second).trim().toUpperCase() };
  // `#/weight` was the loading sheet's own page before it merged into the
  // aircraft one. Links to it exist; they still work.
  if (name === 'weight') return { name: 'aircraft' };
  if (name === '' ) return { name: 'home' };
  const known = (['brief', 'navlog', 'aircraft', 'minimums', 'reports', 'about'] as const).find((r) => r === name);
  return known ? { name: known } : { name: 'home' };
}

export const sameRoute = (a: Route, b: Route): boolean => hrefFor(a) === hrefFor(b);

/** The current route, kept in step with the address bar in both directions. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const current = useRef(route);
  current.current = route;

  useEffect(() => {
    const onChange = () => {
      const next = parseHash(window.location.hash);
      // Compared by value: every hashchange would otherwise re-render.
      if (!sameRoute(next, current.current)) {
        setRoute(next);
        // A new page starts at the top, the way following a link does anywhere else.
        window.scrollTo({ top: 0 });
      }
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  useEffect(() => {
    document.title = `${titleOf(route)} — Hold Short`;
  }, [route]);

  return route;
}
