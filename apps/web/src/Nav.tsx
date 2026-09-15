import { hrefFor, ROUTES, TITLES, type Route } from './router.js';
import type { Attention } from './types.js';

/**
 * The four things this does, and the answer to the one that matters.
 *
 * What most wants reading rides along in the navigation, so somebody who
 * has wandered off to the loading sheet still knows the briefing had
 * something in it, and gets back in one tap. It is a count, not a verdict:
 * "two things to look at", never "do not go".
 */
export function Nav({ route, attention }: { route: Route; attention: { level: Attention; count: number } | null }) {
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
      {attention && route !== 'brief' && (
        <a className={`nav-attention ${attention.level}`} href={hrefFor('brief')}>
          {attention.count} to look at
        </a>
      )}
    </nav>
  );
}
