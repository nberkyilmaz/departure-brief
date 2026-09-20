import { describe, expect, it } from 'vitest';
import { decodeMetar } from '../../src/decode/metar/index.js';
import { explainMetar } from '../../src/explain/metar.js';

/**
 * Reading a METAR back in words.
 *
 * The reports here are real ones out of the recorded fixtures. The rule
 * every case checks is the same: say what the report says and stop. A
 * reading that is missing is said to be missing, never filled in; a group
 * the decoder did not recognise is listed rather than dropped; and every
 * line points at the characters it came from, so a reader can check it.
 */

const lines = (raw: string) => explainMetar(decodeMetar(raw));
const find = (raw: string, label: string) => lines(raw).filter((l) => l.label === label);
const one = (raw: string, label: string) => {
  const found = find(raw, label);
  expect(found).toHaveLength(1);
  return found[0]!;
};

/** Every line must point at text that is actually in the report. */
function spansAreHonest(raw: string) {
  for (const line of lines(raw)) {
    if (line.span === null) continue;
    expect(line.span.start).toBeGreaterThanOrEqual(0);
    expect(line.span.end).toBeLessThanOrEqual(raw.length);
    expect(line.span.end).toBeGreaterThan(line.span.start);
  }
}

describe('a routine report', () => {
  // KIAG, recorded 19 September 2026.
  const raw = 'METAR KIAG 190253Z AUTO 36005KT 10SM CLR 14/10 A3023 RMK AO2 SLP237 T01440100 53005';

  it('reads every group back', () => {
    expect(one(raw, 'Station').text).toBe('KIAG');
    expect(one(raw, 'Observed').text).toBe('day 19 of the month at 02:53 Zulu');
    expect(one(raw, 'Modifier').text).toMatch(/automated, no human observer/);
    expect(one(raw, 'Wind').text).toBe('from 360° true at 5 kt');
    expect(one(raw, 'Visibility').text).toBe('10 statute miles');
    expect(one(raw, 'Cloud').text).toMatch(/no cloud below 12,000 ft/);
    expect(one(raw, 'Temperature').text).toBe('14 °C, dew point 10 °C');
    expect(one(raw, 'Altimeter').text).toBe('30.23 inHg');
  });

  it('points each line at the characters it was read from', () => {
    spansAreHonest(raw);
    const wind = one(raw, 'Wind');
    expect(raw.slice(wind.span!.start, wind.span!.end)).toBe('36005KT');
    const temp = one(raw, 'Temperature');
    expect(raw.slice(temp.span!.start, temp.span!.end)).toBe('14/10');
  });

  it('flags nothing as indeterminate when everything was measured', () => {
    expect(lines(raw).some((l) => l.indeterminate)).toBe(false);
  });
});

describe('what a report says it could not measure', () => {
  it('a wind with no speed is not a calm wind', () => {
    const wind = one('METAR CYSN 190300Z 310//KT 15SM SKC 04/03 A2989', 'Wind');
    expect(wind.text).toMatch(/unavailable speed/);
    expect(wind.indeterminate).toBe(true);
  });

  it('a cloud layer with no base is not a missing layer', () => {
    const cloud = one('METAR CYSN 190300Z 31008KT 15SM BKN/// 04/03 A2989', 'Cloud');
    expect(cloud.text).toMatch(/broken at an unavailable height/);
    expect(cloud.indeterminate).toBe(true);
  });

  it('an obscured sky with no vertical visibility says so', () => {
    const cloud = one('METAR CYSN 190300Z 31008KT 1/2SM FG VV/// 04/03 A2989', 'Cloud');
    expect(cloud.text).toMatch(/obscured sky, vertical visibility reported unavailable/);
    expect(cloud.indeterminate).toBe(true);
  });

  it('calm is calm, and says so in one word', () => {
    expect(one('METAR CYSN 190300Z 00000KT 15SM SKC 04/03 A2989', 'Wind').text).toBe('calm');
  });
});

