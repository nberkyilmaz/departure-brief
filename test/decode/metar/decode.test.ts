/**
 * Hand-decoded real reports. Each case asserts the complete decoded object,
 * so every field — including the nulls and empties — is checked against the
 * expectation. When a decoder bug is found, the fix comes with a case here.
 *
 * Reports marked "corpus" are verbatim from test/fixtures/metar (AWC, 2026-09-07).
 */
import { describe, expect, it } from 'vitest';
import { EMPTY_CONDITIONS } from "../../../src/decode/conditions.js";
import { decodeMetar, type DecodedMetar } from '../../../src/decode/metar/index.js';
import { at } from '../../helpers/span.js';

const trend = (indicator: string, conditions: Record<string, unknown>, times: Partial<Record<'from' | 'until' | 'at', unknown>> = {}) => ({
  indicator,
  from: null,
  until: null,
  at: null,
  ...times,
  conditions: { ...EMPTY_CONDITIONS, ...conditions },
});

const none = (intensity: string, descriptor: string | null, phenomena: string[], vicinity = false) => ({
  intensity,
  vicinity,
  descriptor,
  phenomena,
});

/** An expectation skeleton with every field empty; cases spread over it. */
function empty(raw: string): DecodedMetar {
  return {
    raw,
    reportType: null,
    station: null,
    time: null,
    modifiers: [],
    wind: null,
    visibility: null,
    rvr: [],
    weather: [],
    sky: [],
    temperature: null,
    altimeter: null,
    altimeterAlternate: null,
    recentWeather: [],
    windShear: [],
    runwayState: [],
    trends: [],
    remarks: null,
    unparsed: [],
  };
}

function remarksSpan(raw: string) {
  return { start: raw.indexOf(' RMK') + 1, end: raw.length };
}

