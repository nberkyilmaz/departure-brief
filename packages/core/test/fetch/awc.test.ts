/**
 * The AWC client against responses recorded from the live API on 2026-09-07
 * (test/fixtures/fetch/awc). No network.
 */
import { describe, expect, it } from 'vitest';
import { decodeMetar } from '../../src/decode/metar/index.js';
import { decodeTaf } from '../../src/decode/taf/index.js';
import { AWC_BASE_URL, AwcClient, AwcError } from '../../src/fetch/awc.js';
import { HttpError } from '../../src/fetch/http.js';
import { replayHttp } from '../helpers/http.js';

const routes = {
  [`${AWC_BASE_URL}/metar?ids=KJFK,KTEB,KHPN&format=json`]: { status: 200, file: 'awc/metar-KJFK-KTEB-KHPN.json' },
  [`${AWC_BASE_URL}/metar?ids=KJFK&format=json&hours=6`]: { status: 200, file: 'awc/metar-KJFK-6h.json' },
  [`${AWC_BASE_URL}/metar?ids=KZZZ&format=json`]: { status: 204, file: 'awc/metar-unknown-station.json' },
  [`${AWC_BASE_URL}/taf?ids=KJFK,KTEB,KHPN&format=json`]: { status: 200, file: 'awc/taf-KJFK-KTEB-KHPN.json' },
  [`${AWC_BASE_URL}/taf?ids=KHPN&format=json`]: { status: 200, file: 'awc/taf-KHPN.json' },
  [`${AWC_BASE_URL}/metar?ids=KDWN&format=json`]: { status: 503, body: 'upstream down' },
  [`${AWC_BASE_URL}/metar?ids=KBAD&format=json`]: { status: 200, body: '<html>not json</html>' },
  [`${AWC_BASE_URL}/metar?ids=KOBJ&format=json`]: { status: 200, body: '{"not":"an array"}' },
  [`${AWC_BASE_URL}/metar?ids=KMIS&format=json`]: { status: 200, body: '[{"icaoId":"KMIS"}]' },
};

describe('AwcClient.metars', () => {
  it('maps each record to a verbatim raw report with station, observation time and upstream metadata', async () => {
    const http = replayHttp(routes);
    const { request, reports } = await new AwcClient(http).metars(['kjfk', 'KTEB', ' khpn ']);
    expect(request).toBe(`${AWC_BASE_URL}/metar?ids=KJFK,KTEB,KHPN&format=json`);
    // The API does not return stations in request order.
    expect(reports.map((r) => r.station).sort()).toEqual(['KHPN', 'KJFK', 'KTEB']);
    const jfk = reports.find((r) => r.station === 'KJFK')!;
    expect(jfk.kind).toBe('metar');
    expect(jfk.source).toBe('awc');
    expect(jfk.body).toBe('METAR KJFK 071151Z 34007KT 10SM CLR 19/11 A3015 RMK AO2 SLP210 T01890106 10194 20156 53020 $');
    expect(jfk.issuedAt?.toISOString()).toBe('2026-09-07T11:51:00.000Z');
    expect(jfk.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((jfk.upstream as { receiptTime: string }).receiptTime).toBe('2026-09-07T11:54:08.892Z');
    // The body decodes to the station the API said it is for.
    for (const r of reports) expect(decodeMetar(r.body).station?.value).toBe(r.station);
  });

  it('returns several hours of history when asked', async () => {
    const { reports } = await new AwcClient(replayHttp(routes)).metars(['KJFK'], { hours: 6 });
    expect(reports.length).toBeGreaterThan(1);
    expect(new Set(reports.map((r) => r.sha256)).size).toBe(reports.length);
    const times = reports.map((r) => r.issuedAt!.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('treats 204 No Content (unknown station) as no reports', async () => {
    expect((await new AwcClient(replayHttp(routes)).metars(['KZZZ'])).reports).toEqual([]);
  });

  it('rejects bad identifiers before making a request', async () => {
    const http = replayHttp(routes);
    await expect(new AwcClient(http).metars([])).rejects.toThrow('at least one station');
    await expect(new AwcClient(http).metars(['not a station'])).rejects.toThrow();
    expect(http.calls).toEqual([]);
  });

  it('surfaces upstream failures and malformed bodies as errors, never as empty data', async () => {
    const c = new AwcClient(replayHttp(routes));
    await expect(c.metars(['KDWN'])).rejects.toThrow(HttpError);
    await expect(c.metars(['KBAD'])).rejects.toThrow(AwcError);
    await expect(c.metars(['KOBJ'])).rejects.toThrow(AwcError);
    await expect(c.metars(['KMIS'])).rejects.toThrow(AwcError);
  });
});

describe('AwcClient.tafs', () => {
  it('maps each record to a verbatim raw report with issue time', async () => {
    const { request, reports } = await new AwcClient(replayHttp(routes)).tafs(['KJFK', 'KTEB', 'KHPN']);
    expect(request).toBe(`${AWC_BASE_URL}/taf?ids=KJFK,KTEB,KHPN&format=json`);
    expect(reports.every((r) => r.kind === 'taf')).toBe(true);
    expect(reports.map((r) => r.station).sort()).toEqual(['KHPN', 'KJFK', 'KTEB']);
    const jfk = reports.find((r) => r.station === 'KJFK')!;
    expect(jfk.body.startsWith('TAF KJFK 071138Z 0712/0818 ')).toBe(true);
    expect(jfk.issuedAt?.toISOString()).toBe('2026-09-07T11:38:00.000Z');
    for (const r of reports) {
      const d = decodeTaf(r.body);
      expect(d.station?.value).toBe(r.station);
      expect(d.unparsed).toEqual([]);
    }
  });

  it('a single-station TAF with an amendment notice', async () => {
    const { reports } = await new AwcClient(replayHttp(routes)).tafs(['KHPN']);
    const d = decodeTaf(reports[0]!.body);
    expect(d.notices.map((n) => n.value.text)).toEqual(['AMD NOT SKED']);
  });
});
