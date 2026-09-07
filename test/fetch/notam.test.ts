/**
 * Only the request shape is tested: no credentials were available to record
 * a real response, and fixtures are never fabricated. Response handling is
 * exercised once a recording exists (docs/plan.md step 2).
 */
import { describe, expect, it } from 'vitest';
import { FAA_NOTAM_BASE_URL, FaaNotamClient } from '../../src/fetch/notam.js';
import { replayHttp } from '../helpers/http.js';

const creds = { clientId: 'id-123', clientSecret: 'secret-456' };

describe('FaaNotamClient', () => {
  it('builds the documented page URL', () => {
    const c = new FaaNotamClient(replayHttp({}), creds);
    expect(c.pageUrl('kjfk', 2, 25)).toBe(`${FAA_NOTAM_BASE_URL}?icaoLocation=KJFK&responseFormat=geoJson&pageSize=25&pageNum=2`);
    expect(() => c.pageUrl('bad id', 1)).toThrow('invalid ICAO location');
  });

  it('sends credentials as headers and stops at the last page', async () => {
    const page = (pageNum: number) =>
      JSON.stringify({ pageSize: 1, pageNum, totalCount: 2, totalPages: 2, items: [{ properties: { coreNOTAMData: { notam: { location: 'JFK', issued: '2026-09-07T10:00:00.000Z' } } }, page: pageNum }] });
    const http = replayHttp({
      [`${FAA_NOTAM_BASE_URL}?icaoLocation=KJFK&responseFormat=geoJson&pageSize=1&pageNum=1`]: { status: 200, body: page(1) },
      [`${FAA_NOTAM_BASE_URL}?icaoLocation=KJFK&responseFormat=geoJson&pageSize=1&pageNum=2`]: { status: 200, body: page(2) },
    });
    const { requests, reports } = await new FaaNotamClient(http, creds).byLocation('KJFK', { pageSize: 1 });
    expect(requests.length).toBe(2);
    expect(http.calls.every((c) => c.init?.headers?.client_id === 'id-123' && c.init?.headers?.client_secret === 'secret-456')).toBe(true);
    expect(reports.map((r) => [r.kind, r.source, r.station, r.issuedAt?.toISOString()])).toEqual([
      ['notam', 'faa-notam', 'JFK', '2026-09-07T10:00:00.000Z'],
      ['notam', 'faa-notam', 'JFK', '2026-09-07T10:00:00.000Z'],
    ]);
    expect(JSON.parse(reports[1]!.body).page).toBe(2);
    expect(reports[0]!.sha256).not.toBe(reports[1]!.sha256);
  });

  it('never loops past maxPages', async () => {
    const endless = JSON.stringify({ totalPages: 999, items: [{ a: 1 }] });
    const routes: Record<string, { status: number; body: string }> = {};
    for (let p = 1; p <= 3; p++) routes[`${FAA_NOTAM_BASE_URL}?icaoLocation=KJFK&responseFormat=geoJson&pageSize=50&pageNum=${p}`] = { status: 200, body: endless };
    const { requests } = await new FaaNotamClient(replayHttp(routes), creds).byLocation('KJFK', { maxPages: 3 });
    expect(requests.length).toBe(3);
  });
});
