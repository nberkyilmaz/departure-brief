import { hhmmZ } from './time.js';
import type { StoredBriefing } from './types.js';

/**
 * The flight as a strip: every point in order, what it came out as, when
 * you are there, and how far it is from the last one.
 *
 * The findings below say why. This says where — which is the thing a list
 * of findings is worst at, because a briefing that reads "marginal,
 * marginal, go" tells you nothing about whether the trouble is at the
 * departure end or waiting at the far end two hours later.
 *
 * It is built only from what the briefing already says. Nothing here is a
 * new judgement; the colours are the verdicts and the distances are the
 * cumulative ones the resolver worked out.
 */
export function RouteStrip({ stored }: { stored: StoredBriefing }) {
  const b = stored.document.briefing;
  const inputs = stored.document.inputs.points;
  const byWaypoint = new Map(inputs.map((p) => [`${p.waypoint}${p.eta}`, p]));

  const legs = b.points.map((point, i) => {
    const input = byWaypoint.get(`${point.waypoint}${point.at}`) ?? null;
    const previous = i > 0 ? (byWaypoint.get(`${b.points[i - 1]!.waypoint}${b.points[i - 1]!.at}`) ?? null) : null;
    const from = input && previous ? Math.round(input.cumulativeNm - previous.cumulativeNm) : null;
    return { point, fromPrevious: from, label: null as string | null };
  });
  if (b.alternate) {
    // The alternate's inputs are kept apart from the route's, because it is
    // not a leg of the flight — it is where the flight goes instead.
    const input = stored.document.inputs.alternate;
    const last = byWaypoint.get(`${b.points[b.points.length - 1]!.waypoint}${b.points[b.points.length - 1]!.at}`) ?? null;
    legs.push({
      point: b.alternate,
      fromPrevious: input && last ? Math.round(input.cumulativeNm - last.cumulativeNm) : null,
      label: 'alternate',
    });
  }

  return (
    <ol className="strip" aria-label="The route, and the verdict at each point">
      {legs.map(({ point, fromPrevious, label }) => (
        <li key={point.waypoint + point.at} className={`strip-point ${point.verdict}`}>
          {fromPrevious !== null && <span className="strip-leg">{fromPrevious} nm</span>}
          <a href={`#verdict`} className="strip-body">
            <span className="strip-id">
              {label && <span className="strip-label">{label} </span>}
              {point.waypoint}
            </span>
            <span className="strip-time">
              {hhmmZ(point.at)}
              {point.night && <span className="night">night</span>}
            </span>
            <span className={`verdict ${point.verdict}`}>{point.verdict.toUpperCase()}</span>
          </a>
        </li>
      ))}
    </ol>
  );
}
