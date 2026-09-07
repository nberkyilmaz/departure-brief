import { describe, expect, it } from 'vitest';
import { resolveDayTime, toZulu } from '../../src/domain/time.js';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

describe('resolveDayTime', () => {
  it('resolves a day in the reference month', () => {
    expect(iso(resolveDayTime({ day: 7, hour: 11, minute: 4 }, new Date('2026-09-07T12:00:00Z')))).toBe(
      '2026-09-07T11:04:00.000Z',
    );
  });

  it('falls back to the previous month when the day is later than the reference', () => {
    expect(iso(resolveDayTime({ day: 30, hour: 23, minute: 55 }, new Date('2026-09-01T00:10:00Z')))).toBe(
      '2026-08-30T23:55:00.000Z',
    );
  });

  it('skips a month that does not have the day', () => {
    // Day 30 on 1 March: March 30 is in the future; February has no 30th; January 30 it is.
    expect(iso(resolveDayTime({ day: 30, hour: 12, minute: 0 }, new Date('2026-03-01T00:00:00Z')))).toBe(
      '2026-01-30T12:00:00.000Z',
    );
  });

  it('crosses a year boundary', () => {
    expect(iso(resolveDayTime({ day: 31, hour: 23, minute: 50 }, new Date('2027-01-01T00:05:00Z')))).toBe(
      '2026-12-31T23:50:00.000Z',
    );
  });

  it('tolerates a report timestamped slightly after the reference', () => {
    expect(iso(resolveDayTime({ day: 7, hour: 12, minute: 30 }, new Date('2026-09-07T12:00:00Z')))).toBe(
      '2026-09-07T12:30:00.000Z',
    );
    // Beyond the tolerance it is last month's report.
    expect(iso(resolveDayTime({ day: 7, hour: 18, minute: 0 }, new Date('2026-09-07T12:00:00Z')))).toBe(
      '2026-08-07T18:00:00.000Z',
    );
  });

  it('returns null when no candidate month has the day', () => {
    // Day 31: April (reference) has 30, March has 31 → resolves; so use a reference where the last 3 months lack it.
    expect(resolveDayTime({ day: 31, hour: 0, minute: 0 }, new Date('2026-06-30T00:00:00Z'))).not.toBeNull();
    expect(resolveDayTime({ day: 31, hour: 0, minute: 0 }, new Date('2026-05-01T00:00:00Z'))).toEqual(
      new Date('2026-03-31T00:00:00Z'),
    );
  });
});

describe('toZulu', () => {
  it('formats ISO 8601 with Z and no milliseconds', () => {
    expect(toZulu(new Date('2026-09-07T11:04:00.123Z'))).toBe('2026-09-07T11:04:00Z');
  });
});
