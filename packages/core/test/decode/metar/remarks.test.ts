import { describe, expect, it } from 'vitest';
import { decodeWeatherTiming, parseRemark, type Remark } from '../../../src/decode/metar/remarks.js';
import { tokenize } from '../../../src/decode/tokenizer.js';

function remark(text: string): { value: Remark; consumed: number } | null {
  return parseRemark(tokenize(text), 0);
}

const moderate = (descriptor: string | null, phenomena: string[]) => ({
  intensity: 'moderate',
  vicinity: false,
  descriptor,
  phenomena,
});

const ltg = (
  frequency: string | null,
  types: string[],
  distant: boolean,
  locations: string[],
  movement: string | null = null,
) => ({ kind: 'lightning', frequency, types, distant, locations, movement });

describe('remarks', () => {
  const cases: [string, unknown, number][] = [
    ['AO2', { kind: 'automatedStationType', type: 'AO2', augmented: false }, 1],
    ['AO1', { kind: 'automatedStationType', type: 'AO1', augmented: false }, 1],
    ['AO2A', { kind: 'automatedStationType', type: 'AO2', augmented: true }, 1],
    // Common feed typo: zero instead of the letter O.
    ['A02', { kind: 'automatedStationType', type: 'AO2', augmented: false }, 1],
    ['SLP198', { kind: 'seaLevelPressure', pressure: 1019.8 }, 1],
    ['SLP982', { kind: 'seaLevelPressure', pressure: 998.2 }, 1],
    ['SLP061', { kind: 'seaLevelPressure', pressure: 1006.1 }, 1],
    ['SLP499', { kind: 'seaLevelPressure', pressure: 1049.9 }, 1],
    ['SLP500', { kind: 'seaLevelPressure', pressure: 950 }, 1],
    ['SLPNO', { kind: 'seaLevelPressure', pressure: null }, 1],
    ['A2976', { kind: 'altimeter', altimeter: { unit: 'inHg', value: 29.76 } }, 1],
    ['Q1013', { kind: 'altimeter', altimeter: { unit: 'hPa', value: 1013 } }, 1],
    ['ALSTG ESTMD', { kind: 'altimeterEstimated' }, 2],
    ['T00941044', { kind: 'preciseTemperature', temperature: 9.4, dewpoint: -4.4 }, 1],
    ['T10221033', { kind: 'preciseTemperature', temperature: -2.2, dewpoint: -3.3 }, 1],
    ['T0256', { kind: 'preciseTemperature', temperature: 25.6, dewpoint: null }, 1],
    ['T0240////', { kind: 'preciseTemperature', temperature: 24, dewpoint: null }, 1],
    ['PK WND 28032/1845', { kind: 'peakWind', direction: 280, speed: 32, time: { hour: 18, minute: 45 } }, 3],
    ['PK WND 10026/57', { kind: 'peakWind', direction: 100, speed: 26, time: { hour: null, minute: 57 } }, 3],
    ['WSHFT 1830', { kind: 'windShift', time: { hour: 18, minute: 30 }, frontalPassage: false }, 2],
    ['WSHFT 30 FROPA', { kind: 'windShift', time: { hour: null, minute: 30 }, frontalPassage: true }, 3],
    ['TWR VIS 1 1/2', { kind: 'towerVisibility', miles: 1.5 }, 4],
    ['TWR VIS 2', { kind: 'towerVisibility', miles: 2 }, 3],
    ['SFC VIS 3/4', { kind: 'surfaceVisibility', miles: 0.75 }, 3],
    ['VIS 1/2V2', { kind: 'variableVisibility', low: 0.5, lowQualifier: null, high: 2 }, 2],
    ['VIS 1/2V5', { kind: 'variableVisibility', low: 0.5, lowQualifier: null, high: 5 }, 2],
    ['VIS 3/4V1 1/2', { kind: 'variableVisibility', low: 0.75, lowQualifier: null, high: 1.5 }, 3],
    ['VIS 2 1/2V4', { kind: 'variableVisibility', low: 2.5, lowQualifier: null, high: 4 }, 3],
    ['VIS 1V3', { kind: 'variableVisibility', low: 1, lowQualifier: null, high: 3 }, 2],
    ['VIS M1/4V2', { kind: 'variableVisibility', low: 0.25, lowQualifier: 'lessThan', high: 2 }, 2],
    ['CIG 005V010', { kind: 'variableCeiling', low: 500, high: 1000 }, 2],
    ['CIG 021 RWY16', { kind: 'secondSiteCeiling', height: 2100, location: 'RWY16' }, 3],
    ['CIG 004', { kind: 'secondSiteCeiling', height: 400, location: null }, 2],
    ['CIG 004 SLP123', { kind: 'secondSiteCeiling', height: 400, location: null }, 2],
    ['BKN009 V SCT', { kind: 'variableSky', from: 'BKN', base: 900, to: 'SCT' }, 3],
    ['BKN V SCT', { kind: 'variableSky', from: 'BKN', base: null, to: 'SCT' }, 3],
    ['FG FEW000', { kind: 'obscuration', weather: moderate(null, ['FG']), amount: 'FEW', base: 0 }, 2],
    ['FU BKN020', { kind: 'obscuration', weather: moderate(null, ['FU']), amount: 'BKN', base: 2000 }, 2],
    ['P0003', { kind: 'precipitation', period: 'hourly', inches: 0.03, trace: false }, 1],
    ['P0000', { kind: 'precipitation', period: 'hourly', inches: 0, trace: true }, 1],
    ['60012', { kind: 'precipitation', period: 'threeOrSixHourly', inches: 0.12, trace: false }, 1],
    ['6////', { kind: 'precipitation', period: 'threeOrSixHourly', inches: null, trace: false }, 1],
    ['70125', { kind: 'precipitation', period: 'twentyFourHourly', inches: 1.25, trace: false }, 1],
    ['10094', { kind: 'temperatureExtreme', period: 'sixHourly', max: 9.4, min: null }, 1],
    ['21033', { kind: 'temperatureExtreme', period: 'sixHourly', max: null, min: -3.3 }, 1],
    ['401120084', { kind: 'temperatureExtreme', period: 'twentyFourHourly', max: 11.2, min: 8.4 }, 1],
    ['411201084', { kind: 'temperatureExtreme', period: 'twentyFourHourly', max: -12, min: -8.4 }, 1],
    ['52012', { kind: 'pressureTendency', characteristic: 2, change: 1.2 }, 1],
    ['50017', { kind: 'pressureTendency', characteristic: 0, change: 1.7 }, 1],
    ['54000', { kind: 'pressureTendency', characteristic: 4, change: 0 }, 1],
    ['58021', { kind: 'pressureTendency', characteristic: 8, change: -2.1 }, 1],
    ['PRESRR', { kind: 'pressureChangeRapid', direction: 'rising' }, 1],
    ['PRESFR', { kind: 'pressureChangeRapid', direction: 'falling' }, 1],
    [
      'RAB05E30',
      {
        kind: 'weatherTiming',
        events: [
          { weather: moderate(null, ['RA']), event: 'began', time: { hour: null, minute: 5 } },
          { weather: moderate(null, ['RA']), event: 'ended', time: { hour: null, minute: 30 } },
        ],
      },
      1,
    ],
    [
      'TSE1055TSB1056',
      {
        kind: 'weatherTiming',
        events: [
          { weather: moderate('TS', []), event: 'ended', time: { hour: 10, minute: 55 } },
          { weather: moderate('TS', []), event: 'began', time: { hour: 10, minute: 56 } },
        ],
      },
      1,
    ],
    ['LTG DSNT W AND NW', ltg(null, [], true, ['W', 'NW']), 5],
    ['LTG DSNT NW THRU E', ltg(null, [], true, ['NW', 'E']), 5],
    ['OCNL LTG ICCG NE-SE', ltg('OCNL', ['IC', 'CG'], false, ['NE-SE']), 4],
    ['FRQ LTG IC W', ltg('FRQ', ['IC'], false, ['W']), 4],
    ['CONS LTGICCG OHD', ltg('CONS', ['IC', 'CG'], false, ['OHD']), 3],
    ['LTG DSNT ALQDS', ltg(null, [], true, ['ALQDS']), 3],
    ['OCNL LTGIC DSNT SW MOV NE', ltg('OCNL', ['IC'], true, ['SW'], 'NE'), 6],
    // Trailing words that are not part of the lightning group are left alone.
    ['LTG DSNT SW SLP085', ltg(null, [], true, ['SW']), 3],
    ['LTG DSNT SW CB DSNT SW', ltg(null, [], true, ['SW']), 3],
    ['CB DSNT SW MOV NE', { kind: 'phenomenonLocation', phenomenon: 'CB', distant: true, locations: ['SW'], movement: 'NE' }, 5],
    ['CB DSNT NE-E W-NW', { kind: 'phenomenonLocation', phenomenon: 'CB', distant: true, locations: ['NE-E', 'W-NW'], movement: null }, 4],
    ['TS SE MOV NE', { kind: 'phenomenonLocation', phenomenon: 'TS', distant: false, locations: ['SE'], movement: 'NE' }, 4],
    ['TCU DSNT ALQDS', { kind: 'phenomenonLocation', phenomenon: 'TCU', distant: true, locations: ['ALQDS'], movement: null }, 3],
    ['ACSL DSNT NE-SE', { kind: 'phenomenonLocation', phenomenon: 'ACSL', distant: true, locations: ['NE-SE'], movement: null }, 3],
    ['VIRGA', { kind: 'phenomenonLocation', phenomenon: 'VIRGA', distant: false, locations: [], movement: null }, 1],
    ['VIRGA SW', { kind: 'phenomenonLocation', phenomenon: 'VIRGA', distant: false, locations: ['SW'], movement: null }, 2],
    ['TSNO', { kind: 'sensorStatus', sensor: 'TSNO', location: null }, 1],
    ['PNO', { kind: 'sensorStatus', sensor: 'PNO', location: null }, 1],
    ['CHINO RWY22', { kind: 'sensorStatus', sensor: 'CHINO', location: 'RWY22' }, 2],
    ['VISNO LOC', { kind: 'sensorStatus', sensor: 'VISNO', location: 'LOC' }, 2],
    ['CHINO SLP123', { kind: 'sensorStatus', sensor: 'CHINO', location: null }, 1],
    ['WND MISG', { kind: 'elementMissing', element: 'WND' }, 2],
    ['CLD MISG', { kind: 'elementMissing', element: 'CLD' }, 2],
    ['$', { kind: 'maintenanceNeeded' }, 1],
    ['FIRST', { kind: 'reportSequence', which: 'FIRST' }, 1],
    ['LAST', { kind: 'reportSequence', which: 'LAST' }, 1],
    ['4/012', { kind: 'snowDepth', inches: 12 }, 1],
    ['SNINCR 2/10', { kind: 'snowIncreasing', lastHour: 2, depth: 10 }, 2],
    ['98060', { kind: 'sunshine', minutes: 60 }, 1],
    ['933036', { kind: 'waterEquivalent', inches: 3.6 }, 1],
    ['DENSITY ALT 4300FT', { kind: 'densityAltitude', altitude: 4300 }, 3],
    ['DENSITY ALT -380FT', { kind: 'densityAltitude', altitude: -380 }, 3],
    ['8/530', { kind: 'cloudTypes', low: 5, middle: 3, high: 0 }, 1],
    ['8/03/', { kind: 'cloudTypes', low: 0, middle: 3, high: null }, 1],
  ];
  it.each(cases)('%s', (text, value, consumed) => {
    expect(remark(text)).toEqual({ value, consumed });
  });

  it.each([
    'QFE753/1004',
    'QNH761',
    'BKN009',
    'V',
    'SCT',
    'CB',
    'TS',
    'FG',
    'E-S',
    'DSNT',
    'MOV',
    '2PAST',
    'HR',
    '3014',
    'RTS',
    'PK',
    'PK WND',
    'PK WND 28032',
    'WSHFT',
    'VIS',
    'CIG',
    'T0094104',
    'SLP19',
    '12345',
    'RAB',
    'RAB5',
    'XXB05',
    'MISG',
    'A////',
    '=',
  ])('leaves %s unparsed', (text) => {
    expect(remark(text)).toBeNull();
  });
});

