import { describe, expect, it } from 'vitest';
import type { GroupMatch } from '../../src/decode/groups/match.js';
import { parseAltimeter } from '../../src/decode/groups/pressure.js';
import { parseRvr } from '../../src/decode/groups/rvr.js';
import { parseSky } from '../../src/decode/groups/sky.js';
import { parseTemperature } from '../../src/decode/groups/temperature.js';
import { parseDayTime, parseValidity } from '../../src/decode/groups/time.js';
import { parseVisibility } from '../../src/decode/groups/visibility.js';
import { decodeWeatherCode, parseWeather } from '../../src/decode/groups/weather.js';
import { parseWind } from '../../src/decode/groups/wind.js';
import { tokenize, type Token } from '../../src/decode/tokenizer.js';

type Parser<T> = (tokens: readonly Token[], index: number) => GroupMatch<T>;

/** Run a group parser at the first token of `text`. */
function run<T>(parser: Parser<T>, text: string): GroupMatch<T> {
  return parser(tokenize(text), 0);
}

describe('wind', () => {
  const cases: [string, unknown, number][] = [
    ['28016G24KT', { direction: 280, speed: 16, gust: 24, unit: 'KT', variableFrom: null, variableTo: null }, 1],
    ['VRB03KT', { direction: 'VRB', speed: 3, gust: null, unit: 'KT', variableFrom: null, variableTo: null }, 1],
    ['00000KT', { direction: 0, speed: 0, gust: null, unit: 'KT', variableFrom: null, variableTo: null }, 1],
    ['12010MPS', { direction: 120, speed: 10, gust: null, unit: 'MPS', variableFrom: null, variableTo: null }, 1],
    ['31007G12MPS 280V340', { direction: 310, speed: 7, gust: 12, unit: 'MPS', variableFrom: 280, variableTo: 340 }, 2],
    ['24015KMH', { direction: 240, speed: 15, gust: null, unit: 'KMH', variableFrom: null, variableTo: null }, 1],
    ['/////KT', { direction: null, speed: null, gust: null, unit: 'KT', variableFrom: null, variableTo: null }, 1],
    ['270120G140KT', { direction: 270, speed: 120, gust: 140, unit: 'KT', variableFrom: null, variableTo: null }, 1],
    ['36005KTS', { direction: 360, speed: 5, gust: null, unit: 'KT', variableFrom: null, variableTo: null }, 1],
    // A variation group only attaches when it immediately follows.
    ['28016KT 10SM 280V350', { direction: 280, speed: 16, gust: null, unit: 'KT', variableFrom: null, variableTo: null }, 1],
  ];
  it.each(cases)('%s', (text, value, consumed) => {
    expect(run(parseWind, text)).toEqual({ value, consumed });
  });

  it.each(['28016', '37010KT', '280V350', '2801KT', 'KT', '28016G'])('rejects %s', (text) => {
    expect(run(parseWind, text)).toBeNull();
  });
});

describe('visibility', () => {
  const statute = (miles: number, qualifier: string | null = null) => ({ kind: 'statute', miles, qualifier });
  const cases: [string, unknown, number][] = [
    ['10SM', statute(10), 1],
    ['1SM', statute(1), 1],
    ['1/2SM', statute(0.5), 1],
    ['1/16SM', statute(1 / 16), 1],
    ['3/4SM', statute(0.75), 1],
    ['M1/4SM', statute(0.25, 'lessThan'), 1],
    ['P6SM', statute(6, 'greaterThan'), 1],
    ['1 1/2SM', statute(1.5), 2],
    ['2 1/4SM BR', statute(2.25), 2],
    // Space-dropped feed forms: the only valid reading is whole + fraction.
    ['11/2SM', statute(1.5), 1],
    ['21/2SM', statute(2.5), 1],
    ['13/4SM', statute(1.75), 1],
    ['9999', { kind: 'meters', meters: 9999, direction: null, minimum: null }, 1],
    ['0800', { kind: 'meters', meters: 800, direction: null, minimum: null }, 1],
    ['2000SW', { kind: 'meters', meters: 2000, direction: 'SW', minimum: null }, 1],
    ['9999NDV', { kind: 'meters', meters: 9999, direction: 'NDV', minimum: null }, 1],
    ['4000 1500NE', { kind: 'meters', meters: 4000, direction: null, minimum: { meters: 1500, direction: 'NE' } }, 2],
    ['CAVOK', { kind: 'cavok' }, 1],
    ['////', { kind: 'missing' }, 1],
  ];
  it.each(cases)('%s', (text, value, consumed) => {
    expect(run(parseVisibility, text)).toEqual({ value, consumed });
  });

  it('does not consume a lone whole number that is not followed by a fraction', () => {
    expect(run(parseVisibility, '1 BR')).toBeNull();
  });

  it.each(['10', 'SM', '1/0SM', '12345', 'FEW045'])('rejects %s', (text) => {
    expect(run(parseVisibility, text)).toBeNull();
  });
});

