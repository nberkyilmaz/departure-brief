import type { DayTime } from '../../domain/time.js';
import type { Token } from '../tokenizer.js';
import { matched, type GroupMatch } from './match.js';

const DAY_TIME = /^(\d{2})(\d{2})(\d{2})Z$/;
const VALIDITY = /^(\d{2})(\d{2})\/(\d{2})(\d{2})$/;

function validDay(d: number): boolean {
  return d >= 1 && d <= 31;
}

/** `141851Z` → day 14, 18:51 UTC. Hour 24 is accepted (used in some validity groups). */
export function parseDayTime(tokens: readonly Token[], index: number): GroupMatch<DayTime> {
  const t = tokens[index];
  if (!t) return null;
  const m = DAY_TIME.exec(t.text);
  if (!m) return null;
  const day = Number(m[1]);
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  if (!validDay(day) || hour > 24 || minute > 59) return null;
  return matched({ day, hour, minute });
}

export interface ValidityPeriod {
  readonly from: DayTime;
  readonly to: DayTime;
}

/** TAF validity `1418/1518` → from day 14 18:00Z to day 15 18:00Z. */
export function parseValidity(tokens: readonly Token[], index: number): GroupMatch<ValidityPeriod> {
  const t = tokens[index];
  if (!t) return null;
  const m = VALIDITY.exec(t.text);
  if (!m) return null;
  const from = { day: Number(m[1]), hour: Number(m[2]), minute: 0 };
  const to = { day: Number(m[3]), hour: Number(m[4]), minute: 0 };
  if (!validDay(from.day) || !validDay(to.day) || from.hour > 24 || to.hour > 24) return null;
  return matched({ from, to });
}