describe('decodeWeatherTiming', () => {
  it('handles a chain of phenomena and events', () => {
    expect(decodeWeatherTiming('RAB1055E1056RAB03')).toEqual([
      { weather: moderate(null, ['RA']), event: 'began', time: { hour: 10, minute: 55 } },
      { weather: moderate(null, ['RA']), event: 'ended', time: { hour: 10, minute: 56 } },
      { weather: moderate(null, ['RA']), event: 'began', time: { hour: null, minute: 3 } },
    ]);
  });

  it('handles a phenomenon code that itself contains B or E', () => {
    expect(decodeWeatherTiming('BRB05E20')).toEqual([
      { weather: moderate(null, ['BR']), event: 'began', time: { hour: null, minute: 5 } },
      { weather: moderate(null, ['BR']), event: 'ended', time: { hour: null, minute: 20 } },
    ]);
    expect(decodeWeatherTiming('BLSNB15')).toEqual([
      { weather: moderate('BL', ['SN']), event: 'began', time: { hour: null, minute: 15 } },
    ]);
  });

  it('carries descriptors and intensity', () => {
    expect(decodeWeatherTiming('FZRAB05SHSNE30')).toEqual([
      { weather: moderate('FZ', ['RA']), event: 'began', time: { hour: null, minute: 5 } },
      { weather: moderate('SH', ['SN']), event: 'ended', time: { hour: null, minute: 30 } },
    ]);
  });

  it('rejects anything not fully consumed', () => {
    expect(decodeWeatherTiming('RAB05X')).toBeNull();
    expect(decodeWeatherTiming('RAB')).toBeNull();
    expect(decodeWeatherTiming('B05')).toBeNull();
    expect(decodeWeatherTiming('RAB75')).toBeNull();
  });
});
