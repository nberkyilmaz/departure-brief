import { useEffect, useState, type ReactNode } from 'react';
import { hrefFor, NAV_ROUTES, sameRoute, titleOf, type Route } from './router.js';
import type { Attention } from './types.js';

type Waiting = { level: Attention; count: number } | null;

/** The width the stylesheet changes the layout at: the bar under the thumb below it, the masthead's row above. */
const PHONE = '(max-width: 40rem)';

/** Whether the page is laid out for a phone, followed as the window is turned or resized. One navigation is drawn, never both. */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia?.(PHONE).matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.(PHONE);
    if (!query) return;
    const follow = () => setPhone(query.matches);
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, []);
  return phone;
}

const icon = (path: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);

/** The four the thumb goes to most, each with a mark a pilot would recognise, and the rest under More. */
const TABS: readonly { route: Route; label: string; icon: ReactNode }[] = [
  {
    route: { name: 'brief' },
    label: 'Brief',
    icon: icon(
      <>
        <path d="M2 16l20-8" />
        <path d="M6 14.5l-2-5 2-.8 3 3" />
        <path d="M14 11.3l-4-7 2-.7 6 6" />
        <path d="M3 21h18" />
      </>,
    ),
  },
  {
    route: { name: 'navlog' },
    label: 'Nav log',
    icon: icon(
      <>
        <path d="M4 4h16v16H4z" />
        <path d="M4 9h16M4 14h16M10 4v16" />
      </>,
    ),
  },
  {
    route: { name: 'aircraft' },
    label: 'Aircraft',
    icon: icon(
      <>
        <path d="M12 3v18" />
        <path d="M3 11l9-2 9 2" />
        <path d="M9 20h6" />
      </>,
    ),
  },
  {
    route: { name: 'minimums' },
    label: 'Minimums',
    icon: icon(
      <>
        <path d="M4 6h10M4 12h4M12 12h8M4 18h12" />
        <circle cx="16" cy="6" r="2" />
        <circle cx="10" cy="12" r="2" />
        <circle cx="18" cy="18" r="2" />
      </>,
    ),
  },
];

/**
 * On a phone, the sections in a bar under the thumb, where the masthead's
 * row would otherwise wrap onto two lines above every page. What is
 * waiting on the briefing rides on its tab.
 */
export function TabBar({ route, attention }: { route: Route; attention: Waiting }) {
  const rest: Route[] = [...NAV_ROUTES.filter((r) => !TABS.some((t) => sameRoute(t.route, r))), ...(route.name === 'aerodrome' ? [route] : [])];
  const inRest = rest.some((r) => sameRoute(r, route));
  return (
    <nav className="tabbar" aria-label="Sections">
      {TABS.map((t) => (
        <a key={t.label} className="tab" href={hrefFor(t.route)} aria-current={sameRoute(t.route, route) ? 'page' : undefined}>
          {t.icon}
          {t.label}
          {t.route.name === 'brief' && attention && route.name !== 'brief' && (
            <span className={`tab-count ${attention.level}`} aria-label={`${attention.count} to look at`}>
              {attention.count}
            </span>
          )}
        </a>
      ))}
      <details className={inRest ? 'here' : undefined}>
        <summary>
          {icon(
            <>
              <circle cx="5" cy="12" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="19" cy="12" r="1.5" />
            </>,
          )}
          More
        </summary>
        <ul>
          {rest.map((r) => (
            <li key={hrefFor(r)}>
              <a href={hrefFor(r)} aria-current={sameRoute(r, route) ? 'page' : undefined}>
                {titleOf(r)}
              </a>
            </li>
          ))}
        </ul>
      </details>
    </nav>
  );
}

/**
 * The sections, and what is waiting on the briefing page.
 *
 * What most wants reading rides along so somebody who has wandered off to
 * the loading sheet still knows the briefing had something in it, and gets
 * back in one tap. It is a count, not a verdict: "two things to look at",
 * never "do not go".
 *
 * A field's own page is not in this list — there are sixteen hundred of
 * them, and they are reached from the route, from a search, or from a link.
 * When you are on one, it appears at the end so the navigation still says
 * where you are.
 */
export function Nav({ route, attention }: { route: Route; attention: Waiting }) {
  const sections = route.name === 'aerodrome' ? [...NAV_ROUTES, route] : NAV_ROUTES;
  return (
    <nav className="nav" aria-label="Sections">
      <ul>
        {sections.map((r) => (
          <li key={hrefFor(r)}>
            <a href={hrefFor(r)} aria-current={sameRoute(r, route) ? 'page' : undefined}>
              {titleOf(r)}
            </a>
          </li>
        ))}
      </ul>
      {attention && route.name !== 'brief' && (
        <a className={`nav-attention ${attention.level}`} href={hrefFor({ name: 'brief' })}>
          {attention.count} to look at
        </a>
      )}
    </nav>
  );
}