describe('decodeMetar — full reports', () => {
  it('the onboarding example, with a T group', () => {
    const raw = 'METAR KJFK 141851Z 28016G24KT 10SM FEW045 SCT250 09/M04 A3012 RMK AO2 SLP198 T00941044';
    expect(decodeMetar(raw)).toEqual({
      ...empty(raw),
      reportType: { value: 'METAR', span: at(raw, 'METAR') },
      station: { value: 'KJFK', span: at(raw, 'KJFK') },
      time: { value: { day: 14, hour: 18, minute: 51 }, span: at(raw, '141851Z') },
      wind: {
        value: { direction: 280, speed: 16, gust: 24, unit: 'KT', variableFrom: null, variableTo: null },
        span: at(raw, '28016G24KT'),
      },
      visibility: { value: { kind: 'statute', miles: 10, qualifier: null }, span: at(raw, '10SM') },
      sky: [
        { value: { kind: 'layer', amount: 'FEW', base: 4500, type: null }, span: at(raw, 'FEW045') },
        { value: { kind: 'layer', amount: 'SCT', base: 25000, type: null }, span: at(raw, 'SCT250') },
      ],
      temperature: { value: { temperature: 9, dewpoint: -4 }, span: at(raw, '09/M04') },
      altimeter: { value: { unit: 'inHg', value: 30.12 }, span: at(raw, 'A3012') },
      remarks: {
        span: remarksSpan(raw),
        items: [
          { value: { kind: 'automatedStationType', type: 'AO2', augmented: false }, span: at(raw, 'AO2') },
          { value: { kind: 'seaLevelPressure', pressure: 1019.8 }, span: at(raw, 'SLP198') },
          { value: { kind: 'preciseTemperature', temperature: 9.4, dewpoint: -4.4 }, span: at(raw, 'T00941044') },
        ],
      },
    });
  });

  it('corpus: fog, RVR range, vertical visibility, maintenance flag', () => {
    const raw = 'SPECI KHIO 071104Z AUTO 00000KT 1/4SM R13R/0800V1800FT FG VV001 10/10 A3013 RMK AO2 T01000100 $';
    expect(decodeMetar(raw)).toEqual({
      ...empty(raw),
      reportType: { value: 'SPECI', span: at(raw, 'SPECI') },
      station: { value: 'KHIO', span: at(raw, 'KHIO') },
      time: { value: { day: 7, hour: 11, minute: 4 }, span: at(raw, '071104Z') },
      modifiers: [{ value: 'AUTO', span: at(raw, 'AUTO') }],
      wind: {
        value: { direction: 0, speed: 0, gust: null, unit: 'KT', variableFrom: null, variableTo: null },
        span: at(raw, '00000KT'),
      },
      visibility: { value: { kind: 'statute', miles: 0.25, qualifier: null }, span: at(raw, '1/4SM') },
      rvr: [
        {
          value: {
            runway: '13R',
            low: { value: 800, qualifier: null },
            high: { value: 1800, qualifier: null },
            unit: 'FT',
            trend: null,
          },
          span: at(raw, 'R13R/0800V1800FT'),
        },
      ],
      weather: [{ value: none('moderate', null, ['FG']), span: at(raw, 'FG') }],
      sky: [{ value: { kind: 'verticalVisibility', height: 100 }, span: at(raw, 'VV001') }],
      temperature: { value: { temperature: 10, dewpoint: 10 }, span: at(raw, '10/10') },
      altimeter: { value: { unit: 'inHg', value: 30.13 }, span: at(raw, 'A3013') },
      remarks: {
        span: remarksSpan(raw),
        items: [
          { value: { kind: 'automatedStationType', type: 'AO2', augmented: false }, span: at(raw, 'AO2') },
          { value: { kind: 'preciseTemperature', temperature: 10, dewpoint: 10 }, span: at(raw, 'T01000100') },
          { value: { kind: 'maintenanceNeeded' }, span: at(raw, '$') },
        ],
      },
    });
  });

  it('corpus: two-token visibility, RVR with P qualifier, sensor status', () => {
    const raw = 'SPECI PAOT 071104Z AUTO 08004KT 1 1/4SM R09/5000VP6000FT BR FEW001 OVC065 08/08 A2980 RMK AO2 T00780078 TSNO $';
    expect(decodeMetar(raw)).toEqual({
      ...empty(raw),
      reportType: { value: 'SPECI', span: at(raw, 'SPECI') },
      station: { value: 'PAOT', span: at(raw, 'PAOT') },
      time: { value: { day: 7, hour: 11, minute: 4 }, span: at(raw, '071104Z') },
      modifiers: [{ value: 'AUTO', span: at(raw, 'AUTO') }],
      wind: {
        value: { direction: 80, speed: 4, gust: null, unit: 'KT', variableFrom: null, variableTo: null },
        span: at(raw, '08004KT'),
      },
      visibility: { value: { kind: 'statute', miles: 1.25, qualifier: null }, span: at(raw, '1 1/4SM') },
      rvr: [
        {
          value: {
            runway: '09',
            low: { value: 5000, qualifier: null },
            high: { value: 6000, qualifier: 'greaterThan' },
            unit: 'FT',
            trend: null,
          },
          span: at(raw, 'R09/5000VP6000FT'),
        },
      ],
      weather: [{ value: none('moderate', null, ['BR']), span: at(raw, 'BR') }],
      sky: [
        { value: { kind: 'layer', amount: 'FEW', base: 100, type: null }, span: at(raw, 'FEW001') },
        { value: { kind: 'layer', amount: 'OVC', base: 6500, type: null }, span: at(raw, 'OVC065') },
      ],
      temperature: { value: { temperature: 8, dewpoint: 8 }, span: at(raw, '08/08') },
      altimeter: { value: { unit: 'inHg', value: 29.8 }, span: at(raw, 'A2980') },
      remarks: {
        span: remarksSpan(raw),
        items: [
          { value: { kind: 'automatedStationType', type: 'AO2', augmented: false }, span: at(raw, 'AO2') },
          { value: { kind: 'preciseTemperature', temperature: 7.8, dewpoint: 7.8 }, span: at(raw, 'T00780078') },
          { value: { kind: 'sensorStatus', sensor: 'TSNO', location: null }, span: at(raw, 'TSNO') },
          { value: { kind: 'maintenanceNeeded' }, span: at(raw, '$') },
        ],
      },
    });
  });

  it('corpus: MPS wind with variation, metric visibility, CB, hPa, runway state, NOSIG', () => {
    const raw = 'SPECI URRP 071103Z 31007G12MPS 280V340 9999 -SHRA FEW022CB 20/11 Q1014 R23/CLRD70 NOSIG RMK QNH761 QFE753/1004';
    expect(decodeMetar(raw)).toEqual({
      ...empty(raw),
      reportType: { value: 'SPECI', span: at(raw, 'SPECI') },
      station: { value: 'URRP', span: at(raw, 'URRP') },
      time: { value: { day: 7, hour: 11, minute: 3 }, span: at(raw, '071103Z') },
      wind: {
        value: { direction: 310, speed: 7, gust: 12, unit: 'MPS', variableFrom: 280, variableTo: 340 },
        span: at(raw, '31007G12MPS 280V340'),
      },
      visibility: { value: { kind: 'meters', meters: 9999, direction: null, minimum: null }, span: at(raw, '9999') },
      weather: [{ value: none('light', 'SH', ['RA']), span: at(raw, '-SHRA') }],
      sky: [{ value: { kind: 'layer', amount: 'FEW', base: 2200, type: 'CB' }, span: at(raw, 'FEW022CB') }],
      temperature: { value: { temperature: 20, dewpoint: 11 }, span: at(raw, '20/11') },
      altimeter: { value: { unit: 'hPa', value: 1014 }, span: at(raw, 'Q1014') },
      runwayState: [
        {
          value: { runway: '23', closed: false, cleared: true, deposit: null, extent: null, depth: null, friction: 70 },
          span: at(raw, 'R23/CLRD70'),
        },
      ],
      trends: [{ value: trend('NOSIG', {}), span: at(raw, 'NOSIG') }],
      remarks: { span: remarksSpan(raw), items: [] },
      unparsed: [
        { text: 'QNH761', span: at(raw, 'QNH761'), section: 'remarks' },
        { text: 'QFE753/1004', span: at(raw, 'QFE753/1004'), section: 'remarks' },
      ],
    });
  });

  it('corpus: thunderstorm, distant lightning with AND, timing, trace precipitation', () => {
    const raw = 'SPECI KPIR 071107Z AUTO 15007KT 10SM -TSRA FEW009 SCT050 BKN110 21/20 A2987 RMK AO2 LTG DSNT W AND NW TSB01 P0000 T02060200';
    expect(decodeMetar(raw)).toEqual({
      ...empty(raw),
      reportType: { value: 'SPECI', span: at(raw, 'SPECI') },
      station: { value: 'KPIR', span: at(raw, 'KPIR') },
      time: { value: { day: 7, hour: 11, minute: 7 }, span: at(raw, '071107Z') },
      modifiers: [{ value: 'AUTO', span: at(raw, 'AUTO') }],
      wind: {
        value: { direction: 150, speed: 7, gust: null, unit: 'KT', variableFrom: null, variableTo: null },
        span: at(raw, '15007KT'),
      },
      visibility: { value: { kind: 'statute', miles: 10, qualifier: null }, span: at(raw, '10SM') },
      weather: [{ value: none('light', 'TS', ['RA']), span: at(raw, '-TSRA') }],
      sky: [
        { value: { kind: 'layer', amount: 'FEW', base: 900, type: null }, span: at(raw, 'FEW009') },
        { value: { kind: 'layer', amount: 'SCT', base: 5000, type: null }, span: at(raw, 'SCT050') },
        { value: { kind: 'layer', amount: 'BKN', base: 11000, type: null }, span: at(raw, 'BKN110') },
      ],
      temperature: { value: { temperature: 21, dewpoint: 20 }, span: at(raw, '21/20') },
      altimeter: { value: { unit: 'inHg', value: 29.87 }, span: at(raw, 'A2987') },
      remarks: {
        span: remarksSpan(raw),
        items: [
          { value: { kind: 'automatedStationType', type: 'AO2', augmented: false }, span: at(raw, 'AO2') },
          {
            value: { kind: 'lightning', frequency: null, types: [], distant: true, locations: ['W', 'NW'], movement: null },
            span: at(raw, 'LTG DSNT W AND NW'),
          },
          {
            value: {
              kind: 'weatherTiming',
              events: [{ weather: none('moderate', 'TS', []), event: 'began', time: { hour: null, minute: 1 } }],
            },
            span: at(raw, 'TSB01'),
          },
          { value: { kind: 'precipitation', period: 'hourly', inches: 0, trace: true }, span: at(raw, 'P0000') },
          { value: { kind: 'preciseTemperature', temperature: 20.6, dewpoint: 20 }, span: at(raw, 'T02060200') },
        ],
      },
    });
  });

  it('corpus: bare TS, chained timing groups', () => {
    const raw = 'SPECI K1ON 071104Z AUTO 08005KT 10SM TS FEW049 OVC120 20/19 A2988 RMK AO2 RAE04 TSE1055TSB1056 SLP117 $';
    const m = decodeMetar(raw);
    expect(m.weather).toEqual([{ value: none('moderate', 'TS', []), span: at(raw, 'TS') }]);
    expect(m.remarks?.items).toEqual([
      { value: { kind: 'automatedStationType', type: 'AO2', augmented: false }, span: at(raw, 'AO2') },
      {
        value: {
          kind: 'weatherTiming',
          events: [{ weather: none('moderate', null, ['RA']), event: 'ended', time: { hour: null, minute: 4 } }],
        },
        span: at(raw, 'RAE04'),
      },
      {
        value: {
          kind: 'weatherTiming',
          events: [
            { weather: none('moderate', 'TS', []), event: 'ended', time: { hour: 10, minute: 55 } },
            { weather: none('moderate', 'TS', []), event: 'began', time: { hour: 10, minute: 56 } },
          ],
        },
        span: at(raw, 'TSE1055TSB1056'),
      },
      { value: { kind: 'seaLevelPressure', pressure: 1011.7 }, span: at(raw, 'SLP117') },
      { value: { kind: 'maintenanceNeeded' }, span: at(raw, '$') },
    ]);
    expect(m.unparsed).toEqual([]);
  });

  it('corpus: ICAO wind shear, runway state, TEMPO trend section, no remarks', () => {
    const raw = 'METAR UUWW 071100Z 31007MPS 9999 BKN046 12/05 Q1013 WS R24 R24/000062 TEMPO 32008G15MPS';
    expect(decodeMetar(raw)).toEqual({
      ...empty(raw),
      reportType: { value: 'METAR', span: at(raw, 'METAR') },
      station: { value: 'UUWW', span: at(raw, 'UUWW') },
      time: { value: { day: 7, hour: 11, minute: 0 }, span: at(raw, '071100Z') },
      wind: {
        value: { direction: 310, speed: 7, gust: null, unit: 'MPS', variableFrom: null, variableTo: null },
        span: at(raw, '31007MPS'),
      },
      visibility: { value: { kind: 'meters', meters: 9999, direction: null, minimum: null }, span: at(raw, '9999') },
      sky: [{ value: { kind: 'layer', amount: 'BKN', base: 4600, type: null }, span: at(raw, 'BKN046') }],
      temperature: { value: { temperature: 12, dewpoint: 5 }, span: at(raw, '12/05') },
      altimeter: { value: { unit: 'hPa', value: 1013 }, span: at(raw, 'Q1013') },
      windShear: [{ value: { runway: '24' }, span: at(raw, 'WS R24') }],
      runwayState: [
        {
          value: { runway: '24', closed: false, cleared: false, deposit: 0, extent: 0, depth: 0, friction: 62 },
          span: at(raw, 'R24/000062'),
        },
      ],
      trends: [
        {
          value: trend('TEMPO', {
            wind: {
              value: { direction: 320, speed: 8, gust: 15, unit: 'MPS', variableFrom: null, variableTo: null },
              span: at(raw, '32008G15MPS'),
            },
          }),
          span: at(raw, 'TEMPO 32008G15MPS'),
        },
      ],
    });
  });

  it('corpus: recent weather, second altimeter in inHg, NOSIG', () => {
    const raw = 'METAR MNMG 071100Z 16004KT 9999 FEW020 BKN080 23/22 Q1010 A2983 REDZ NOSIG';
    const m = decodeMetar(raw);
    expect(m.altimeter).toEqual({ value: { unit: 'hPa', value: 1010 }, span: at(raw, 'Q1010') });
    expect(m.altimeterAlternate).toEqual({ value: { unit: 'inHg', value: 29.83 }, span: at(raw, 'A2983') });
    expect(m.recentWeather).toEqual([{ value: none('moderate', null, ['DZ']), span: at(raw, 'REDZ') }]);
    expect(m.trends).toEqual([{ value: trend('NOSIG', {}), span: at(raw, 'NOSIG') }]);
    expect(m.unparsed).toEqual([]);
  });

  it('a second altimeter in the same unit is not an alternate', () => {
    const raw = 'KXYZ 071100Z 00000KT 10SM CLR 10/09 A2990 A2991';
    expect(decodeMetar(raw).altimeterAlternate).toBeNull();
    expect(decodeMetar(raw).unparsed.map((u) => u.text)).toEqual(['A2991']);
  });

  it('corpus: no visibility, no sky, no altimeter; peak wind and pressure tendency in remarks', () => {
    const raw = 'METAR CAHR 071100Z AUTO 35010G16KT 13/13 RMK AO1 2PAST HR 3014 PK WND 35019/1045 SLP061 P0001 T01330129 50017';
    expect(decodeMetar(raw)).toEqual({
      ...empty(raw),
      reportType: { value: 'METAR', span: at(raw, 'METAR') },
      station: { value: 'CAHR', span: at(raw, 'CAHR') },
      time: { value: { day: 7, hour: 11, minute: 0 }, span: at(raw, '071100Z') },
      modifiers: [{ value: 'AUTO', span: at(raw, 'AUTO') }],
      wind: {
        value: { direction: 350, speed: 10, gust: 16, unit: 'KT', variableFrom: null, variableTo: null },
        span: at(raw, '35010G16KT'),
      },
      temperature: { value: { temperature: 13, dewpoint: 13 }, span: at(raw, '13/13') },
      remarks: {
        span: remarksSpan(raw),
        items: [
          { value: { kind: 'automatedStationType', type: 'AO1', augmented: false }, span: at(raw, 'AO1') },
          {
            value: { kind: 'peakWind', direction: 350, speed: 19, time: { hour: 10, minute: 45 } },
            span: at(raw, 'PK WND 35019/1045'),
          },
          { value: { kind: 'seaLevelPressure', pressure: 1006.1 }, span: at(raw, 'SLP061') },
          { value: { kind: 'precipitation', period: 'hourly', inches: 0.01, trace: false }, span: at(raw, 'P0001') },
          { value: { kind: 'preciseTemperature', temperature: 13.3, dewpoint: 12.9 }, span: at(raw, 'T01330129') },
          { value: { kind: 'pressureTendency', characteristic: 0, change: 1.7 }, span: at(raw, '50017') },
        ],
      },
      unparsed: [
        { text: '2PAST', span: at(raw, '2PAST'), section: 'remarks' },
        { text: 'HR', span: at(raw, 'HR'), section: 'remarks' },
        { text: '3014', span: at(raw, '3014'), section: 'remarks' },
      ],
    });
  });

  it('corpus: variable ceiling and variable sky', () => {
    const raw = 'SPECI K1CM 071103Z AUTO 22009KT 10SM -RA FEW008 SCT018 BKN026 OVC032 13/12 A2984 RMK AO2 LTG DSNT SW RAB1055E1056RAB03 CIG 026V034 BKN V SCT SLP085 $';
    const m = decodeMetar(raw);
    expect(m.remarks?.items.map((i) => i.value.kind)).toEqual([
      'automatedStationType',
      'lightning',
      'weatherTiming',
      'variableCeiling',
      'variableSky',
      'seaLevelPressure',
      'maintenanceNeeded',
    ]);
    expect(m.remarks?.items[3]).toEqual({
      value: { kind: 'variableCeiling', low: 2600, high: 3400 },
      span: at(raw, 'CIG 026V034'),
    });
    expect(m.remarks?.items[4]).toEqual({
      value: { kind: 'variableSky', from: 'BKN', base: null, to: 'SCT' },
      span: at(raw, 'BKN V SCT'),
    });
    expect(m.unparsed).toEqual([]);
  });

  it('corpus: variable wind with VRB, A01 typo in remarks', () => {
    const raw = 'METAR KOYE 071105Z AUTO VRB11KT 210V290 10SM FEW022 FEW027 30/25 A2990 RMK A01';
    const m = decodeMetar(raw);
    expect(m.wind).toEqual({
      value: { direction: 'VRB', speed: 11, gust: null, unit: 'KT', variableFrom: 210, variableTo: 290 },
      span: at(raw, 'VRB11KT 210V290'),
    });
    expect(m.remarks?.items).toEqual([
      { value: { kind: 'automatedStationType', type: 'AO1', augmented: false }, span: at(raw, 'A01') },
    ]);
    expect(m.unparsed).toEqual([]);
  });

  it('corpus: CAVOK, MPS gusts, TEMPO trend, QFE remark', () => {
    const raw = 'SPECI UAUU 071109Z 16010G15MPS CAVOK 31/01 Q1015 TEMPO VRB18MPS RMK QFE745/0993';
    const m = decodeMetar(raw);
    expect(m.visibility).toEqual({ value: { kind: 'cavok' }, span: at(raw, 'CAVOK') });
    expect(m.wind?.value).toEqual({ direction: 160, speed: 10, gust: 15, unit: 'MPS', variableFrom: null, variableTo: null });
    expect(m.trends).toEqual([
      {
        value: trend('TEMPO', {
          wind: {
            value: { direction: 'VRB', speed: 18, gust: null, unit: 'MPS', variableFrom: null, variableTo: null },
            span: at(raw, 'VRB18MPS'),
          },
        }),
        span: at(raw, 'TEMPO VRB18MPS'),
      },
    ]);
    expect(m.unparsed.map((u) => [u.text, u.section])).toEqual([['QFE745/0993', 'remarks']]);
  });

  it('a trend section runs to RMK; each indicator opens its own trend', () => {
    const raw = 'OPFA 071100Z 18008KT 6000 SCT040 33/22 Q1005 TEMPO 18015G30KT 2000 TSRA FEW030CB BECMG 9999 RMK A2968';
    const m = decodeMetar(raw);
    expect(m.trends).toEqual([
      {
        value: trend('TEMPO', {
          wind: {
            value: { direction: 180, speed: 15, gust: 30, unit: 'KT', variableFrom: null, variableTo: null },
            span: at(raw, '18015G30KT'),
          },
          visibility: { value: { kind: 'meters', meters: 2000, direction: null, minimum: null }, span: at(raw, '2000') },
          weather: [{ value: none('moderate', 'TS', ['RA']), span: at(raw, 'TSRA') }],
          sky: [{ value: { kind: 'layer', amount: 'FEW', base: 3000, type: 'CB' }, span: at(raw, 'FEW030CB') }],
        }),
        span: at(raw, 'TEMPO 18015G30KT 2000 TSRA FEW030CB'),
      },
      {
        value: trend('BECMG', {
          visibility: { value: { kind: 'meters', meters: 9999, direction: null, minimum: null }, span: at(raw, '9999') },
        }),
        span: at(raw, 'BECMG 9999'),
      },
    ]);
    expect(m.unparsed).toEqual([]);
    expect(m.remarks?.items).toEqual([
      { value: { kind: 'altimeter', altimeter: { unit: 'inHg', value: 29.68 } }, span: at(raw, 'A2968') },
    ]);
  });

  it('trend time bounds FM/TL/AT are decoded; TX groups inside a trend stay unparsed', () => {
    const raw = 'EGLL 071050Z 24010KT 9999 SCT030 18/12 Q1015 TEMPO FM1200 TL1300 4000 SHRA BECMG AT1230 NSW TX20/0715Z';
    const m = decodeMetar(raw);
    expect(m.trends[0]?.value).toEqual(
      trend(
        'TEMPO',
        {
          visibility: { value: { kind: 'meters', meters: 4000, direction: null, minimum: null }, span: at(raw, '4000') },
          weather: [{ value: none('moderate', 'SH', ['RA']), span: at(raw, 'SHRA') }],
        },
        {
          from: { value: { hour: 12, minute: 0 }, span: at(raw, 'FM1200') },
          until: { value: { hour: 13, minute: 0 }, span: at(raw, 'TL1300') },
        },
      ),
    );
    expect(m.trends[1]?.value.at).toEqual({ value: { hour: 12, minute: 30 }, span: at(raw, 'AT1230') });
    expect(m.trends[1]?.value.conditions.noSignificantWeather?.value).toBe('NSW');
    expect(m.unparsed).toEqual([{ text: 'TX20/0715Z', span: at(raw, 'TX20/0715Z'), section: 'trend' }]);
  });

  it('corpus: Canadian density altitude, PRESFR, and MISG elements', () => {
    const raw = 'SPECI CYYW 071111Z AUTO 08005KT 030V110 9SM OVC007 14/13 A3015 RMK PRESFR SLP202';
    const m = decodeMetar(raw);
    expect(m.remarks?.items).toEqual([
      { value: { kind: 'pressureChangeRapid', direction: 'falling' }, span: at(raw, 'PRESFR') },
      { value: { kind: 'seaLevelPressure', pressure: 1020.2 }, span: at(raw, 'SLP202') },
    ]);
    const raw2 = 'SPECI CYBW 071110Z AUTO 01004KT 6SM -RA BR FEW015 OVC036 11/10 A2996 RMK SLP157 DENSITY ALT 4300FT';
    expect(decodeMetar(raw2).remarks?.items[1]).toEqual({
      value: { kind: 'densityAltitude', altitude: 4300 },
      span: at(raw2, 'DENSITY ALT 4300FT'),
    });
    const raw3 = 'METAR CWLI 071100Z AUTO ///// ////SM ////// 06/04 A2993 RMK WND MISG VIS MISG CLD MISG T00600043 SLP141';
    const m3 = decodeMetar(raw3);
    expect(m3.visibility).toEqual({ value: { kind: 'missing' }, span: at(raw3, '////SM') });
    expect(m3.sky).toEqual([{ value: { kind: 'missing' }, span: at(raw3, '//////') }]);
    expect(m3.remarks?.items.slice(0, 3)).toEqual([
      { value: { kind: 'elementMissing', element: 'WND' }, span: at(raw3, 'WND MISG') },
      { value: { kind: 'elementMissing', element: 'VIS' }, span: at(raw3, 'VIS MISG') },
      { value: { kind: 'elementMissing', element: 'CLD' }, span: at(raw3, 'CLD MISG') },
    ]);
    // `/////` with no unit is positionally ambiguous (missing wind here, missing
    // temperature elsewhere), so it is deliberately left unparsed.
    expect(m3.unparsed.map((u) => u.text)).toEqual(['/////']);
  });

  it('corpus: Philippine report with inHg in remarks and CB direction words', () => {
    const raw = 'METAR RPLI 071100Z 22004KT 7000 -RA FEW017CB SCT018 BKN090 26/24 Q1008 RMK A2977 CB E-S';
    const m = decodeMetar(raw);
    expect(m.visibility?.value).toEqual({ kind: 'meters', meters: 7000, direction: null, minimum: null });
    expect(m.sky.map((s) => s.value)).toEqual([
      { kind: 'layer', amount: 'FEW', base: 1700, type: 'CB' },
      { kind: 'layer', amount: 'SCT', base: 1800, type: null },
      { kind: 'layer', amount: 'BKN', base: 9000, type: null },
    ]);
    expect(m.remarks?.items).toEqual([
      { value: { kind: 'altimeter', altimeter: { unit: 'inHg', value: 29.77 } }, span: at(raw, 'A2977') },
      {
        value: { kind: 'phenomenonLocation', phenomenon: 'CB', distant: false, locations: ['E-S'], movement: null },
        span: at(raw, 'CB E-S'),
      },
    ]);
    expect(m.unparsed).toEqual([]);
  });

  it('corpus: lightning and CB location with movement', () => {
    const raw = 'METAR KDSM 071054Z 12011G17KT 10SM FEW110 OVC140 22/19 A3005 RMK AO2 SLP168 OCNL LTGIC DSNT SW CB DSNT SW MOV NE T02220194';
    const m = decodeMetar(raw);
    expect(m.remarks?.items.slice(2, 4)).toEqual([
      {
        value: { kind: 'lightning', frequency: 'OCNL', types: ['IC'], distant: true, locations: ['SW'], movement: null },
        span: at(raw, 'OCNL LTGIC DSNT SW'),
      },
      {
        value: { kind: 'phenomenonLocation', phenomenon: 'CB', distant: true, locations: ['SW'], movement: 'NE' },
        span: at(raw, 'CB DSNT SW MOV NE'),
      },
    ]);
    expect(m.unparsed).toEqual([]);
  });

  it('corpus: obscuration remark and second-site ceiling', () => {
    const raw = 'METAR KCRW 071054Z 02003KT 10SM FEW000 BKN047 17/17 A3008 RMK AO2 SLP178 FG FEW000 T01720172 $';
    expect(decodeMetar(raw).remarks?.items[2]).toEqual({
      value: { kind: 'obscuration', weather: none('moderate', null, ['FG']), amount: 'FEW', base: 0 },
      span: at(raw, 'FG FEW000'),
    });
    const raw2 = 'METAR KTCM 071055Z AUTO 19009KT 10SM OVC022 15/11 A3007 RMK AO2 LTG DSNT N CIG 021 RWY16 SLP185 T01500112 $';
    const m2 = decodeMetar(raw2);
    expect(m2.remarks?.items[2]).toEqual({
      value: { kind: 'secondSiteCeiling', height: 2100, location: 'RWY16' },
      span: at(raw2, 'CIG 021 RWY16'),
    });
    expect(m2.unparsed).toEqual([]);
  });
});

