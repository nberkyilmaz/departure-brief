/**
 * Hand-decoded real TAFs. Reports marked "corpus" are verbatim from
 * test/fixtures/taf (AWC, 2026-09-07).
 */
import { describe, expect, it } from 'vitest';
import { EMPTY_CONDITIONS, type Conditions } from '../../../src/decode/conditions.js';
import { decodeTaf, type TafPeriod } from '../../../src/decode/taf/index.js';
import { at } from '../../helpers/span.js';

const wx = (intensity: string, descriptor: string | null, phenomena: string[], vicinity = false) => ({
  intensity,
  vicinity,
  descriptor,
  phenomena,
});
const kt = (direction: number | 'VRB', speed: number, gust: number | null = null) => ({
  direction,
  speed,
  gust,
  unit: 'KT',
  variableFrom: null,
  variableTo: null,
});
const sm = (miles: number, qualifier: string | null = null) => ({ kind: 'statute', miles, qualifier });
const m = (meters: number) => ({ kind: 'meters', meters, direction: null, minimum: null });
const layer = (amount: string, base: number, type: string | null = null) => ({ kind: 'layer', amount, base, type });
const t = (day: number, hour: number, minute = 0) => ({ day, hour, minute });

function cond(raw: string, c: Partial<Record<keyof Conditions, unknown>>): Conditions {
  return { ...EMPTY_CONDITIONS, ...c } as Conditions;
}

/** Span from the nth occurrence of `a` to the nth occurrence of `b`. */
function range(raw: string, a: string, b: string, na = 0, nb = 0) {
  return { start: at(raw, a, na).start, end: at(raw, b, nb).end };
}

