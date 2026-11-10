/**
 * Fuel from the handbook: the copied tables, the rule for reading them,
 * and a real flight worked through them.
 *
 * The yardstick is the handbook's own sample problem on pages 5-5 to 5-7
 * of the 172M's: 5,500 ft, 16 °C above standard, 2500 RPM, a climb from
 * 1,000 ft. Where this reads a printed figure exactly it must agree with
 * the handbook to the tenth; where it reads between them it must never be
 * kinder than the figures either side.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchedFigures, wordReadings } from '../../src/docs/extract/table.js';
import { readCachedDocument } from '../../src/docs/reader/ingest.js';
import { parseFlightPlan } from '../../src/domain/flight.js';
import type { HttpClient } from '../../src/fetch/http.js';
import { NavCanadaClient } from '../../src/fetch/navcanada.js';
import { readOurAirportsDirectory } from '../../src/fetch/ourairports.js';
import { navLog } from '../../src/navlog/compute.js';
import { fuelPlan } from '../../src/navlog/fuel.js';
import { cruiseAtAnyTemperature, performanceFor, rpmsAt } from '../../src/perf/aircraft.js';
import { checkPerformance, formatPerformance } from '../../src/perf/check.js';
import { columnName, deviationC, pressureAltitudeFt, readClimb, readCruise } from '../../src/perf/read.js';
import type { PerformanceSpec } from '../../src/perf/types.js';
import { resolveFlight } from '../../src/resolve/flight.js';
import { checkFuel } from '../../src/rules/fuel.js';
import { storeAndDecode } from '../../src/store/decode.js';
import { MemoryStore } from '../../src/store/memory.js';

const ROOT = join(__dirname, '..', '..', '..', '..');
const FILE = join(ROOT, 'aircraft', 'c172.performance.json');
const spec = JSON.parse(readFileSync(FILE, 'utf8')) as PerformanceSpec;

describe('the copied tables', () => {
  it('has every printed row: five at 2,000 and 4,000 ft, six above, and thirteen climb rows', () => {
    const per = new Map<number, number>();
    for (const r of spec.cruise.rows) per.set(r.pressureAltitudeFt, (per.get(r.pressureAltitudeFt) ?? 0) + 1);
    expect([...per]).toEqual([
      [2000, 5],
      [4000, 5],
      [6000, 6],
      [8000, 6],
      [10000, 6],
      [12000, 6],
    ]);
    expect(spec.cruise.rows.every((r) => r.cells.length === 3)).toBe(true);
    expect(spec.climb.rows.map((r) => r.pressureAltitudeFt)).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000]);
  });

  it('falls in every column as the RPM comes down, so no figure was copied into the wrong row', () => {
    for (const altitude of new Set(spec.cruise.rows.map((r) => r.pressureAltitudeFt))) {
      const rows = spec.cruise.rows.filter((r) => r.pressureAltitudeFt === altitude);
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.rpm).toBeLessThan(rows[i - 1]!.rpm);
        for (let c = 0; c < 3; c++) {
          for (let f = 0; f < 3; f++) expect(rows[i]!.cells[c]![f]).toBeLessThanOrEqual(rows[i - 1]!.cells[c]![f]!);
        }
      }
    }
  });

  it('never burns less at a higher power anywhere in the table, so no burn was copied into the wrong column', () => {
    const cells = spec.cruise.rows.flatMap((r) => r.cells).sort((a, b) => a[0] - b[0] || a[2] - b[2]);
    for (let i = 1; i < cells.length; i++) {
      if (cells[i]![0] > cells[i - 1]![0]) expect(cells[i]![2]).toBeGreaterThanOrEqual(cells[i - 1]![2]);
    }
  });

  it('climbs the standard atmosphere it says it does, and only ever adds time, fuel and distance', () => {
    for (const r of spec.climb.rows) expect(r.tempC).toBe(15 - (2 * r.pressureAltitudeFt) / 1000);
    for (let i = 1; i < spec.climb.rows.length; i++) {
      const [a, b] = [spec.climb.rows[i - 1]!, spec.climb.rows[i]!];
      expect(b.minutes).toBeGreaterThanOrEqual(a.minutes);
      expect(b.gal).toBeGreaterThan(a.gal);
      expect(b.nm).toBeGreaterThan(a.nm);
    }
  });

  it('keeps one printed row to a line, and reads back as it was written', () => {
    const text = readFileSync(FILE, 'utf8');
    expect(formatPerformance(spec)).toBe(text);
    expect(text.split('\n').filter((l) => l.includes('"pressureAltitudeFt"'))).toHaveLength(
      spec.cruise.rows.length + spec.climb.rows.length + spec.takeoff.rows.length + spec.landing.rows.length,
    );
  });
});

describe('what the scan bears out', () => {
  it('agrees with the scan line recorded for each row, figure by figure', () => {
    // Re-run on the lines as stored: a flag that does not follow from its own line would be a claim nothing backs.
    spec.cruise.rows.forEach((r, i) => {
      if (!r.scan || r.scan.text === '') return;
      const first = i === 0 || spec.cruise.rows[i - 1]!.pressureAltitudeFt !== r.pressureAltitudeFt;
      const values = [...(first ? [r.pressureAltitudeFt] : []), r.rpm, ...r.cells.flat()];
      const names = [...(first ? ['altitude'] : []), 'rpm', ...spec.cruise.columnsC.flatMap((c) => ['bhp', 'ktas', 'gph'].map((f) => `${columnName(c)}.${f}`))];
      const found = new Set(matchedFigures(values, r.scan.text.split(' ').map(wordReadings)));
      expect(names.filter((_, k) => !found.has(k))).toEqual(r.scan.unconfirmed);
    });
  });

  it('reads a table rule stuck to a figure as the figure, and never a letter as a digit it is not', () => {
    // All from the 172M's cruise page as its OCR has it.
    expect(wordReadings('2500)')).toEqual([2500]);
    expect(wordReadings('2400¢')).toEqual([2400]);
    // A comma between digits is also the scanner's slip for a decimal point, so both readings stand.
    expect(wordReadings('10,000')).toContain(10000);
    expect(wordReadings('a8')).toEqual([]);
    expect(wordReadings('7%')).toEqual([]);
    expect(wordReadings('83')).toEqual([83]);
  });

  it('names the row the scan lost altogether, every figure in it', () => {
    // The scan reads 12,000 ft at 2300 RPM as "23001 48 28 8.0 45 a5 5.9 43 a4 8.7": two of its ten, in order.
    const row = spec.cruise.rows.find((r) => r.pressureAltitudeFt === 12000 && r.rpm === 2300)!;
    expect(row.scan!.text).toBe('');
    expect(row.scan!.unconfirmed).toHaveLength(10);
  });

  it('finds both notes the climb fuel rests on', () => {
    expect(spec.climb.allowanceGal.scan!.unconfirmed).toEqual([]);
    expect(spec.climb.warmPercentPer10C.scan!.unconfirmed).toEqual([]);
  });

  const CACHE = process.env['DEPBRIEF_DOC_CACHE'] ?? join(ROOT, 'data', 'docs');
  const doc = existsSync(join(CACHE, spec.source.documentSha256)) ? readCachedDocument(CACHE, spec.source.documentSha256) : null;
  it.skipIf(!doc)('is what checking the owner\'s own scan again writes, byte for byte (needs the scan, which is not committed)', () => {
    expect(formatPerformance(checkPerformance(doc!, spec).spec)).toBe(readFileSync(FILE, 'utf8'));
  });
});

describe('reading the cruise table', () => {
  it('gives the handbook\'s own figures where it prints them: 6,000 ft, 20 °C above, 2500 RPM is 62%, 109 kt, 7.0 gal/h', () => {
    const r = readCruise(spec.cruise, 6000, 20, 2500);
    if ('problem' in r) throw new Error(r.problem);
    expect([r.burnCell.bhp, r.ktas, r.gph]).toEqual([62, 109, 7.0]);
    expect(r.around).toHaveLength(1);
  });

  it('between rows and columns, takes the highest burn and the lowest speed printed either side', () => {
    // The sample problem's own flight, which the handbook reads as the nearest figure, 7.0.
    const r = readCruise(spec.cruise, 5500, 16, 2500);
    if ('problem' in r) throw new Error(r.problem);
    expect(r.around.map((c) => `${c.pressureAltitudeFt} ${c.columnC} ${c.gph}`)).toEqual(['4000 0 7.5', '4000 20 7.2', '6000 0 7.2', '6000 20 7']);
    expect(r.gph).toBe(7.5);
    expect([r.burnCell.pressureAltitudeFt, r.burnCell.columnC]).toEqual([4000, 0]);
    expect(r.ktas).toBe(109);
    expect([r.speedCell.pressureAltitudeFt, r.speedCell.columnC]).toEqual([6000, 20]);
  });

  it('reads every column when there is no temperature, since the burn could be any of them', () => {
    const r = readCruise(spec.cruise, 6000, null, 2500);
    if ('problem' in r) throw new Error(r.problem);
    expect(r.around).toHaveLength(3);
    expect([r.gph, r.ktas]).toEqual([7.6, 109]);
  });

  it('gives nothing outside the table, and says which edge', () => {
    expect(readCruise(spec.cruise, 1500, 0, 2400)).toEqual({ problem: "1,500 ft pressure altitude is below the handbook's cruise table, which runs from 2,000 ft to 12,000 ft" });
    expect(readCruise(spec.cruise, 12500, 0, 2400)).toEqual({ problem: "12,500 ft pressure altitude is above the handbook's cruise table, which runs from 2,000 ft to 12,000 ft" });
    expect(readCruise(spec.cruise, 7000, 0, 2650)).toEqual({ problem: "the handbook's cruise table does not print 2650 RPM at 8,000 ft; it gives 2200 to 2700 there" });
    expect(readCruise(spec.cruise, 6000, -23, 2400)).toEqual({
      problem: "the temperature at cruise is 23 °C below standard, past the 20 °C either side of standard the handbook's cruise table covers",
    });
  });

  it('carries what the scan made of each cell it used', () => {
    // 2,000 ft 2550 RPM, 20 below: the scan has 8.5 where the page prints 8.8.
    const lost = readCruise(spec.cruise, 2000, -20, 2550);
    if ('problem' in lost) throw new Error(lost.problem);
    expect(lost.burnCell.scanned.gph).toBe(false);
    const borne = readCruise(spec.cruise, 6000, 20, 2500);
    if ('problem' in borne) throw new Error(borne.problem);
    expect(borne.burnCell.scanned.gph).toBe(true);
  });

  it('offers only the power settings printed at both rows either side, and the form\'s speed is the lowest of any column', () => {
    expect(rpmsAt(spec, 7000)).toEqual([2600, 2500, 2400, 2300, 2200]);
    expect(rpmsAt(spec, 8000)).toEqual([2700, 2600, 2500, 2400, 2300, 2200]);
    expect(cruiseAtAnyTemperature(spec, 5500, 2500)).toEqual({ ktas: 109, gphLow: 7.0, gphHigh: 7.9 });
  });
});

describe('reading the climb table', () => {
  it('works the handbook\'s own climb: 1,000 to 6,000 ft is 2.0 gal and 14 nm, and 16 °C above standard makes it 2.3 and 16', () => {
    expect(readClimb(spec.climb, 1000, 6000, null)).toEqual({ fromRowFt: 1000, toRowFt: 6000, percent: 0, gal: 2.0, nm: 14, minutes: 10 });
    expect(readClimb(spec.climb, 1000, 6000, 16)).toEqual({ fromRowFt: 1000, toRowFt: 6000, percent: 16, gal: 2.3, nm: 16, minutes: 12 });
  });

  it('takes the field\'s row at or below it and the cruise\'s at or above, as the example takes 6,000 for 5,500', () => {
    expect(readClimb(spec.climb, 1300, 5500, 0)).toMatchObject({ fromRowFt: 1000, toRowFt: 6000, gal: 2.0 });
    // Below sea level pressure altitude, the lowest row printed.
    expect(readClimb(spec.climb, -300, 3000, 0)).toMatchObject({ fromRowFt: 0, toRowFt: 3000, gal: 1.1 });
  });

  it('adds nothing for a cold day, nothing for no climb, and refuses past the top of the table', () => {
    expect(readClimb(spec.climb, 1000, 6000, -10)).toMatchObject({ percent: 0, gal: 2.0 });
    expect(readClimb(spec.climb, 5000, 4500, 0)).toMatchObject({ gal: 0, nm: 0 });
    expect(readClimb(spec.climb, 0, 13000, 0)).toEqual({ problem: "13,000 ft pressure altitude is above the handbook's climb table, which ends at 12,000 ft" });
  });
});

describe('pressure altitude and temperature', () => {
  it('uses the rule a pilot uses: a thousand feet an inch, thirty a hectopascal', () => {
    expect(pressureAltitudeFt(5500, { unit: 'inHg', value: 30.12 as never })).toBe(5300);
    expect(pressureAltitudeFt(5500, { unit: 'hPa', value: 1003 as never })).toBe(5808);
    expect(pressureAltitudeFt(5500, null)).toBeNull();
  });

  it('counts degrees from standard to the whole degree', () => {
    // The handbook's example: standard at 5,500 ft is 4 °C, so 16 °C above it is 20 °C.
    expect(deviationC(20, 5500)).toBe(16);
    // Toronto's 5 °C at 3,500 ft, where standard is 8 °C.
    expect(deviationC(5, 3500)).toBe(-3);
  });
});

/* A real flight: my own, St. Catharines to Waterloo, against the Toronto upper winds recorded for it. */
const FIXTURES = join(__dirname, '..', 'fixtures', 'fetch');
const UPPERWIND = join(FIXTURES, 'navcanada', 'upperwind', '2026-09-14');
const replay: HttpClient = {
  async get(url) {
    const sites = [...url.matchAll(/site=([A-Z0-9]{3,4})/g)].map((m) => m[1]!);
    const data: unknown[] = [];
    for (const site of sites) {
      try {
        data.push(...(JSON.parse(readFileSync(join(UPPERWIND, `${site}.json`), 'utf8')) as { data: unknown[] }).data);
      } catch {
        // Not an upper wind site.
      }
    }
    return { status: 200, body: JSON.stringify({ meta: {}, data }), headers: {} };
  },
};

