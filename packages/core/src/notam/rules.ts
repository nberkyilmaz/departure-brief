/**
 * Relevance decided without a model, where the Q code and the flight leave
 * no judgement to make. A closed or shortened runway at an aerodrome the
 * flight uses is critical; an ILS or an instrument procedure is nothing to
 * a VFR flight; a trigger NOTAM is administrative. The model is kept for
 * the cases that need reading — obstacles, lighting, taxiways, services.
 *
 * The first local model tried (qwen2.5:7b) called the departure runway
 * closure irrelevant under one prompt and merely advisory under another;
 * no ranking of this flight's NOTAMs should depend on a model getting that
 * right, so it does not.
 */
import type { FlightContext } from './assess.js';
import type { Relevance } from './assess.js';
import type { NotamClassification } from './filter.js';
import type { DecodedNotam } from './types.js';

export interface RuleDecision {
  readonly relevance: Relevance;
  readonly rule: string;
  readonly reason: string;
}

/** Runway, declared distances, threshold: a change here alters what the pilot can use. */
const RUNWAY_SUBJECTS = new Set(['MR', 'MD', 'MT']);
/**
 * Lighting facilities: the ICAO subject group L, plus OL for obstacle
 * lights. Out by day, for a flight that lands well before dusk, none of
 * these changes what the pilot can do.
 */
const isLightingSubject = (subject: string) => subject.startsWith('L') || subject === 'OL';

/** ILS and its parts, and instrument procedures and minima: IFR-only. */
const IFR_ONLY_SUBJECTS = new Set(['IC', 'ID', 'IG', 'II', 'IL', 'IM', 'IN', 'IO', 'IS', 'IT', 'IU', 'IW', 'IX', 'IY', 'PA', 'PD', 'PH', 'PI', 'PM', 'PU', 'PX']);

export function ruleRelevance(notam: DecodedNotam, classification: NotamClassification, ctx: FlightContext): RuleDecision | null {
  const q = notam.q?.value;
  if (!q) return null;
  const subject = q.code.subject;
  const condition = q.code.condition;
  const locations = notam.locations?.value ?? [];
  const used = ctx.aerodromes.filter((a) => locations.includes(a.id));
  const active = classification.time === 'active' || classification.time === 'unknown';

  if (condition === 'TT') {
    return { relevance: 'irrelevant', rule: 'notam.trigger', reason: 'a trigger NOTAM announces a publication amendment; it has no operational content of its own' };
  }
  if (RUNWAY_SUBJECTS.has(subject) && used.length > 0 && active) {
    const what = subject === 'MR' ? (condition === 'LC' ? 'a runway closure' : 'a runway change') : subject === 'MD' ? 'a change of declared distances' : 'a threshold change';
    return {
      relevance: 'critical',
      rule: 'runway.used-aerodrome',
      reason: `${what} (Q code ${q.code.text}) at ${used.map((a) => `${a.id}, the ${a.role} aerodrome`).join(' and ')}, in force during the flight`,
    };
  }
  if (subject === 'FA' && condition === 'LC' && used.length > 0 && active) {
    return { relevance: 'critical', rule: 'aerodrome.closed', reason: `the ${used.map((a) => a.role).join('/')} aerodrome is closed (Q code ${q.code.text})` };
  }
  if (IFR_ONLY_SUBJECTS.has(subject) && ctx.flightRules === 'VFR') {
    return { relevance: 'irrelevant', rule: 'ifr-only.vfr-flight', reason: `Q code ${q.code.text} concerns an instrument facility or procedure; this flight is VFR` };
  }
  if (isLightingSubject(subject) && ctx.daylight) {
    return {
      relevance: 'advisory',
      rule: 'lighting.daylight-flight',
      reason: `Q code ${q.code.text} is a lighting outage, and every point of this flight is in daylight — worth knowing in case of delay, but it changes nothing as flown`,
    };
  }
  if (subject === 'FF' ) {
    return { relevance: 'irrelevant', rule: 'arff.private-flight', reason: 'rescue and fire fighting category applies to commercial passenger operations, not a private flight' };
  }
  const firWide = locations.length > 0 && locations.every((l) => /^CZ[A-Z]{2}$/.test(l)) && used.length === 0;
  if (subject === 'OE' && firWide) {
    return { relevance: 'irrelevant', rule: 'entry-requirements.fir-wide', reason: 'FIR-wide aircraft entry requirements; a domestic VFR flight is not the subject' };
  }
  return null;
}