describe('decodeTaf — full reports', () => {
  it('corpus: US TAF with FM and standalone PROB30 periods', () => {
    const raw =
      'TAF KAXN 071142Z 0712/0812 16010KT P6SM SCT006 OVC050 FM071600 16016G24KT P6SM BKN035 PROB30 0720/0723 6SM -RA BR OVC025 FM072300 16017G28KT 5SM -RA BR SCT025 BKN040 PROB30 0803/0806 4SM TSRA OVC025CB FM080600 17017G26KT P6SM BKN040 BKN080 PROB30 0806/0809 5SM -RA BR OVC030';
    const d = decodeTaf(raw);
    expect(d.reportType).toEqual({ value: 'TAF', span: at(raw, 'TAF') });
    expect(d.modifiers).toEqual([]);
    expect(d.station).toEqual({ value: 'KAXN', span: at(raw, 'KAXN') });
    expect(d.issued).toEqual({ value: t(7, 11, 42), span: at(raw, '071142Z') });
    expect(d.validity).toEqual({ value: { from: t(7, 12), to: t(8, 12) }, span: at(raw, '0712/0812') });
    expect(d.status).toBeNull();
    expect(d.temperatures).toEqual([]);
    expect(d.notices).toEqual([]);
    expect(d.remarks).toBeNull();
    expect(d.unparsed).toEqual([]);

    const periods: TafPeriod[] = [
      {
        kind: 'base',
        probability: null,
        indicator: null,
        validity: { value: { from: t(7, 12), to: t(8, 12) }, span: at(raw, '0712/0812') },
        conditions: cond(raw, {
          wind: { value: kt(160, 10), span: at(raw, '16010KT') },
          visibility: { value: sm(6, 'greaterThan'), span: at(raw, 'P6SM', 0) },
          sky: [
            { value: layer('SCT', 600), span: at(raw, 'SCT006') },
            { value: layer('OVC', 5000), span: at(raw, 'OVC050') },
          ],
        }),
        span: range(raw, '16010KT', 'OVC050'),
      },
      {
        kind: 'FM',
        probability: null,
        indicator: { value: 'FM071600', span: at(raw, 'FM071600') },
        validity: { value: { from: t(7, 16), to: null }, span: at(raw, 'FM071600') },
        conditions: cond(raw, {
          wind: { value: kt(160, 16, 24), span: at(raw, '16016G24KT') },
          visibility: { value: sm(6, 'greaterThan'), span: at(raw, 'P6SM', 1) },
          sky: [{ value: layer('BKN', 3500), span: at(raw, 'BKN035') }],
        }),
        span: range(raw, 'FM071600', 'BKN035'),
      },
      {
        kind: 'PROB',
        probability: 30,
        indicator: { value: 'PROB30', span: at(raw, 'PROB30', 0) },
        validity: { value: { from: t(7, 20), to: t(7, 23) }, span: at(raw, '0720/0723') },
        conditions: cond(raw, {
          visibility: { value: sm(6), span: at(raw, '6SM') },
          weather: [
            { value: wx('light', null, ['RA']), span: at(raw, '-RA', 0) },
            { value: wx('moderate', null, ['BR']), span: at(raw, 'BR', 0) },
          ],
          sky: [{ value: layer('OVC', 2500), span: at(raw, 'OVC025') }],
        }),
        span: range(raw, 'PROB30', 'OVC025', 0, 0),
      },
      {
        kind: 'FM',
        probability: null,
        indicator: { value: 'FM072300', span: at(raw, 'FM072300') },
        validity: { value: { from: t(7, 23), to: null }, span: at(raw, 'FM072300') },
        conditions: cond(raw, {
          wind: { value: kt(160, 17, 28), span: at(raw, '16017G28KT') },
          visibility: { value: sm(5), span: at(raw, '5SM', 0) },
          weather: [
            { value: wx('light', null, ['RA']), span: at(raw, '-RA', 1) },
            { value: wx('moderate', null, ['BR']), span: at(raw, 'BR', 1) },
          ],
          sky: [
            { value: layer('SCT', 2500), span: at(raw, 'SCT025') },
            { value: layer('BKN', 4000), span: at(raw, 'BKN040', 0) },
          ],
        }),
        span: range(raw, 'FM072300', 'BKN040', 0, 0),
      },
      {
        kind: 'PROB',
        probability: 30,
        indicator: { value: 'PROB30', span: at(raw, 'PROB30', 1) },
        validity: { value: { from: t(8, 3), to: t(8, 6) }, span: at(raw, '0803/0806') },
        conditions: cond(raw, {
          visibility: { value: sm(4), span: at(raw, '4SM') },
          weather: [{ value: wx('moderate', 'TS', ['RA']), span: at(raw, 'TSRA') }],
          sky: [{ value: layer('OVC', 2500, 'CB'), span: at(raw, 'OVC025CB') }],
        }),
        span: range(raw, 'PROB30', 'OVC025CB', 1, 0),
      },
      {
        kind: 'FM',
        probability: null,
        indicator: { value: 'FM080600', span: at(raw, 'FM080600') },
        validity: { value: { from: t(8, 6), to: null }, span: at(raw, 'FM080600') },
        conditions: cond(raw, {
          wind: { value: kt(170, 17, 26), span: at(raw, '17017G26KT') },
          visibility: { value: sm(6, 'greaterThan'), span: at(raw, 'P6SM', 2) },
          sky: [
            { value: layer('BKN', 4000), span: at(raw, 'BKN040', 1) },
            { value: layer('BKN', 8000), span: at(raw, 'BKN080') },
          ],
        }),
        span: range(raw, 'FM080600', 'BKN080'),
      },
      {
        kind: 'PROB',
        probability: 30,
        indicator: { value: 'PROB30', span: at(raw, 'PROB30', 2) },
        validity: { value: { from: t(8, 6), to: t(8, 9) }, span: at(raw, '0806/0809') },
        conditions: cond(raw, {
          visibility: { value: sm(5), span: at(raw, '5SM', 1) },
          weather: [
            { value: wx('light', null, ['RA']), span: at(raw, '-RA', 2) },
            { value: wx('moderate', null, ['BR']), span: at(raw, 'BR', 2) },
          ],
          sky: [{ value: layer('OVC', 3000), span: at(raw, 'OVC030') }],
        }),
        span: range(raw, 'PROB30', 'OVC030', 2, 0),
      },
    ];
    expect(d.periods).toEqual(periods);
  });

  it('corpus: ICAO TAF with BECMG, PROB30 TEMPO, NSW, metric visibility', () => {
    const raw =
      'TAF EFVA 071135Z 0712/0812 20009KT 9999 SCT035 BECMG 0717/0719 3000 DZ BKN008 BECMG 0719/0721 9999 NSW BKN014 TEMPO 0801/0805 20015G28KT FEW014 SCT070CB TEMPO 0805/0812 20015G28KT 7000 -SHRA BKN008 SCT070CB PROB30 TEMPO 0805/0812 3500 DZ';
    const d = decodeTaf(raw);
    expect(d.periods.map((p) => [p.kind, p.probability])).toEqual([
      ['base', null],
      ['BECMG', null],
      ['BECMG', null],
      ['TEMPO', null],
      ['TEMPO', null],
      ['TEMPO', 30],
    ]);
    expect(d.periods[2]).toEqual({
      kind: 'BECMG',
      probability: null,
      indicator: { value: 'BECMG', span: at(raw, 'BECMG', 1) },
      validity: { value: { from: t(7, 19), to: t(7, 21) }, span: at(raw, '0719/0721') },
      conditions: cond(raw, {
        visibility: { value: m(9999), span: at(raw, '9999', 1) },
        noSignificantWeather: { value: 'NSW', span: at(raw, 'NSW') },
        sky: [{ value: layer('BKN', 1400), span: at(raw, 'BKN014') }],
      }),
      span: range(raw, 'BECMG', 'BKN014', 1, 0),
    });
    expect(d.periods[5]).toEqual({
      kind: 'TEMPO',
      probability: 30,
      indicator: { value: 'PROB30 TEMPO', span: at(raw, 'PROB30 TEMPO') },
      validity: { value: { from: t(8, 5), to: t(8, 12) }, span: at(raw, '0805/0812', 1) },
      conditions: cond(raw, {
        visibility: { value: m(3500), span: at(raw, '3500') },
        weather: [{ value: wx('moderate', null, ['DZ']), span: at(raw, 'DZ', 1) }],
      }),
      span: range(raw, 'PROB30 TEMPO', 'DZ', 0, 1),
    });
    expect(d.unparsed).toEqual([]);
  });

  it('corpus: TX/TN temperatures hoisted, TEMPO inside the base', () => {
    const raw =
      'TAF MMTO 071138Z 0712/0812 08005KT 5SM HZ BKN020 OVC080 TX20/0721Z TN09/0713Z TEMPO 0712/0715 3SM BR -RA BKN010 FM071600 06010KT P6SM SCT020 OVC080 TEMPO 0720/0724 4SM TSRA BKN020CB FM080200 15005KT P6SM SCT020 BKN080';
    const d = decodeTaf(raw);
    expect(d.temperatures).toEqual([
      { value: { kind: 'max', value: 20, at: t(7, 21) }, span: at(raw, 'TX20/0721Z') },
      { value: { kind: 'min', value: 9, at: t(7, 13) }, span: at(raw, 'TN09/0713Z') },
    ]);
    // The base period's span still covers the temperature tokens it contained.
    expect(d.periods[0]?.span).toEqual(range(raw, '08005KT', 'TN09/0713Z'));
    expect(d.periods[0]?.conditions.weather).toEqual([{ value: wx('moderate', null, ['HZ']), span: at(raw, 'HZ') }]);
    expect(d.periods.length).toBe(5);
    expect(d.unparsed).toEqual([]);
  });

  it('corpus: low-level wind shear', () => {
    const raw =
      'TAF KEAR 071137Z 0712/0812 15011KT P6SM FEW013 FM071500 16015G30KT P6SM FEW015 FM080300 16014G24KT P6SM SCT150 WS020/18040KT PROB30 0803/0808 4SM -TSRA BKN240CB FM080800 20009KT P6SM BKN140 WS020/19040KT PROB30 0808/0812 4SM -TSRA OVC025CB';
    const d = decodeTaf(raw);
    expect(d.periods[2]?.conditions.windShear).toEqual({
      value: { height: 2000, wind: kt(180, 40) },
      span: at(raw, 'WS020/18040KT'),
    });
    expect(d.periods[4]?.conditions.windShear?.value).toEqual({ height: 2000, wind: kt(190, 40) });
    expect(d.unparsed).toEqual([]);
  });

  it('corpus: amended military TAF with icing, QNH and negative TN', () => {
    const raw =
      'TAF AMD PASY 071120Z 0711/0812 31012G18KT 4800 -RA BR BKN025 OVC050 620602 QNH2989INS BECMG 0722/0723 24010G15KT 4800 -RA BKN040 620602 QNH2995INS TX12/0803Z TNM06/0714Z';
    const d = decodeTaf(raw);
    expect(d.modifiers).toEqual([{ value: 'AMD', span: at(raw, 'AMD') }]);
    expect(d.station?.value).toBe('PASY');
    expect(d.periods[0]?.conditions.icing).toEqual([
      { value: { type: 2, base: 6000, depth: 2000 }, span: at(raw, '620602', 0) },
    ]);
    expect(d.periods[0]?.conditions.altimeter).toEqual({
      value: { unit: 'inHg', value: 29.89 },
      span: at(raw, 'QNH2989INS'),
    });
    expect(d.periods[1]?.conditions.altimeter?.value).toEqual({ unit: 'inHg', value: 29.95 });
    expect(d.temperatures.map((x) => x.value)).toEqual([
      { kind: 'max', value: 12, at: t(8, 3) },
      { kind: 'min', value: -6, at: t(7, 14) },
    ]);
    expect(d.unparsed).toEqual([]);
  });

  it('corpus: turbulence group', () => {
    const raw = 'TAF KBIF 071100Z 0711/0817 10008KT 9999 FEW080 SCT100 510002 QNH3002INS BECMG 0718/0719 10010G15KT 9999 SCT080 510002 QNH2995INS';
    const d = decodeTaf(raw);
    expect(d.periods[0]?.conditions.turbulence).toEqual([
      { value: { intensity: 1, base: 0, depth: 2000 }, span: at(raw, '510002', 0) },
    ]);
    expect(d.unparsed).toEqual([]);
  });

  it('corpus: Canadian TAF with remarks, fractional visibility, vertical visibility', () => {
    const raw =
      'TAF CYYT 071141Z 0712/0812 15010KT 1/8SM -DZ -SHRA FG VV002 TEMPO 0712/0715 1SM BR OVC004 FM071500 16010KT 1 1/2SM -SHRA BR BKN004 OVC010 RMK NXT FCST BY 071800Z';
    const d = decodeTaf(raw);
    expect(d.periods[0]?.conditions.visibility).toEqual({ value: sm(0.125), span: at(raw, '1/8SM') });
    expect(d.periods[0]?.conditions.sky).toEqual([{ value: { kind: 'verticalVisibility', height: 200 }, span: at(raw, 'VV002') }]);
    expect(d.periods[2]?.conditions.visibility).toEqual({ value: sm(1.5), span: at(raw, '1 1/2SM') });
    expect(d.periods[2]?.span).toEqual(range(raw, 'FM071500', 'OVC010'));
    expect(d.remarks).toEqual({ span: range(raw, 'RMK', '071800Z') });
    expect(d.unparsed.map((u) => [u.text, u.section])).toEqual([
      ['NXT', 'remarks'],
      ['FCST', 'remarks'],
      ['BY', 'remarks'],
      ['071800Z', 'remarks'],
    ]);
  });

  it('corpus: Australian INTER and PROB30 INTER', () => {
    const raw = 'TAF YPDN 071100Z 0712/0818 12010KT 9999 SCT025 INTER 0712/0713 18020G30KT 3000 SHRA BKN015 PROB30 INTER 0800/0806 6000 -TSRA';
    const d = decodeTaf(raw);
    expect(d.periods.map((p) => [p.kind, p.probability, p.indicator?.value ?? null])).toEqual([
      ['base', null, null],
      ['INTER', null, 'INTER'],
      ['INTER', 30, 'PROB30 INTER'],
    ]);
    expect(d.unparsed).toEqual([]);
  });

  it('US amendment notices', () => {
    const raw = 'TAF KXYZ 071100Z 0712/0812 27010KT P6SM SKC FM080000 VRB03KT P6SM SKC AMD NOT SKED AFT 0803Z';
    const d = decodeTaf(raw);
    expect(d.notices).toEqual([
      { value: { kind: 'amendment', text: 'AMD NOT SKED AFT 0803Z' }, span: range(raw, 'AMD', '0803Z') },
    ]);
    expect(d.periods.length).toBe(2);
    expect(d.periods[1]?.span).toEqual(range(raw, 'FM080000', 'SKC', 0, 1));
    expect(d.unparsed).toEqual([]);

    const raw2 = 'TAF KXYZ 071100Z 0712/0812 27010KT P6SM SKC AMD LTD TO CLD VIS AND WIND TIL 0812 RMK TEST';
    const d2 = decodeTaf(raw2);
    expect(d2.notices[0]?.value).toEqual({ kind: 'amendment', text: 'AMD LTD TO CLD VIS AND WIND TIL 0812' });
    expect(d2.remarks).toEqual({ span: range(raw2, 'RMK', 'TEST') });
  });

  it('corpus: military trailer with several notices and temperatures between them', () => {
    const raw =
      'TAF KXYZ 070700Z 0707/0807 VRB06KT 9999 SKC QNH2980INS LAST NO AMDS AFT 0702 NEXT 070800 AUTOMATED SENSOR METWATCH 0708 TIL 0718 TX30/0720Z TN22/0712Z AMD 0712 COR 0713 FS00298';
    const d = decodeTaf(raw);
    expect(d.periods.length).toBe(1);
    expect(d.periods[0]?.span).toEqual(range(raw, 'VRB06KT', 'QNH2980INS'));
    expect(d.notices).toEqual([
      { value: { kind: 'amendment', text: 'LAST NO AMDS AFT 0702 NEXT 070800' }, span: range(raw, 'LAST', '070800') },
      { value: { kind: 'metwatch', text: 'AUTOMATED SENSOR METWATCH 0708 TIL 0718' }, span: range(raw, 'AUTOMATED', '0718') },
      { value: { kind: 'amendment', text: 'AMD 0712' }, span: range(raw, 'AMD', '0712') },
      { value: { kind: 'correction', text: 'COR 0713' }, span: range(raw, 'COR', '0713') },
      { value: { kind: 'forecaster', text: 'FS00298' }, span: at(raw, 'FS00298') },
    ]);
    expect(d.temperatures.map((x) => x.value)).toEqual([
      { kind: 'max', value: 30, at: t(7, 20) },
      { kind: 'min', value: 22, at: t(7, 12) },
    ]);
    expect(d.unparsed).toEqual([]);
  });

  it('corpus: issue time without Z, space-split FM', () => {
    const raw = 'TAF SGME 070924 0712/0812 11006KT CAVOK TX24/0718Z TN08/0710Z BECMG 0718/0721 08005KT 9999 BKN027';
    const d = decodeTaf(raw);
    expect(d.issued).toEqual({ value: t(7, 9, 24), span: at(raw, '070924') });
    expect(d.validity?.value).toEqual({ from: t(7, 12), to: t(8, 12) });
    expect(d.unparsed).toEqual([]);

    const raw2 = 'TAF OPLA 071100Z 0712/0818 24008KT 6000 FEW040 FM 071600 10006KT 4000 FU NSC';
    const d2 = decodeTaf(raw2);
    expect(d2.periods[1]).toMatchObject({
      kind: 'FM',
      indicator: { value: 'FM 071600', span: at(raw2, 'FM 071600') },
      validity: { value: { from: t(7, 16), to: null }, span: at(raw2, 'FM 071600') },
    });
    expect(d2.periods[1]?.conditions.wind?.value).toEqual(kt(100, 6));
    expect(d2.unparsed).toEqual([]);
  });
});

