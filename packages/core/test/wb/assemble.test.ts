import { describe, expect, it } from 'vitest';
import { findFigureOnPage, findFigureOnPages, WB_FIELDS } from '../../src/docs/extract/wb.js';
import { groupLines } from '../../src/docs/lines.js';
import type { DocumentOcr, PageOcr, WordBox } from '../../src/docs/types.js';
import { assembleWeightBalance, isCgPointName, missingFrom, type NamedFigure } from '../../src/wb/assemble.js';
import { transcribedFigures } from '../helpers/wbspec.js';

const fig = (name: string, value: NamedFigure['value']): NamedFigure => ({ name, value, source: null, note: null });

describe('assembleWeightBalance', () => {
  it('builds stations and envelopes only from the figures it has', () => {
    const spec = assembleWeightBalance('C172', null, transcribedFigures(), []);
    expect(spec.stations.map((s) => s.id)).toEqual(['front', 'rear', 'bag1', 'bag2', 'fuel', 'oil']);
    expect(spec.envelopes.map((e) => e.category)).toEqual(['normal', 'utility']);
    expect(spec.envelopes[0]!.forward.map((p) => p.weightLb)).toEqual([1950, 2300]);
    expect(missingFrom(spec)).toEqual([]);

    // Drop the rear arm: the rear station goes, and the gap is named.
    const withoutRear = assembleWeightBalance('C172', null, transcribedFigures().filter((f) => f.name !== 'rearSeatArmIn'), []);
    expect(withoutRear.stations.some((s) => s.id === 'rear')).toBe(false);
    expect(missingFrom(withoutRear).join(' ')).toContain('rearSeatArmIn');
  });

  it('names what a half-read handbook still needs, including a limit line that stops short', () => {
    const partial = assembleWeightBalance('C172', null, transcribedFigures().filter((f) => f.name !== 'cgForwardNormal[1]'), []);
    expect(missingFrom(partial).join(' ')).toContain('only reaches 1950 lb of the 2300 lb maximum');

    const noEnvelope = assembleWeightBalance('C172', null, [fig('frontSeatArmIn', 37)], []);
    expect(noEnvelope.envelopes).toEqual([]);
    expect(missingFrom(noEnvelope).join(' ')).toContain('no normal category envelope');
  });

  it('lets a later figure replace an earlier one of the same name, which is how a confirmation beats a reading', () => {
    const read: NamedFigure = { name: 'cgAftNormalIn', value: 47.3, source: null, note: 'read by a model' };
    const confirmed: NamedFigure = { name: 'cgAftNormalIn', value: 47.3, source: null, note: 'confirmed by hand against the handbook' };
    const spec = assembleWeightBalance('C172', null, [...transcribedFigures().filter((f) => f.name !== 'cgAftNormalIn'), read, confirmed], []);
    expect(spec.figures.filter((f) => f.name === 'cgAftNormalIn')).toHaveLength(1);
    expect(spec.envelopes.find((e) => e.category === 'normal')!.aftArmIn.note).toContain('confirmed by hand');
  });

  it('derives the oil arm from the weight and moment the handbook prints instead', () => {
    const spec = assembleWeightBalance('C172', null, [fig('oilWeightLb', 15), fig('oilMomentPer1000', -0.2)], []);
    const oil = spec.stations.find((s) => s.id === 'oil')!;
    expect(oil.armIn.value).toBe(-13.3);
    expect(oil.armIn.note).toContain('derived');
    expect(oil.fixedLb!.value).toBe(15);
  });

  it('knows a CG limit point by its name', () => {
    expect(isCgPointName('cgForwardNormal[0]')).toBe(true);
    expect(isCgPointName('cgForwardUtility[12]')).toBe(true);
    expect(isCgPointName('cgAftNormalIn')).toBe(false);
  });
});

/** A two-page document shaped like the pages a confirmation is checked against. */
function docOf(pages: string[][]): DocumentOcr {
  const built: PageOcr[] = pages.map((lines, p) => {
    const page = p + 1;
    let i = 0;
    const words: WordBox[] = lines.flatMap((text, row) =>
      text.split(' ').map((t, col) => ({ id: page * 100_000 + i++, page, text: t, x: 50 + col * 60, y: 100 + row * 40, w: 40, h: 12, confidence: 80 })),
    );
    return { page, widthPx: 1000, heightPx: 1000, rotation: 0, meanConfidence: 80, words, lines: groupLines(words), status: 'read', error: null };
  });
  return { sha256: 'x', filename: 'poh.pdf', pageCount: built.length, reader: { engine: 'tesseract.js', version: '0', lang: 'eng', scale: 3, readerVersion: 2 }, pages: built };
}

describe('confirming a figure against the handbook', () => {
  const doc = docOf([
    ['NORMAL CATEGORY', 'Maximum Takeoff Weight: 2300 Ibs.', 'Aft: 47. 3 inches aft of datum at all weights.'],
    ['Total Usable: 48 gallons', 'Fuel Tanks', '*37 73 **95'],
  ]);

  it('accepts a figure the handbook states beside words naming it', () => {
    const found = findFigureOnPages(doc, [1], 'maxTakeoffWeightNormalLb', WB_FIELDS.maxTakeoffWeightNormalLb, [2300])!;
    expect(found.verified).toBe(true);
    expect(found.page).toBe(1);
    expect(found.context).toContain('2300');
    // The aft limit wraps a split figure and still checks out.
    expect(findFigureOnPages(doc, [1], 'cgAftNormalIn', WB_FIELDS.cgAftNormalIn, [47.3])!.verified).toBe(true);
  });

  it('refuses the right number printed as the wrong thing', () => {
    /*
     * The defect this pins: "48" on a fuel-capacity line is gallons, not the
     * station arm. Asked across the whole handbook, the arm was matching
     * "Total Usable: 48 gallons" — the right value, the wrong ink.
     */
    expect(findFigureOnPages(doc, [1, 2], 'fuelArmIn', WB_FIELDS.fuelArmIn, [48])).toBeNull();
  });

  it('refuses a figure that belongs under the other category heading', () => {
    expect(findFigureOnPages(doc, [1], 'maxTakeoffWeightUtilityLb', WB_FIELDS.maxTakeoffWeightUtilityLb, [2300])).toBeNull();
  });

  it('the weaker check finds a figure printed without a label, and says it is unlabelled', () => {
    // A station arm in a diagram: the number is there, nothing on its row names it.
    const weak = findFigureOnPage(doc, 2, 'frontSeatArmIn', WB_FIELDS.frontSeatArmIn, [37]);
    expect(weak).not.toBeNull();
    expect(weak!.verified).toBe(false);
    expect(weak!.labelProblem).toContain('nothing on this line names');
    // And it still refuses a number the page does not print at all.
    expect(findFigureOnPage(doc, 2, 'frontSeatArmIn', WB_FIELDS.frontSeatArmIn, [41])).toBeNull();
  });
});
