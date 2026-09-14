import { hrefFor, ROUTES, TITLES, type Route } from './router.js';
import type { Verdict } from './types.js';

/**
 * The four things this does, and the answer to the one that matters.
 *
 * The verdict rides along in the navigation once there is one, so that a
 * reader who has wandered off to the raw reports or the loading sheet can
 * still see what the flight came out as, and get back to it in one tap.
 */
export function Nav({ route, verdict }: { route: Route; verdict: Verdict | null }) {
  return (
    <nav className="nav" aria-label="Sections">
      <ul>
        {ROUTES.map((r) => (
          <li key={r}>
            <a href={hrefFor(r)} aria-current={r === route ? 'page' : undefined}>
              {TITLES[r]}
            </a>
          </li>
        ))}
      </ul>
      {verdict && route !== 'brief' && (
        <a className={`verdict nav-verdict ${verdict}`} href={hrefFor('brief')}>
          {verdict.toUpperCase()}
        </a>
      )}
    </nav>
  );
}
