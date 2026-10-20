import { hrefFor, NAV_ROUTES, sameRoute, titleOf, type Route } from './router.js';
import type { Attention } from './types.js';

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
export function Nav({ route, attention }: { route: Route; attention: { level: Attention; count: number } | null }) {
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