describe('decodeTaf — structure', () => {
  it('a cancelled and a NIL forecast have no periods', () => {
    const cnl = decodeTaf('TAF KXYZ 071100Z 0712/0812 CNL');
    expect(cnl.status?.value).toBe('CNL');
    expect(cnl.periods).toEqual([]);
    expect(cnl.unparsed).toEqual([]);
    const nil = decodeTaf('TAF KXYZ 071100Z NIL');
    expect(nil.status?.value).toBe('NIL');
    expect(nil.validity).toBeNull();
    expect(nil.periods).toEqual([]);
    expect(nil.unparsed).toEqual([]);
  });

  it('accepts a report with no TAF keyword and a COR modifier', () => {
    const d = decodeTaf('TAF COR KXYZ 071100Z 0712/0812 27010KT P6SM SKC');
    expect(d.modifiers.map((x) => x.value)).toEqual(['COR']);
    const e = decodeTaf('KXYZ 071100Z 0712/0812 27010KT P6SM SKC');
    expect(e.reportType).toBeNull();
    expect(e.station?.value).toBe('KXYZ');
    expect(e.periods.length).toBe(1);
  });

  it('a base with no header validity has a null validity', () => {
    const d = decodeTaf('TAF KXYZ 071100Z 27010KT P6SM SKC');
    expect(d.validity).toBeNull();
    expect(d.periods[0]?.validity).toBeNull();
    expect(d.periods[0]?.conditions.wind?.value).toEqual(kt(270, 10));
  });

  it('an indicator without a time group keeps a null validity and still parses conditions', () => {
    const raw = 'TAF KXYZ 071100Z 0712/0812 27010KT P6SM SKC TEMPO VRB05KT 3SM BR';
    const d = decodeTaf(raw);
    expect(d.periods[1]?.validity).toBeNull();
    expect(d.periods[1]?.conditions.wind?.value).toEqual(kt('VRB', 5));
    expect(d.periods[1]?.conditions.visibility?.value).toEqual(sm(3));
    expect(d.unparsed).toEqual([]);
  });

  it('an old-style PROB30 with a 4-digit group is transcribed literally as a visibility', () => {
    const raw = 'TAF OXXX 071100Z 0712/0812 27010KT 9999 SKC PROB30 5000 DU';
    const d = decodeTaf(raw);
    expect(d.periods[1]?.validity).toBeNull();
    expect(d.periods[1]?.conditions.visibility?.value).toEqual(m(5000));
    expect(d.unparsed).toEqual([]);
  });

  it('a malformed FM is unparsed inside the previous period', () => {
    const raw = 'TAF KXYZ 071100Z 0712/0812 27010KT P6SM SKC FM80500 VRB06KT';
    const d = decodeTaf(raw);
    expect(d.periods.length).toBe(1);
    expect(d.unparsed.map((u) => u.text)).toEqual(['FM80500', 'VRB06KT']);
  });

  it('out-of-order groups within a period stay unparsed', () => {
    const raw = 'TAF KXYZ 071100Z 0712/0812 P6SM 27010KT SKC';
    const d = decodeTaf(raw);
    expect(d.periods[0]?.conditions.visibility?.value).toEqual(sm(6, 'greaterThan'));
    expect(d.periods[0]?.conditions.wind).toBeNull();
    expect(d.unparsed.map((u) => u.text)).toEqual(['27010KT']);
  });

  it('never throws and claims every token on garbage input', () => {
    for (const raw of ['', ' ', 'TAF', 'TAF AMD', 'hello world', 'FM071500', 'PROB30', 'PROB30 TEMPO', 'RMK', 'AMD', 'TEMPO RMK', '0712/0812']) {
      const d = decodeTaf(raw);
      expect(d.raw).toBe(raw);
    }
    expect(decodeTaf('hello world').unparsed.map((u) => u.text)).toEqual(['hello', 'world']);
    expect(decodeTaf('PROB30').periods).toEqual([
      { kind: 'PROB', probability: 30, indicator: { value: 'PROB30', span: { start: 0, end: 6 } }, validity: null, conditions: EMPTY_CONDITIONS, span: { start: 0, end: 6 } },
    ]);
  });

  it('is deterministic and JSON round-trippable', () => {
    const raw =
      'TAF AMD PASY 071120Z 0711/0812 31012G18KT 4800 -RA BR BKN025 OVC050 620602 QNH2989INS BECMG 0722/0723 24010G15KT 4800 -RA BKN040 620602 QNH2995INS TX12/0803Z TNM06/0714Z';
    expect(decodeTaf(raw)).toEqual(decodeTaf(raw));
    expect(JSON.parse(JSON.stringify(decodeTaf(raw)))).toEqual(decodeTaf(raw));
  });
});