describe('rvr', () => {
  const cases: [string, unknown][] = [
    ['R04/P6000FT', { runway: '04', low: { value: 6000, qualifier: 'greaterThan' }, high: null, unit: 'FT', trend: null }],
    ['R22L/1200V2000FT', { runway: '22L', low: { value: 1200, qualifier: null }, high: { value: 2000, qualifier: null }, unit: 'FT', trend: null }],
    ['R09/5000VP6000FT', { runway: '09', low: { value: 5000, qualifier: null }, high: { value: 6000, qualifier: 'greaterThan' }, unit: 'FT', trend: null }],
    ['R04/0600N', { runway: '04', low: { value: 600, qualifier: null }, high: null, unit: 'M', trend: 'N' }],
    ['R22/M0200', { runway: '22', low: { value: 200, qualifier: 'lessThan' }, high: null, unit: 'M', trend: null }],
    ['R22/P1500FT/D', { runway: '22', low: { value: 1500, qualifier: 'greaterThan' }, high: null, unit: 'FT', trend: 'D' }],
    ['R30/////FT', { runway: '30', low: null, high: null, unit: 'FT', trend: null }],
    ['R13R/0800V1800FT', { runway: '13R', low: { value: 800, qualifier: null }, high: { value: 1800, qualifier: null }, unit: 'FT', trend: null }],
  ];
  it.each(cases)('%s', (text, value) => {
    expect(run(parseRvr, text)).toEqual({ value, consumed: 1 });
  });

  it.each(['R24/CLRD63', 'R24/000062', 'RWY22', 'R4/2000FT'])('rejects %s (runway state, not RVR)', (text) => {
    expect(run(parseRvr, text)).toBeNull();
  });
});

describe('weather', () => {
  const wx = (
    intensity: string,
    descriptor: string | null,
    phenomena: string[],
    vicinity = false,
  ) => ({ intensity, vicinity, descriptor, phenomena });
  const cases: [string, unknown][] = [
    ['RA', wx('moderate', null, ['RA'])],
    ['-RA', wx('light', null, ['RA'])],
    ['+TSRA', wx('heavy', 'TS', ['RA'])],
    ['VCSH', wx('moderate', 'SH', [], true)],
    ['VCTS', wx('moderate', 'TS', [], true)],
    ['VCTSRA', wx('moderate', 'TS', ['RA'], true)],
    ['TS', wx('moderate', 'TS', [])],
    ['FZFG', wx('moderate', 'FZ', ['FG'])],
    ['-SHRASN', wx('light', 'SH', ['RA', 'SN'])],
    ['+SHRAGR', wx('heavy', 'SH', ['RA', 'GR'])],
    ['BLSN', wx('moderate', 'BL', ['SN'])],
    ['MIFG', wx('moderate', 'MI', ['FG'])],
    ['+FC', wx('heavy', null, ['FC'])],
    ['BR', wx('moderate', null, ['BR'])],
    ['-FZDZ', wx('light', 'FZ', ['DZ'])],
    ['RASN', wx('moderate', null, ['RA', 'SN'])],
    ['-DZ', wx('light', null, ['DZ'])],
    ['DS', wx('moderate', null, ['DS'])],
  ];
  it.each(cases)('%s', (text, value) => {
    expect(run(parseWeather, text)).toEqual({ value, consumed: 1 });
  });

  it.each(['FZ', 'BL', 'SH', 'MI', 'RAX', 'R', '', '-', 'VC', 'NSW', 'SKC', 'KJFK', 'RATS', '//'])(
    'rejects %s',
    (text) => {
      expect(decodeWeatherCode(text)).toBeNull();
    },
  );
});