describe('decodeMetar — structure', () => {
  it('accepts a report with no type keyword', () => {
    const raw = 'KJFK 141851Z 28016G24KT 10SM FEW045 SCT250 09/M04 A3012';
    const m = decodeMetar(raw);
    expect(m.reportType).toBeNull();
    expect(m.station?.value).toBe('KJFK');
    expect(m.remarks).toBeNull();
    expect(m.unparsed).toEqual([]);
  });

  it('decodes a NIL report', () => {
    const raw = 'METAR KXYZ 071100Z NIL';
    const m = decodeMetar(raw);
    expect(m.modifiers).toEqual([{ value: 'NIL', span: at(raw, 'NIL') }]);
    expect(m.unparsed).toEqual([]);
  });

  it('maps Canadian CCA/CCB corrections to COR, keeping the literal span', () => {
    const raw = 'METAR CYYZ 071100Z CCA 27010KT 15SM SKC 18/10 A3001';
    const m = decodeMetar(raw);
    expect(m.modifiers).toEqual([{ value: 'COR', span: at(raw, 'CCA') }]);
  });

  it('corpus: accepts a modifier before the time group', () => {
    const raw = 'METAR MHPR COR 071100Z VRB02KT 9999 SCT044 23/21 Q1016 A3002 NOSIG';
    const m = decodeMetar(raw);
    expect(m.modifiers).toEqual([{ value: 'COR', span: at(raw, 'COR') }]);
    expect(m.time?.value).toEqual({ day: 7, hour: 11, minute: 0 });
    expect(m.altimeterAlternate?.value).toEqual({ unit: 'inHg', value: 30.02 });
    expect(m.unparsed).toEqual([]);
  });

  it('a modifier after the wind group is out of order and stays unparsed', () => {
    const raw = 'KXYZ 071100Z 27010KT AUTO 10SM CLR 10/09 A2990';
    expect(decodeMetar(raw).modifiers).toEqual([]);
    expect(decodeMetar(raw).unparsed.map((u) => u.text)).toEqual(['AUTO']);
  });

  it('-0 never appears in output', () => {
    const raw = 'KXYZ 071100Z 00000KT 10SM CLR M00/M00 A2990 RMK T10001000 58000 21000';
    const m = decodeMetar(raw);
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
    expect(Object.is(m.temperature?.value.temperature, -0)).toBe(false);
  });

  it('accepts weather appearing after sky (interleaved phenomena)', () => {
    const raw = 'KXYZ 071100Z 00000KT 5SM BKN020 -RA 10/09 A2990';
    const m = decodeMetar(raw);
    expect(m.sky.length).toBe(1);
    expect(m.weather.length).toBe(1);
    expect(m.unparsed).toEqual([]);
  });

  it('keeps an out-of-order group as unparsed rather than reassigning it', () => {
    const raw = 'KXYZ 071100Z 10SM 27010KT CLR 10/09 A2990';
    const m = decodeMetar(raw);
    expect(m.visibility?.value).toEqual({ kind: 'statute', miles: 10, qualifier: null });
    expect(m.wind).toBeNull();
    expect(m.unparsed).toEqual([{ text: '27010KT', span: at(raw, '27010KT'), section: 'body' }]);
  });

  it('wind shear forms', () => {
    expect(decodeMetar('KXYZ 071100Z 27010KT 10SM CLR 10/09 A2990 WS ALL RWY').windShear[0]?.value).toEqual({ runway: 'ALL' });
    expect(decodeMetar('KXYZ 071100Z 27010KT 10SM CLR 10/09 A2990 WS RWY22').windShear[0]?.value).toEqual({ runway: '22' });
    expect(decodeMetar('KXYZ 071100Z 27010KT 10SM CLR 10/09 A2990 WS RWY 22L').windShear[0]?.value).toEqual({ runway: '22L' });
    expect(decodeMetar('KXYZ 071100Z 27010KT 10SM CLR 10/09 A2990 WS R02').windShear[0]?.value).toEqual({ runway: '02' });
  });

  it('runway state forms', () => {
    const state = (raw: string) => decodeMetar(`UUWW 071100Z 31007MPS 9999 BKN046 12/05 Q1013 ${raw}`).runwayState[0]?.value;
    expect(state('R88/SNOCLO')).toEqual({ runway: '88', closed: true, cleared: false, deposit: null, extent: null, depth: null, friction: null });
    expect(state('R/SNOCLO')).toEqual({ runway: null, closed: true, cleared: false, deposit: null, extent: null, depth: null, friction: null });
    expect(state('R24/CLRD//')).toEqual({ runway: '24', closed: false, cleared: true, deposit: null, extent: null, depth: null, friction: null });
    expect(state('R24L/5/1095')).toEqual({ runway: '24L', closed: false, cleared: false, deposit: 5, extent: null, depth: 10, friction: 95 });
    expect(state('R27/////95')).toEqual({ runway: '27', closed: false, cleared: false, deposit: null, extent: null, depth: null, friction: 95 });
  });

  it('never throws and claims every token on garbage input', () => {
    for (const raw of ['', '   ', 'hello world', '////// ////', 'RMK', 'RMK RMK RMK', '= = =', 'METAR', ' \t\n', 'TEMPO', 'NOSIG RMK']) {
      const m = decodeMetar(raw);
      expect(m.raw).toBe(raw);
    }
    const m = decodeMetar('hello world');
    expect(m.unparsed.map((u) => u.text)).toEqual(['hello', 'world']);
  });

  it('a report that is only RMK has an empty remarks section', () => {
    const m = decodeMetar('KXYZ 071100Z RMK');
    expect(m.remarks).toEqual({ span: { start: 13, end: 16 }, items: [] });
  });

  it('is deterministic: decoding twice gives identical output', () => {
    const raw = 'SPECI K1CM 071103Z AUTO 22009KT 10SM -RA FEW008 SCT018 BKN026 OVC032 13/12 A2984 RMK AO2 LTG DSNT SW RAB1055E1056RAB03 CIG 026V034 BKN V SCT SLP085 $';
    expect(decodeMetar(raw)).toEqual(decodeMetar(raw));
    expect(JSON.parse(JSON.stringify(decodeMetar(raw)))).toEqual(decodeMetar(raw));
  });
});
