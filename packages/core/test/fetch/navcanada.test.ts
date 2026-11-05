import { describe, expect, it } from 'vitest';
import { decodeNotam } from '../../src/notam/decode.js';
import { NAVCANADA_CFPS_BASE_URL, NavCanadaClient, NavCanadaError } from '../../src/fetch/navcanada.js';
import { replayHttp } from '../helpers/http.js';

const routes = {
  [`${NAVCANADA_CFPS_BASE_URL}?site=CYSN&alpha=notam`]: { status: 200, file: '../notam/navcanada/2026-09-12/CYSN.json' },
  [`${NAVCANADA_CFPS_BASE_URL}?site=CYKF&alpha=notam`]: { status: 200, file: '../notam/navcanada/2026-09-12/CYKF.json' },
  [`${NAVCANADA_CFPS_BASE_URL}?site=CBAD&alpha=notam`]: { status: 200, body: '{"meta":{}}' },
  [`${NAVCANADA_CFPS_BASE_URL}?site=CTXT&alpha=notam`]: { status: 200, body: '{"data":[{"type":"notam","pk":1,"text":"not json"}]}' },
  [`${NAVCANADA_CFPS_BASE_URL}?site=CDWN&alpha=notam`]: { status: 503, body: 'down' },
};

describe('NavCanadaClient.notams', () => {
  it('maps every CFPS record to a verbatim raw NOTAM with its site and start time', async () => {
    const http = replayHttp(routes);
    const { request, reports } = await new NavCanadaClient(http).notams('cysn');
    expect(request).toBe(`${NAVCANADA_CFPS_BASE_URL}?site=CYSN&alpha=notam`);
    expect(http.calls[0]?.init?.headers?.Accept).toBe('application/json');
    expect(reports).toHaveLength(10);
    for (const r of reports) {
      expect(r.kind).toBe('notam');
      expect(r.source).toBe('navcanada-cfps');
      expect(r.body.startsWith('(')).toBe(true);
      expect(decodeNotam(r.body).id).not.toBeNull();
    }
    const closure = reports.find((r) => r.body.includes('RWY 11/29 CLSD'))!;
    expect(closure.station).toBe('CYSN');
    expect(closure.issuedAt?.toISOString()).toBe('2026-07-27T13:13:00.000Z');
    const firWide = reports.find((r) => r.body.startsWith('(G3263/26'))!;
    expect(firWide.station).toBeNull();
  });

  it('the same FIR-wide NOTAM fetched via two sites has the same content hash', async () => {
    const c = new NavCanadaClient(replayHttp(routes));
    const a = (await c.notams('CYSN')).reports.find((r) => r.body.startsWith('(G3263/26'))!;
    const b = (await c.notams('CYKF')).reports.find((r) => r.body.startsWith('(G3263/26'))!;
    expect(a.sha256).toBe(b.sha256);
  });

  it('fails loudly on a changed shape rather than returning empty data', async () => {
    const c = new NavCanadaClient(replayHttp(routes));
    await expect(c.notams('CBAD')).rejects.toThrow(NavCanadaError);
    await expect(c.notams('CTXT')).rejects.toThrow(NavCanadaError);
    await expect(c.notams('CDWN')).rejects.toThrow('HTTP 503');
    await expect(c.notams('not a site')).rejects.toThrow('invalid site');
  });
});

describe('NavCanadaClient.upperWinds', () => {
  /*
   * Recorded on 5 November 2026. CYEI is a point in NAV CANADA's winds
   * bulletin but not an aerodrome CFPS knows, and asking for it alongside
   * Toronto and Val-d'Or empties the answer for all three.
   */
  const refused = `${NAVCANADA_CFPS_BASE_URL}?site=CYEI&site=CYYZ&site=CYVO&alpha=upperwind`;
  const without = `${NAVCANADA_CFPS_BASE_URL}?site=CYYZ&site=CYVO&alpha=upperwind`;
  const recorded = {
    [refused]: { status: 200, file: 'navcanada/upperwind/2026-11-05/refused-CYEI-CYYZ-CYVO.json' },
    [without]: { status: 200, file: 'navcanada/upperwind/2026-11-05/CYYZ-CYVO.json' },
  };

  it('asks again without a site the service does not know, rather than losing every site', async () => {
    const http = replayHttp(recorded);
    const { request, reports } = await new NavCanadaClient(http).upperWinds(['CYEI', 'CYYZ', 'CYVO']);
    expect(http.calls.map((c) => c.url)).toEqual([refused, without]);
    expect(request).toBe(without);
    expect([...new Set(reports.map((r) => r.station))].sort()).toEqual(['CYVO', 'CYYZ']);
  });

  it('treats a refusal it cannot get around as a failure, not as a country with no winds', async () => {
    const http = replayHttp({ [`${NAVCANADA_CFPS_BASE_URL}?site=CYEI&alpha=upperwind`]: { status: 200, file: 'navcanada/upperwind/2026-11-05/refused-CYEI.json' } });
    await expect(new NavCanadaClient(http).upperWinds(['CYEI'])).rejects.toThrow(/refused: alpha\.geomInvalid/);
  });
});
