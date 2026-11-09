/** Where tapping a station takes you, the same from the map and the side view. */
import { alongRowId, isPosition, type Column } from './picture.js';
import { aerodromeHref } from './router.js';

/** A station's row in the list, opened out of the folds it may be in, and scrolled to. */
function showAlong(station: string): void {
  const row = document.getElementById(alongRowId(station));
  if (!row) return;
  for (let el = row.parentElement; el; el = el.parentElement) if (el instanceof HTMLDetailsElement) el.open = true;
  const own = row.querySelector('details');
  if (own) own.open = true;
  row.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  row.classList.remove('along-found');
  // Forces the highlight to play again when the same row is asked for twice.
  void row.offsetWidth;
  row.classList.add('along-found');
}

/** A position typed as a waypoint has no page and no line in the list. */
export const opens = (c: Column): boolean => c.station.role === 'along' || !isPosition(c.station.id);

export function openColumn(c: Column): void {
  if (c.station.role === 'along') showAlong(c.station.id);
  else if (opens(c)) window.location.hash = aerodromeHref(c.station.id);
}