describe('sky', () => {
  const cases: [string, unknown][] = [
    ['FEW045', { kind: 'layer', amount: 'FEW', base: 4500, type: null }],
    ['SCT100', { kind: 'layer', amount: 'SCT', base: 10000, type: null }],
    ['BKN250', { kind: 'layer', amount: 'BKN', base: 25000, type: null }],
    ['OVC008', { kind: 'layer', amount: 'OVC', base: 800, type: null }],
    ['OVC000', { kind: 'layer', amount: 'OVC', base: 0, type: null }],
    ['FEW022CB', { kind: 'layer', amount: 'FEW', base: 2200, type: 'CB' }],
    ['SCT025TCU', { kind: 'layer', amount: 'SCT', base: 2500, type: 'TCU' }],
    ['BKN///', { kind: 'layer', amount: 'BKN', base: null, type: null }],
    ['BKN010///', { kind: 'layer', amount: 'BKN', base: 1000, type: null }],
    ['///TCU', { kind: 'layer', amount: null, base: null, type: 'TCU' }],
    ['//////CB', { kind: 'layer', amount: null, base: null, type: 'CB' }],
    ['///015', { kind: 'layer', amount: null, base: 1500, type: null }],
    ['//////', { kind: 'missing' }],
    ['/////////', { kind: 'missing' }],
    ['VV003', { kind: 'verticalVisibility', height: 300 }],
    ['VV///', { kind: 'verticalVisibility', height: null }],
    ['CLR', { kind: 'clear', code: 'CLR' }],
    ['SKC', { kind: 'clear', code: 'SKC' }],
    ['NSC', { kind: 'clear', code: 'NSC' }],
    ['NCD', { kind: 'clear', code: 'NCD' }],
  ];
  it.each(cases)('%s', (text, value) => {
    expect(run(parseSky, text)).toEqual({ value, consumed: 1 });
  });

  it.each(['FEW', 'FEW45', 'BKN0100', 'OVC008X', 'CB', 'CLEAR', '///', '////', '/////', '//'])('rejects %s', (text) => {
    expect(run(parseSky, text)).toBeNull();
  });
});

describe('temperature', () => {
  const cases: [string, unknown][] = [
    ['09/M04', { temperature: 9, dewpoint: -4 }],
    ['M02/M05', { temperature: -2, dewpoint: -5 }],
    ['26/11', { temperature: 26, dewpoint: 11 }],
    ['09/', { temperature: 9, dewpoint: null }],
    ['09///', { temperature: 9, dewpoint: null }],
    ['///M04', { temperature: null, dewpoint: -4 }],
    ['M00/M02', { temperature: 0, dewpoint: -2 }],
    ['00/00', { temperature: 0, dewpoint: 0 }],
  ];
  it.each(cases)('%s', (text, value) => {
    expect(run(parseTemperature, text)).toEqual({ value, consumed: 1 });
  });

  it.each(['//', '/', '////', '9/4', '091/04', 'A3012', '1/2SM'])('rejects %s', (text) => {
    expect(run(parseTemperature, text)).toBeNull();
  });
});

describe('altimeter', () => {
  const cases: [string, unknown][] = [
    ['A3012', { unit: 'inHg', value: 30.12 }],
    ['A2992', { unit: 'inHg', value: 29.92 }],
    ['Q1013', { unit: 'hPa', value: 1013 }],
    ['Q0998', { unit: 'hPa', value: 998 }],
    ['A////', { unit: 'inHg', value: null }],
    ['Q////', { unit: 'hPa', value: null }],
    ['QNH2992INS', { unit: 'inHg', value: 29.92 }],
  ];
  it.each(cases)('%s', (text, value) => {
    expect(run(parseAltimeter, text)).toEqual({ value, consumed: 1 });
  });

  it.each(['A301', 'Q10133', 'QNH761', '3012', 'AUTO'])('rejects %s', (text) => {
    expect(run(parseAltimeter, text)).toBeNull();
  });
});

describe('time', () => {
  it('decodes ddhhmmZ', () => {
    expect(run(parseDayTime, '141851Z')).toEqual({ value: { day: 14, hour: 18, minute: 51 }, consumed: 1 });
    expect(run(parseDayTime, '312400Z')).toEqual({ value: { day: 31, hour: 24, minute: 0 }, consumed: 1 });
  });

  it.each(['001851Z', '321851Z', '142551Z', '141860Z', '141851', '1418Z'])('rejects %s', (text) => {
    expect(run(parseDayTime, text)).toBeNull();
  });

  it('decodes TAF validity ddhh/ddhh', () => {
    expect(run(parseValidity, '1418/1518')).toEqual({
      value: { from: { day: 14, hour: 18, minute: 0 }, to: { day: 15, hour: 18, minute: 0 } },
      consumed: 1,
    });
    expect(run(parseValidity, '0700/0724')).toEqual({
      value: { from: { day: 7, hour: 0, minute: 0 }, to: { day: 7, hour: 24, minute: 0 } },
      consumed: 1,
    });
  });

  it.each(['1418/1525', '0018/0118', '141851Z', '1418'])('rejects validity %s', (text) => {
    expect(run(parseValidity, text)).toBeNull();
  });
});