describe('the awkward groups', () => {
  it('variable wind with a range gives both', () => {
    const wind = one('METAR CYTZ 190300Z 36009G17KT 330V040 9SM FEW190 15/09 A3025', 'Wind');
    expect(wind.text).toBe('from 360° true at 9 kt, gusting 17 kt, varying between 330° and 040°');
  });

  it('a wind that is variable in direction is not given a direction', () => {
    expect(one('METAR CYSN 190300Z VRB03KT 15SM SKC 04/03 A2989', 'Wind').text).toBe('variable in direction at 3 kt');
  });

  it('expands CAVOK into the three things it asserts', () => {
    const vis = one('METAR EGLL 190320Z 27010KT CAVOK 18/12 Q1013', 'Visibility');
    expect(vis.text).toMatch(/10 km or more/);
    expect(vis.text).toMatch(/no cumulonimbus/);
    expect(vis.text).toMatch(/no significant weather/);
  });

  it('reads a hectopascal altimeter in its own unit', () => {
    expect(one('METAR EGLL 190320Z 27010KT CAVOK 18/12 Q1013', 'Altimeter').text).toBe('1013 hPa');
  });

  it('gives each cloud layer its own line, in the order reported', () => {
    const cloud = find('METAR CYYZ 190300Z 35009KT 15SM FEW040 BKN080 OVC150 14/07 A3025', 'Cloud');
    expect(cloud.map((c) => c.text)).toEqual(['few at 4,000 ft', 'broken at 8,000 ft', 'overcast at 15,000 ft']);
  });

  it('names the weather rather than repeating the code', () => {
    const wx = find('METAR CYSN 190300Z 31015G25KT 1SM +TSRA BKN008 OVC015 04/03 A2989', 'Weather');
    expect(wx).toHaveLength(1);
    expect(wx[0]!.text).toMatch(/thunderstorm/);
    expect(wx[0]!.text).toMatch(/rain/);
  });

  it('marks a special report as one', () => {
    expect(one('SPECI CYSN 190315Z 31008KT 15SM SKC 04/03 A2989', 'Type').text).toMatch(/special report/);
  });
});

describe('nothing invented, nothing dropped', () => {
  it('a report with no cloud group produces no cloud line', () => {
    // Absence of a group is not a reading of "none".
    expect(find('METAR CWWZ 190300Z AUTO 01013KT 18/10 RMK AO1', 'Cloud')).toEqual([]);
    expect(find('METAR CWWZ 190300Z AUTO 01013KT 18/10 RMK AO1', 'Visibility')).toEqual([]);
  });

  it('lists anything it could not decode instead of silently skipping it', () => {
    const odd = lines('METAR CYSN 190300Z 31008KT 15SM SKC 04/03 A2989 WOBBLE99');
    const undecoded = odd.filter((l) => l.label === 'Not decoded');
    expect(undecoded).toHaveLength(1);
    expect(undecoded[0]!.text).toBe('WOBBLE99');
    expect(undecoded[0]!.indeterminate).toBe(true);
  });

  it('never returns a line with empty text', () => {
    for (const raw of [
      'METAR KIAG 190253Z AUTO 36005KT 10SM CLR 14/10 A3023 RMK AO2',
      'METAR CYSN 190300Z VRB03KT 1/4SM FG VV002 04/04 A2989',
      'METAR CWWZ 190300Z AUTO 01013KT 18/10 RMK AO1 SLP233',
    ]) {
      for (const line of lines(raw)) {
        expect(line.label.length).toBeGreaterThan(0);
        expect(line.text.length).toBeGreaterThan(0);
      }
      spansAreHonest(raw);
    }
  });
});

describe('remarks', () => {
  it('reads the density altitude a Canadian field measured for itself', () => {
    // The figure this project would otherwise have to interpolate out of a
    // performance chart, measured by the field and printed in its own report.
    const r = one('METAR CYSN 190300Z 31008KT 15SM SKC 24/12 A2989 RMK DENSITY ALT 2100FT', 'Remark');
    expect(r.text).toBe('density altitude 2,100 ft');
  });

  it('reads the remarks a pilot acts on, in words', () => {
    const peak = one('METAR CWWZ 190300Z AUTO 01013KT 18/10 RMK PK WND 02025/0245', 'Remark');
    expect(peak.text).toMatch(/peak wind 020° at 25 kt/);

    const slp = one('METAR KIAG 190253Z AUTO 36005KT 10SM CLR 14/10 A3023 RMK SLP237', 'Remark');
    expect(slp.text).toMatch(/sea level pressure/);

    const ceiling = one('METAR CYSN 190300Z 31008KT 15SM BKN008 04/03 A2989 RMK CIG 005V010', 'Remark');
    expect(ceiling.text).toBe('ceiling varying between 500 and 1,000 ft');
  });

  it('shows a remark it does not paraphrase as the report wrote it', () => {
    const lines = explainMetar(decodeMetar('METAR CYHM 190000Z 36008KT 15SM BKN140 16/08 A3022 RMK AC6CI1 SLP239'));
    const remarks = lines.filter((l) => l.label.startsWith('Remark'));
    // Both appear: one decoded and paraphrased, one not decoded at all.
    expect(remarks.length).toBeGreaterThanOrEqual(2);
    expect(remarks.some((r) => r.text === 'AC6CI1')).toBe(true);
  });

  it('tells an undecoded remark apart from an undecoded body group', () => {
    const lines = explainMetar(decodeMetar('METAR CYHM 190000Z 36008KT 15SM BKN140 16/08 A3022 RMK AC6CI1'));
    const remark = lines.find((l) => l.text === 'AC6CI1');
    expect(remark?.label).toBe('Remark, not decoded');
    expect(remark?.indeterminate).toBe(true);

    const body = explainMetar(decodeMetar('METAR CYHM 190000Z 36008KT 15SM WOBBLE99 16/08 A3022')).find((l) => l.text === 'WOBBLE99');
    expect(body?.label).toBe('Not decoded');
  });
});
