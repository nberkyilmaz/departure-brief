/**
 * The briefing read back: a card per field and a short list of what crossed
 * a limit. Nothing here may be lost on the way — every finding that asked
 * for attention has to land in exactly one line.
 *
 * The gusty afternoon is the briefing that prompted this: CYSN with a TAF
 * whose TEMPO and PROB30 groups each crossed the same limits, which the
 * page used to print as a dozen rows, four of them the same wind. The
 * findings are as the rules wrote them, trimmed to the fields read here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { concernsOf, fieldCards } from '../src/summary.js';
import type { Attention, BasisKind, Finding, NavLogLeg, PointReview, StoredBriefing } from '../src/types.js';

const f = (rule: string, attention: Attention, basisKind: BasisKind, basis: string, summary: string, values: Record<string, unknown> = {}): Finding => ({
  rule,
  attention,
  basisKind,
  basis,
  summary,
  values,
  waypoint: 'CYSN',
  at: '2026-10-29T21:00:00.000Z',
  citations: [],
});

const tempo = 'TEMPO 21:00Z–01:00Z';
const prob = 'PROB30 21:00Z–00:00Z';
const runways = (end: string, crosswind: number, crosswindGust: number, headwind: number) => [{ runway: end, end, heading: 0, crosswind, headwind, crosswindGust, headwindGust: headwind }];

const gusty: Finding[] = [
  f('personal.ceiling', 'routine', 'prevailing', 'prevailing', 'no ceiling (SCT040); personal minimum 2500 ft AGL', { ceiling: null, minimum: 2500 }),
  f('personal.visibility', 'routine', 'prevailing', 'prevailing', 'visibility >6 SM meets personal minimum 5 SM', { visibilitySm: 6, text: '>6 SM', minimum: 5 }),
  f('wind.surface', 'caution', 'prevailing', 'prevailing', 'wind from 240°T at 15 kt gusting 25 — more than your 15 kt crosswind limit in total', { directionTrue: 240, variable: false, speedKt: 15, gustKt: 25, crosswindLimit: 15, comparedAgainst: 25 }),
  f('crosswind.personal', 'routine', 'prevailing', 'prevailing', 'wind 24015G25KT: 9 kt crosswind within personal limit 15 kt', { speedKt: 15, variable: false, bestRunway: '24', crosswindKt: 9, limit: 15, runways: runways('24', 5, 9, 14) }),
  f('personal.ceiling', 'caution', 'overlay', tempo, 'ceiling 2000 ft AGL is below personal minimum 2500 ft', { ceiling: 2000, minimum: 2500 }),
  f('wind.surface', 'caution', 'overlay', tempo, 'wind from 240°T at 15 kt gusting 25 — more than your 15 kt crosswind limit', { speedKt: 15, gustKt: 25, crosswindLimit: 15, comparedAgainst: 25 }),
  f('vfr.cloudClearance', 'caution', 'overlay', tempo, 'BKN020 base 2321 ft MSL is 1179 ft below your 3500 ft cruise', { baseMsl: 2321, cruiseMsl: 3500, clearance: -1179, required: 500 }),
  f('weather.present', 'caution', 'overlay', prob, 'TSRA — a thunderstorm with rain'),
  f('personal.ceiling', 'caution', 'overlay', prob, 'ceiling 1200 ft AGL is below personal minimum 2500 ft', { ceiling: 1200, minimum: 2500 }),
  f('personal.visibility', 'caution', 'overlay', prob, 'visibility 2 SM is below personal minimum 5 SM', { visibilitySm: 2, text: '2 SM', minimum: 5 }),
  f('wind.surface', 'caution', 'overlay', prob, 'wind variable at 20 kt gusting 35', { variable: true, speedKt: 20, gustKt: 35, crosswindLimit: 15, comparedAgainst: 35 }),
  f('crosswind.personal', 'caution', 'overlay', prob, 'wind VRB20G35KT: 35 kt crosswind exceeds personal limit 15 kt', { speedKt: 20, variable: true, bestRunway: '01', crosswindKt: 35, limit: 15, runways: runways('01', 20, 35, 0) }),
  f('crosswind.demonstrated', 'caution', 'overlay', prob, '35 kt crosswind exceeds C172 demonstrated 15 kt', { crosswindKt: 35, demonstrated: 15 }),
  f('vfr.visibility', 'caution', 'overlay', prob, 'visibility 2 SM is below CARs 602.114 (control zone) minimum 3 SM', { visibilitySm: 2, text: '2 SM', minimum: 3, rule: 'CARs 602.114 (control zone)' }),
  f('vfr.cloudClearance', 'caution', 'overlay', prob, 'BKN012 base 1521 ft MSL is 1979 ft below your 3500 ft cruise', { baseMsl: 1521, cruiseMsl: 3500, clearance: -1979, required: 500 }),
  f('observation.age', 'routine', 'observed', 'observation', 'CYSN observation issued 19:00Z, 54 min ago'),
  f('wind.surface', 'caution', 'observed', 'observed 19:00Z', 'wind from 230°T at 20 kt gusting 30', { directionTrue: 230, variable: false, speedKt: 20, gustKt: 30, crosswindLimit: 15, comparedAgainst: 30 }),
  f('wind.aloft', 'routine', 'forecast', 'FBCN33 upper wind', 'wind at 3,500 ft: 250°T at 30 kt, +4 °C', { altitudeFt: 3500, directionTrue: 250, speedKt: 30, tempC: 4 }),
];

function stored(points: PointReview[], legs: Partial<NavLogLeg>[] = []): StoredBriefing {
  return {
    sha256: 'x',
    flightKey: 'x',
    asOf: '2026-10-29T19:54:00.000Z',
    createdAt: '2026-10-29T19:54:00.000Z',
    document: {
      format: 3,
      plan: {} as never,
      asOf: '2026-10-29T19:54:00.000Z',
      notams: null,
      inputs: { points: [], alternate: null, reports: [] },
      briefing: { rulesVersion: 8, profile: { name: 'default', version: 1 }, aircraft: 'C172', asOf: '2026-10-29T19:54:00.000Z', points, alternate: null },
      navlog: { legs: legs as NavLogLeg[], alternate: null } as never,
      fuel: {} as never,
    },
  };
}

const point = (waypoint: string, findings: Finding[], over: Partial<PointReview> = {}): PointReview => ({
  waypoint,
  at: '2026-10-29T21:00:00.000Z',
  category: 'VFR',
  forecastCategory: 'VFR',
  night: false,
  findings: findings.map((x) => ({ ...x, waypoint })),
  ...over,
});

const afternoon = stored([point('CYSN', gusty), point('CYKF', [])], [{ distanceNm: 54.6, minutes: 31.2 }]);

describe('worth a look', () => {
  const concerns = concernsOf(afternoon);

  it('says a gusty afternoon in four lines, not fourteen', () => {
    expect(concerns.map((c) => c.topic)).toEqual(['weather', 'wind', 'cloud', 'visibility']);
    expect(concerns.every((c) => c.waypoint === 'CYSN' && c.attention === 'caution')).toBe(true);
  });

  it('loses nothing: every finding that asked for attention is behind exactly one line', () => {
    const asking = gusty.filter((x) => x.attention === 'alert' || x.attention === 'caution');
    const behind = concerns.flatMap((c) => c.findings);
    expect(behind).toHaveLength(asking.length);
    for (const x of asking) expect(behind.filter((y) => y.rule === x.rule && y.basis === x.basis && y.summary === x.summary)).toHaveLength(1);
  });

  it('leads with the worst case, in words, and says which parts of the forecast say so', () => {
    const by = Object.fromEntries(concerns.map((c) => [c.topic, c]));
    expect(by['weather']!.headline).toBe('A thunderstorm with rain');
    expect(by['weather']!.when).toEqual(['PROB30 21:00–00:00Z']);
    expect(by['wind']!.headline).toBe('Crosswind up to 35 kt with the wind variable, so on any runway, over your 15 kt limit');
    expect(by['wind']!.when).toEqual(['forecast for your time', 'TEMPO 21:00–01:00Z', 'PROB30 21:00–00:00Z', 'observed 19:00Z']);
    expect(by['cloud']!.headline).toBe('Ceiling as low as 1,200 ft, below your 2,500 ft minimum; cloud base as low as 1,521 ft above sea level, under your 3,500 ft cruise');
    expect(by['visibility']!.headline).toBe('Visibility as low as 2 SM, below your 5 SM minimum; below the legal 3 SM (CARs 602.114 (control zone))');
  });

  it('puts alerts before cautions, and the departure before the destination', () => {
    const alertLater = stored([
      point('CYSN', [f('personal.visibility', 'caution', 'overlay', tempo, 'visibility 3 SM is below personal minimum 5 SM', { visibilitySm: 3, minimum: 5 })]),
      point('CYKF', [f('personal.visibility', 'alert', 'prevailing', 'prevailing', 'visibility 2 SM is below personal minimum 5 SM', { visibilitySm: 2, minimum: 5 })]),
    ]);
    expect(concernsOf(alertLater).map((c) => `${c.attention} ${c.waypoint}`)).toEqual(['alert CYKF', 'caution CYSN']);
  });

  it('leaves a forecast that does not cover the time to the card and the gaps, rather than saying it a third time', () => {
    const uncovered = stored([point('CYSN', [f('forecast.coverage', 'caution', 'forecast', 'forecast', 'no TAF for CYSN and none within reach — nothing to evaluate at ETA')])]);
    expect(concernsOf(uncovered)).toEqual([]);
  });
});

describe('a card per field', () => {
  const [departure, destination] = fieldCards(afternoon);

  it('gives the numbers a pilot asks for first, at the time they are there', () => {
    expect(departure!.role).toBe('Departure');
    expect(departure!.category).toBe('VFR');
    expect(Object.fromEntries(departure!.lines.map((l) => [l.label, l.text]))).toEqual({
      Wind: '240°T at 15 kt, gusts 25',
      Runway: '24: 5 kt across (9 in gusts), 14 kt headwind',
      Ceiling: 'No ceiling',
      Visibility: 'More than 6 SM',
      'At 3,500 ft': '250°T at 30 kt, +4 °C',
    });
    expect(departure!.lines.some((l) => l.over)).toBe(false);
  });

  it('says where it was read from, and what it is like now', () => {
    expect(departure!.source).toBe('Forecast for your time from the CYSN TAF.');
    expect(departure!.now).toBe('Now: VFR, wind 230°T at 20 kt, gusts 30 (observed 19:00Z).');
  });

  it('carries the leg that arrives at it, from the nav log', () => {
    expect(destination!.role).toBe('Destination');
    expect(destination!.leg).toMatchObject({ distanceNm: 54.6, minutes: 31.2 });
  });

  it('marks a line that crosses your limit', () => {
    const low = fieldCards(stored([point('CYSN', [f('personal.ceiling', 'alert', 'prevailing', 'prevailing', 'ceiling 1200 ft AGL is below personal minimum 2500 ft', { ceiling: 1200, minimum: 2500 })])]))[0]!;
    expect(low.lines.find((l) => l.label === 'Ceiling')).toEqual({ label: 'Ceiling', text: '1,200 ft, below your 2,500 ft', over: true });
  });

  it('says when no upper wind forecast reaches the field, rather than leaving the line off', () => {
    expect(destination!.lines).toEqual([{ label: 'Wind aloft', text: 'No upper wind forecast within reach', over: false }]);
  });

  it('falls back to the observation when no forecast covers the time, and says so', () => {
    const late = fieldCards(stored([point('CYSN', gusty.filter((x) => x.basisKind !== 'prevailing' && x.basisKind !== 'overlay'), { category: 'MVFR', forecastCategory: null })]))[0]!;
    expect(late.category).toBe('MVFR');
    expect(late.source).toBe('No forecast covers your time, so this is the latest observation (observed 19:00Z).');
    expect(late.now).toBeNull();
    expect(late.lines[0]).toEqual({ label: 'Wind', text: '230°T at 20 kt, gusts 30', over: false });
  });

  it('says why a card is empty rather than leaving it blank', () => {
    const empty = fieldCards(stored([point('CYSN', [f('forecast.coverage', 'caution', 'forecast', 'forecast', 'no TAF for CYSN and none within reach — nothing to evaluate at ETA')], { category: null, forecastCategory: null })]))[0]!;
    expect(empty.missing).toBe('No TAF for CYSN and none within reach — nothing to evaluate at ETA');
    expect(empty.category).toBeNull();
  });
});

describe('the recorded flight', () => {
  const recorded = JSON.parse(readFileSync(join(__dirname, '..', 'public', 'demo', 'briefing.json'), 'utf8')) as StoredBriefing;

  it('names a borrowed forecast on the card, with how far it came', () => {
    const [cysn] = fieldCards(recorded);
    expect(cysn!.source).toBe('Forecast for your time from the KIAG TAF, 11 nm away. CYSN has no forecast of its own.');
    expect(cysn!.lines.find((l) => l.label === 'Wind')!.text).toBe('Variable at 4 kt');
  });

  it('has nothing to look at on a quiet night, and says nothing', () => {
    expect(concernsOf(recorded)).toEqual([]);
  });
});