async function flight(cruise: { rpm?: number; altitude?: number } = {}) {
  const base = JSON.parse(readFileSync(join(ROOT, 'flights', 'demo-cysn-cykf.json'), 'utf8'));
  const plan = parseFlightPlan({ ...base, departureTime: '2026-09-14T06:00:00Z', cruise: { ...base.cruise, ...cruise } });
  const store = new MemoryStore();
  await store.putAirports(readOurAirportsDirectory(join(FIXTURES, 'ourairports', '2026-09-07'), { snapshot: '2026-09-07' }));
  const fetched = await new NavCanadaClient(replay).upperWinds(['CYYZ']);
  await storeAndDecode(store, fetched.reports, fetched.request, new Date('2026-09-14T04:30:00Z'), 'CYYZ');
  return resolveFlight(store, plan, new Date('2026-09-14T05:00:00Z'));
}

describe('a real flight through the tables', () => {
  it('starts with the allowance and the climb, and flies the rest at the handbook\'s burn for its temperature', async () => {
    const log = navLog(await flight({ rpm: 2400 }), null, spec);
    const h = log.handbook!;
    // Toronto forecasts 5 °C at 3,500 ft: 3 °C below standard, so the 20-below and standard columns, between 2,000 and 4,000 ft.
    expect(h.pressureAltitudeFt).toBe(3500);
    expect(h.notes).toEqual(['no altimeter setting at CYSN, so altitudes are read as pressure altitudes']);
    expect(h.allowance.gal).toBe(1.1);
    // From the 321 ft field: sea level to 4,000 ft, a cold day, so the table as printed.
    expect(h.climb).toEqual({ fromFt: 321, toFt: 3500, fromRowFt: 0, toRowFt: 4000, deviationC: -3, percent: 0, gal: 1.5, nm: 9, minutes: 7 });

    const leg = log.legs[0]!;
    expect(leg.burn!.source).toBe('handbook');
    expect(leg.burn!.handbook!.deviationC).toBe(-3);
    expect(leg.burn!.handbook!.around.map((c) => c.gph)).toEqual([7.5, 7.2, 7.3, 6.9]);
    expect(leg.burn!.gph).toBe(7.5);
    expect(leg.burn!.handbook!.speedCell.ktas).toBe(106);
    // The climb's nine miles come off the leg's cruise; its time does not change.
    expect(leg.climbNm).toBe(9);
    expect(leg.minutes).toBe(Math.round((leg.distanceNm / leg.groundspeedKt!) * 60));
    expect(leg.fuelGal).toBeCloseTo(((leg.distanceNm - 9) / leg.groundspeedKt!) * 7.5, 1);
    expect(log.totalFuelGal).toBe(Math.round((1.1 + 1.5 + leg.fuelGal!) * 10) / 10);
    expect(leg.cumulativeFuelGal).toBe(log.totalFuelGal);
    expect(log.fuelGph).toBe(7.5);
    expect(log.fuelProblem).toBeNull();
  });

  it('says what the trip is made of, at what burn, and cites the page for each', async () => {
    const log = navLog(await flight({ rpm: 2400 }), null, spec);
    const plan = fuelPlan(log, 20, false);
    expect(plan).toMatchObject({ allowanceGal: 1.1, climbGal: 1.5, cruiseGal: log.legs[0]!.fuelGal, reserve: { gal: 3.8 } });
    const [f] = checkFuel({ waypoint: 'CYKF', at: new Date('2026-09-14T06:40:00Z'), nightAt: null }, plan, log);
    expect(f!.summary).toContain(`(1.1 start, taxi and takeoff, 1.5 climb, ${log.legs[0]!.fuelGal} cruise)`);
    expect(f!.summary).toContain("at 7.5 gal/h, the highest of the handbook's figures for 2400 RPM around this flight");
    expect(f!.citations.slice(1).map((c) => c.text)).toEqual([
      'C172MPOH.pdf p.76 (5-16), Figure 5-7, Cruise Performance: 2,000 ft, 2400 RPM, 20 °C below standard: 7.5 gal/h',
      'C172MPOH.pdf p.75 (5-15), Figure 5-6, Time, Fuel, and Distance to Climb: sea level to 4,000 ft, 1.5 gal',
      'C172MPOH.pdf p.75 (5-15), note 1: "Add 1.1 gallons of fuel for engine start, taxi and takeoff allowance."',
    ]);
    expect(f!.citations.slice(1).every((c) => c.kind === 'aircraft' && c.sha256 === spec.source.documentSha256)).toBe(true);
  });

  it('uses a burn typed into the aircraft settings on every leg, and still the handbook\'s allowance and climb', async () => {
    const log = navLog(await flight({ rpm: 2400 }), 8.5, spec);
    expect(log.legs[0]!.burn).toEqual({ gph: 8.5, source: 'aircraft', handbook: null });
    expect(log.handbook!.climb!.gal).toBe(1.5);
    expect(log.fuelGph).toBe(8.5);
  });

  it('with no power setting and no burn typed in, says so instead of guessing one', async () => {
    const log = navLog(await flight(), null, spec);
    expect(log.legs[0]!.burn).toBeNull();
    expect(log.totalFuelGal).toBeNull();
    expect(log.fuelProblem).toBe('no power setting chosen for the Cessna 172M, 1976 cruise table and no cruise burn typed in');
    expect(fuelPlan(log, 20, false).gaps[0]).toBe(
      'no power setting chosen for the Cessna 172M, 1976 cruise table and no cruise burn typed in, so neither the trip fuel nor the reserve can be worked out',
    );
  });

  it('below the table, gives no burn and says where the table starts', async () => {
    const log = navLog(await flight({ rpm: 2400, altitude: 1500 }), null, spec);
    expect(log.legs[0]!.fuelGal).toBeNull();
    expect(log.legs[0]!.gaps).toContain("1,500 ft pressure altitude is below the handbook's cruise table, which runs from 2,000 ft to 12,000 ft");
    expect(log.fuelProblem).toBe("1,500 ft pressure altitude is below the handbook's cruise table, which runs from 2,000 ft to 12,000 ft");
  });

  it('is used only for the aircraft it was printed for', () => {
    expect(performanceFor({ type: 'c172' }, spec)).toBe(spec);
    expect(performanceFor({ type: 'PA28' }, spec)).toBeNull();
  });
});
