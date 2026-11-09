/**
 * The ground under the route, fetched from the page once a flight is drawn.
 * The briefing never waits for it, and asking again for the same route (a
 * different hour, a changed minimum) costs nothing.
 */
import { ElevationClient, routeTerrain, type HttpClient } from '@depbrief/core/judge';
import { useEffect, useState } from 'react';
import type { RoutePicture, RouteTerrain } from './types.js';

const TIMEOUT_MS = 12_000;

const http: HttpClient = {
  async get(url, init) {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), ...(init?.headers ? { headers: { ...init.headers } } : {}) });
    return { status: res.status, body: await res.text(), headers: {} };
  },
};

const client = new ElevationClient(http);
const held = new Map<string, Promise<RouteTerrain>>();

function terrainOf(line: RoutePicture['line']): Promise<RouteTerrain> {
  const key = JSON.stringify(line);
  let pending = held.get(key);
  if (!pending) {
    pending = routeTerrain(client, line);
    held.set(key, pending);
    // A service that did not answer may answer next time.
    pending.catch(() => held.delete(key));
  }
  return pending;
}

export type TerrainState = RouteTerrain | 'loading' | 'failed';

export function useTerrain(picture: RoutePicture): TerrainState {
  const [state, setState] = useState<{ key: string; value: TerrainState }>({ key: '', value: 'loading' });
  const key = JSON.stringify(picture.line);
  useEffect(() => {
    let live = true;
    terrainOf(picture.line).then(
      (value) => live && setState({ key, value }),
      () => live && setState({ key, value: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, [key]);
  return state.key === key ? state.value : 'loading';
}
