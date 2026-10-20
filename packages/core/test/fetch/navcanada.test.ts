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
