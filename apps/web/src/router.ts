/**
 * Where in the application you are.
 *
 * Hash routing rather than paths, because this is served two ways — from
 * GitHub Pages under a repository prefix, and from the API's own static
 * handler — and a hash needs neither of them configured. A deep link works
 * from either, a reload does not 404, and the back button behaves.
 */
import { useEffect, useState } from 'react';

export const ROUTES = ['brief', 'reports', 'weight', 'about'] as const;
export type Route = (typeof ROUTES)[number];

export const TITLES: Readonly<Record<Route, string>> = {
  brief: 'Brief a flight',
  reports: 'The reports',
  weight: 'Weight and balance',
  about: 'How this works',
};

/** The route a hash names, defaulting to the briefing itself. */
export function parseHash(hash: string): Route {
  const name = hash.replace(/^#\/?/, '').split(/[/?]/)[0]!.toLowerCase();
  return (ROUTES as readonly string[]).includes(name) ? (name as Route) : 'brief';
}

export function hrefFor(route: Route): string {
  return `#/${route}`;
}

/** The current route, kept in step with the address bar in both directions. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseHash(window.location.hash));
      // A new page starts at the top, the way following a link does anywhere else.
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  useEffect(() => {
    document.title = `${TITLES[route]} — Hold Short`;
  }, [route]);
  return route;
}
