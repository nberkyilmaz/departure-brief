import { describe, expect, it } from 'vitest';
import { parseAircraftLimits } from '../../src/domain/profile.js';
import type { Knots } from '../../src/domain/units.js';
import { assembleWeightBalance, type NamedFigure } from '../../src/wb/assemble.js';
import { withHandbookLimits } from '../../src/wb/aircraft.js';
import type { DocumentCitation } from '../../src/wb/types.js';

const citation: DocumentCitation = {
  documentSha256: 'a'.repeat(64),
  filename: 'C172MPOH.pdf',
  page: 42,
  box: { x: 1, y: 2, w: 3, h: 4 },
  citedText: 'Maximum Demonstrated Crosswind Velocity: Takeoff or Landing 15 KNOTS',
};

const specWith = (figure: Partial<NamedFigure> & { value: number }) =>
  assembleWeightBalance('C172', { documentSha256: citation.documentSha256, filename: citation.filename, pages: [42] }, [{ name: 'demonstratedCrosswindKt', source: citation, note: null, ...figure }], []);

describe('withHandbookLimits', () => {
  const bare = parseAircraftLimits({ type: 'C172' });

  it('fills a missing demonstrated crosswind from the handbook, carrying the page', () => {
    const limits = withHandbookLimits(bare, specWith({ value: 15 }));
    expect(limits.demonstratedCrosswind).toBe(15);
    expect(limits.demonstratedCrosswindSource).toEqual({ filename: 'C172MPOH.pdf', page: 42, citedText: citation.citedText, sha256: citation.documentSha256 });
  });

  it('never overrides a figure the owner stated about their own aeroplane', () => {
    const stated = parseAircraftLimits({ type: 'C172', demonstratedCrosswindKt: 12 });
    const limits = withHandbookLimits(stated, specWith({ value: 15 }));
    expect(limits.demonstratedCrosswind).toBe(12 as Knots);
    expect(limits.demonstratedCrosswindSource).toBeNull();
  });

  it('says so when the figure came from the handbook but with no citation behind it', () => {
    const onWord = specWith({ value: 15, source: null, note: 'entered by hand from the page image' });
    const limits = withHandbookLimits(bare, onWord);
    expect(limits.demonstratedCrosswind).toBe(15);
    expect(limits.demonstratedCrosswindSource!.page).toBe(0);
    expect(limits.demonstratedCrosswindSource!.citedText).toContain('entered by hand');
    expect(limits.demonstratedCrosswindSource!.sha256).toBeNull();
  });

  it('leaves the limits alone when there is no handbook data, or none worth using', () => {
    expect(withHandbookLimits(bare, null)).toEqual(bare);
    expect(withHandbookLimits(bare, assembleWeightBalance('C172', null, [], [])).demonstratedCrosswind).toBeNull();
    expect(withHandbookLimits(bare, specWith({ value: 0 })).demonstratedCrosswind).toBeNull();
  });
});
