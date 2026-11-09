/**
 * The airspace along the route, fetched from the page once a flight is drawn.
 * The briefing never waits for it, and asking again for the same route costs
 * nothing. A route with no part over the United States does not ask at all.
 */
import { AirspaceClient, routeAirspace, type HttpClient } from '@depbrief/core/judge';
import { useEffect, useState } from 'react';
import type { RouteAirspace, RoutePicture } from './types.js';

const TIMEOUT_MS = 15_000;

const http: HttpClient = {
  async get(url, init) {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), ...(init?.headers ? { headers: { ...init.headers } } : {}) });
    return { status: res.status, body: await res.text(), headers: {} };
  },
};

const client = new AirspaceClient(http);
const held = new Map<string, Promise<RouteAirspace>>();

function airspaceOf(picture: RoutePicture, key: string): Promise<RouteAirspace> {
  let pending = held.get(key);
  if (!pending) {
    pending = routeAirspace(client, picture.line, picture.cruiseFt);
    held.set(key, pending);
    // A service that did not answer may answer next time.
    pending.catch(() => held.delete(key));
  }
  return pending;
}

export type AirspaceState = RouteAirspace | 'loading' | 'failed' | 'not-asked';

export function useAirspace(picture: RoutePicture): AirspaceState {
  const [state, setState] = useState<{ key: string; value: AirspaceState }>({ key: '', value: 'loading' });
  const asks = picture.overUS !== 'none';
  const key = `${picture.cruiseFt}|${JSON.stringify(picture.line)}`;
  useEffect(() => {
    if (!asks) return;
    let live = true;
    airspaceOf(picture, key).then(
      (value) => live && setState({ key, value }),
      () => live && setState({ key, value: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, [key, asks]);
  if (!asks) return 'not-asked';
  return state.key === key ? state.value : 'loading';
}
