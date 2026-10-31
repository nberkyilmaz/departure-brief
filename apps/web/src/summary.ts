import type { Attention, FlightCategory, Finding, NavLogLeg, PointReview, StoredBriefing } from './types.js';

/**
 * The briefing said the way a pilot says it.
 *
 * The rules write a line for every check against every part of every
 * product: the prevailing forecast, each TEMPO and PROB, the observation.
 * That is right for the record and wrong for reading. A gusty afternoon at
 * one field came out as a dozen rows, four of them the same wind.
 *
 * So this reads the findings back two ways and adds nothing to them. Each
 * field becomes a card with the few numbers a pilot asks for first, at the
 * time they will be there. Whatever crossed a limit becomes one line per
 * field and topic, with every finding behind it one tap away. Each alert
 * and caution belongs to exactly one of those lines; none is dropped.
 */

export type Role = 'Departure' | 'Via' | 'Destination' | 'Alternate';

export interface LabelledPoint {
  readonly point: PointReview;
  readonly role: Role;
  /** The leg that arrives here, from the nav log; null for the departure. */
  readonly leg: NavLogLeg | null;
}

/** Every point in route order, the alternate last, each with what to call it. */
export function labelledPoints(stored: StoredBriefing): LabelledPoint[] {
  const b = stored.document.briefing;
  const legs = stored.document.navlog.legs;
  const last = b.points.length - 1;
  const out: LabelledPoint[] = b.points.map((point, i) => ({
    point,
    role: i === 0 ? 'Departure' : i === last ? 'Destination' : 'Via',
    leg: i > 0 ? (legs[i - 1] ?? null) : null,
  }));
  if (b.alternate) out.push({ point: b.alternate, role: 'Alternate', leg: stored.document.navlog.alternate });
  return out;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const capital = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);
const feet = (x: number): string => `${Math.round(x).toLocaleString('en')} ft`;
const degrees = (d: number): string => `${String(Math.round(d)).padStart(3, '0')}°`;
const asking = (f: Finding): boolean => f.attention === 'alert' || f.attention === 'caution';

/* ---------------------------------------------------------------- the cards */

export interface CardLine {
  readonly label: string;
  readonly text: string;
  /** A limit you set, or a legal one, is crossed. */
  readonly over: boolean;
}

export interface FieldCard extends LabelledPoint {
  /** At the time you are there: the forecast's category, or the observation's when no forecast covers it. */
  readonly category: FlightCategory | null;
  readonly lines: readonly CardLine[];
  /** Where the lines were read from, in words. Null when nothing covers this point. */
  readonly source: string | null;
  /** The observation in one line, when the card above it is a forecast. */
  readonly now: string | null;
  /** Why there are no lines, when there are none. */
  readonly missing: string | null;
}

/** The surface wind in words; older briefings without a direction value fall back to the summary's. */
function windWords(f: Finding | undefined): string | null {
  if (!f) return null;
  const speed = num(f.values['speedKt']);
  if (speed === null) return null;
  const gust = num(f.values['gustKt']);
  if (speed === 0 && !gust) return 'calm';
  const said = /from (\d{3})°T/.exec(f.summary)?.[1];
  const direction = num(f.values['directionTrue']) ?? (said ? Number(said) : null);
  const from = f.values['variable'] === true || f.summary.includes('variable') ? 'variable' : direction !== null ? `${degrees(direction)}T` : 'direction not given,';
  return `${from} at ${speed} kt${gust !== null ? `, gusts ${gust}` : ''}`;
}

interface RunwayWind {
  end: string;
  crosswind: number;
  headwind: number;
  crosswindGust: number;
}

function runwayLine(f: Finding | undefined, demonstrated: Finding | undefined): CardLine | null {
  if (!f) return null;
  const runways = Array.isArray(f.values['runways']) ? (f.values['runways'] as RunwayWind[]) : [];
  const best = runways[0];
  const limit = num(f.values['limit']);
  // No headings, or no wind: the rule says why, and that is the line.
  if (!best || limit === null) return { label: 'Runway', text: capital(f.summary.replace(/ — crosswind not evaluated$/, '')), over: asking(f) };
  const over = asking(f);
  let text: string;
  if (num(f.values['speedKt']) === 0) text = 'Calm, any runway';
  else if (f.values['variable'] === true) text = `Any runway: up to ${Math.round(num(f.values['crosswindKt']) ?? 0)} kt across, as the wind is variable`;
  else {
    const across = Math.round(best.crosswind);
    const inGusts = Math.round(best.crosswindGust);
    const head = Math.round(best.headwind);
    text = `${best.end}: ${across} kt across${inGusts !== across ? ` (${inGusts} in gusts)` : ''}, ${head >= 0 ? `${head} kt headwind` : `${-head} kt tailwind`}`;
  }
  if (over) text += `, over your ${limit} kt limit`;
  const demo = demonstrated && asking(demonstrated) ? num(demonstrated.values['demonstrated']) : null;
  if (demo !== null) text += `${over ? ' and' : ', over'} the aircraft's demonstrated ${demo} kt`;
  return { label: 'Runway', text, over: over || demo !== null };
}

function ceilingLine(f: Finding | undefined): CardLine | null {
  if (!f) return null;
  if (f.values['indeterminate'] === true) return { label: 'Ceiling', text: 'Cloud reported, height not measured', over: true };
  if (!('ceiling' in f.values)) return { label: 'Ceiling', text: 'Not given', over: false };
  const ceiling = num(f.values['ceiling']);
  if (ceiling === null) return { label: 'Ceiling', text: 'No ceiling', over: false };
  const minimum = num(f.values['minimum']);
  const below = asking(f);
  return { label: 'Ceiling', text: `${feet(ceiling)}${below && minimum !== null ? `, below your ${feet(minimum)}` : ''}`, over: below };
}

/** ">6 SM" is how the rules quote P6SM; on a card it is said in words. */
function visibilityText(f: Finding): string | null {
  const text = str(f.values['text']) ?? (num(f.values['visibilitySm']) !== null ? `${num(f.values['visibilitySm'])} SM` : null);
  if (text === null) return null;
  return text.replace(/^>(.*)$/, 'more than $1').replace(/^<(.*)$/, 'less than $1');
}

function visibilityLine(f: Finding | undefined): CardLine | null {
  if (!f) return null;
  const text = visibilityText(f);
  if (text === null) return { label: 'Visibility', text: 'Not given', over: false };
  const minimum = num(f.values['minimum']);
  const below = asking(f);
  return { label: 'Visibility', text: `${capital(text)}${below && minimum !== null ? `, below your ${minimum} SM` : ''}`, over: below };
}

/** "TSRA — a thunderstorm with rain" is read as "a thunderstorm with rain". */
const weatherWords = (f: Finding): string => f.summary.replace(/^.*? — /, '');

function aloftLine(f: Finding | undefined): CardLine | null {
  if (!f) return null;
  const altitude = num(f.values['altitudeFt']);
  const speed = num(f.values['speedKt']);
  const direction = num(f.values['directionTrue']);
  const temp = num(f.values['tempC']);
  if (altitude === null || speed === null) return null;
  const wind = speed === 0 || direction === null ? `light and variable` : `${degrees(direction)}T at ${speed} kt`;
  return { label: `At ${feet(altitude)}`, text: `${wind}${temp !== null ? `, ${temp > 0 ? '+' : ''}${temp} °C` : ''}`, over: false };
}

function card(lp: LabelledPoint, cruiseFt: number | null): FieldCard {
  const { point } = lp;
  const prevailing = point.findings.filter((f) => f.basisKind === 'prevailing');
  const observed = point.findings.filter((f) => f.basisKind === 'observed' && !f.rule.startsWith('observation.'));
  const main = prevailing.length > 0 ? prevailing : observed;
  const pick = (rule: string) => main.find((f) => f.rule === rule);

  const wind = windWords(pick('wind.surface'));
  const weather = main.filter((f) => f.rule === 'weather.present').map(weatherWords);
  const lines = [
    wind ? { label: 'Wind', text: capital(wind), over: false } : null,
    runwayLine(pick('crosswind.personal'), pick('crosswind.demonstrated')),
    ceilingLine(pick('personal.ceiling')),
    visibilityLine(pick('personal.visibility')),
    weather.length > 0 ? { label: 'Weather', text: capital(weather.join(', ')), over: main.some((f) => f.rule === 'weather.present' && asking(f)) } : null,
    // A wind at cruise that no forecast reaches is said, rather than left off the card.
    aloftLine(point.findings.find((f) => f.rule === 'wind.aloft')) ?? {
      label: cruiseFt !== null ? `At ${feet(cruiseFt)}` : 'Wind aloft',
      text: 'No upper wind forecast within reach',
      over: false,
    },
  ].filter((l): l is CardLine => l !== null);

  let source: string | null = null;
  if (prevailing.length > 0) {
    const borrowed = point.findings.find((f) => f.rule === 'forecast.borrowed');
    const station = str(borrowed?.values['station']);
    const distance = num(borrowed?.values['distanceNm']);
    source =
      station !== null
        ? `Forecast for your time from the ${station} TAF, ${Math.round(distance ?? 0)} nm away. ${point.waypoint} has no forecast of its own.`
        : `Forecast for your time from the ${point.waypoint} TAF.`;
  } else if (observed.length > 0) {
    source = `No forecast covers your time, so this is the latest observation (${observed[0]!.basis}).`;
  }

  const nowWind = prevailing.length > 0 ? windWords(observed.find((f) => f.rule === 'wind.surface')) : null;
  const now = prevailing.length > 0 && observed.length > 0 ? `Now: ${point.category ?? 'unclassified'}${nowWind ? `, wind ${nowWind}` : ''} (${observed[0]!.basis}).` : null;

  const coverage = point.findings.find((f) => f.rule === 'forecast.coverage');
  return {
    ...lp,
    category: prevailing.length > 0 ? point.forecastCategory : point.category,
    lines,
    source,
    now,
    missing: main.length === 0 ? capital(coverage?.summary ?? 'nothing reported or forecast here') : null,
  };
}

export function fieldCards(stored: StoredBriefing): FieldCard[] {
  const cruise = num(stored.document.plan.cruise?.altitude);
  return labelledPoints(stored).map((lp) => card(lp, cruise));
}

/* ----------------------------------------------------------- worth a look */

export type Topic = 'wind' | 'cloud' | 'visibility' | 'weather' | 'hazard' | 'daylight' | 'cruise' | 'observation' | 'fuel' | 'other';

/** The order lines are read in, among those that ask for the same attention at the same field. */
const TOPICS: readonly Topic[] = ['weather', 'wind', 'cloud', 'visibility', 'hazard', 'daylight', 'cruise', 'observation', 'fuel', 'other'];

const TOPIC_OF: Readonly<Record<string, Topic>> = {
  'wind.surface': 'wind',
  'crosswind.personal': 'wind',
  'crosswind.demonstrated': 'wind',
  'wind.gustSpread': 'wind',
  'personal.ceiling': 'cloud',
  'vfr.ceiling': 'cloud',
  'vfr.cloudClearance': 'cloud',
  'personal.visibility': 'visibility',
  'vfr.visibility': 'visibility',
  'weather.present': 'weather',
  'daylight.margin': 'daylight',
  'personal.night': 'daylight',
  'wind.aloft': 'cruise',
  'wind.freezing': 'cruise',
  'observation.age': 'observation',
  'observation.borrowed': 'observation',
  'fuel.reserve': 'fuel',
  'fuel.inputs': 'fuel',
};

export const TOPIC_LABEL: Readonly<Record<Topic, string>> = {
  wind: 'Wind',
  cloud: 'Cloud',
  visibility: 'Visibility',
  weather: 'Weather',
  hazard: 'Hazard',
  daylight: 'Daylight',
  cruise: 'At cruise',
  observation: 'Observation',
  fuel: 'Fuel',
  other: 'Other',
};

const topicOf = (rule: string): Topic => TOPIC_OF[rule] ?? (rule.startsWith('hazard.') ? 'hazard' : 'other');

/** A forecast that does not cover the time is said on the card and under what the briefing could not see; not twice more here. */
const SAID_ELSEWHERE: ReadonlySet<string> = new Set(['forecast.coverage', 'forecast.borrowed']);

export interface Concern {
  readonly key: string;
  readonly waypoint: string;
  readonly role: Role;
  readonly topic: Topic;
  readonly attention: Extract<Attention, 'alert' | 'caution'>;
  /** What crossed which limit, worst case, in one sentence. */
  readonly headline: string;
  /** Which parts of which products say so: "forecast for your time", "TEMPO 21:00–01:00Z", "observed 19:00Z". */
  readonly when: readonly string[];
  readonly findings: readonly Finding[];
}

const minOf = (fs: readonly Finding[], key: string): Finding | undefined =>
  fs.filter((f) => num(f.values[key]) !== null).sort((a, b) => num(a.values[key])! - num(b.values[key])!)[0];
const maxOf = (fs: readonly Finding[], key: string): Finding | undefined =>
  fs.filter((f) => num(f.values[key]) !== null).sort((a, b) => num(b.values[key])! - num(a.values[key])!)[0];
const ofRule = (fs: readonly Finding[], rule: string) => fs.filter((f) => f.rule === rule);

function windHeadline(fs: readonly Finding[], all: readonly Finding[]): string {
  const across = maxOf(ofRule(fs, 'crosswind.personal'), 'crosswindKt');
  if (across) {
    const kt = Math.round(num(across.values['crosswindKt'])!);
    const where = across.values['variable'] === true ? 'with the wind variable, so on any runway' : `on runway ${str(across.values['bestRunway'])}`;
    return `Crosswind up to ${kt} kt ${where}, over your ${num(across.values['limit'])} kt limit`;
  }
  const demo = maxOf(ofRule(fs, 'crosswind.demonstrated'), 'crosswindKt');
  if (demo) return `Crosswind up to ${Math.round(num(demo.values['crosswindKt'])!)} kt, over the aircraft's demonstrated ${num(demo.values['demonstrated'])} kt`;
  const spread = maxOf(ofRule(fs, 'wind.gustSpread'), 'spread');
  if (spread) return `Gusts ${num(spread.values['spread'])} kt above the steady wind, over your ${num(spread.values['limit'])} kt`;
  const surface = maxOf(ofRule(fs, 'wind.surface'), 'comparedAgainst');
  if (surface) {
    const kt = num(surface.values['comparedAgainst'])!;
    const limit = num(surface.values['limit']);
    if (limit !== null) return `Wind up to ${kt} kt, over your ${limit} kt wind limit`;
    // Stronger than the crosswind limit in total; what the runways make of it is on the same basis, within limits.
    const runway = all.find((f) => f.rule === 'crosswind.personal' && f.basis === surface.basis && !asking(f));
    const note = runway ? `; on runway ${str(runway.values['bestRunway'])} that is ${Math.round(num(runway.values['crosswindKt']) ?? 0)} kt across, within your limit` : ', so the runway matters';
    return `Wind up to ${kt} kt, more than your ${num(surface.values['crosswindLimit'])} kt crosswind limit${note}`;
  }
  return capital(fs[0]!.summary);
}

function cloudHeadline(fs: readonly Finding[]): string {
  const parts: string[] = [];
  const unmeasured = ofRule(fs, 'personal.ceiling').find((f) => f.values['indeterminate'] === true);
  if (unmeasured) parts.push('a ceiling whose height was not measured');
  const personal = minOf(ofRule(fs, 'personal.ceiling'), 'ceiling');
  if (personal) parts.push(`ceiling as low as ${feet(num(personal.values['ceiling'])!)}, below your ${feet(num(personal.values['minimum'])!)} minimum`);
  const legal = minOf(ofRule(fs, 'vfr.ceiling'), 'ceiling');
  if (legal) parts.push(`below the legal ${feet(num(legal.values['minimum'])!)} (${str(legal.values['rule'])})`);
  const clearance = minOf(ofRule(fs, 'vfr.cloudClearance'), 'clearance');
  if (clearance) {
    const base = num(clearance.values['baseMsl'])!;
    const cruise = num(clearance.values['cruiseMsl'])!;
    parts.push(
      base < cruise
        ? `cloud base as low as ${feet(base)} above sea level, under your ${feet(cruise)} cruise`
        : `cloud base ${feet(base)} above sea level, less than ${feet(num(clearance.values['required'])!)} above your ${feet(cruise)} cruise`,
    );
  }
  return parts.length > 0 ? capital(parts.join('; ')) : capital(fs[0]!.summary);
}

function visibilityHeadline(fs: readonly Finding[]): string {
  const parts: string[] = [];
  const personal = minOf(ofRule(fs, 'personal.visibility'), 'visibilitySm');
  if (personal) parts.push(`visibility as low as ${visibilityText(personal)}, below your ${num(personal.values['minimum'])} SM minimum`);
  const legal = minOf(ofRule(fs, 'vfr.visibility'), 'visibilitySm');
  if (legal) parts.push(`${personal ? '' : `visibility as low as ${visibilityText(legal)}, `}below the legal ${num(legal.values['minimum'])} SM (${str(legal.values['rule'])})`);
  return parts.length > 0 ? capital(parts.join('; ')) : capital(fs[0]!.summary);
}

function headline(topic: Topic, fs: readonly Finding[], all: readonly Finding[]): string {
  switch (topic) {
    case 'wind':
      return windHeadline(fs, all);
    case 'cloud':
      return cloudHeadline(fs);
    case 'visibility':
      return visibilityHeadline(fs);
    case 'weather':
      return capital([...new Set(fs.map(weatherWords))].join('; '));
    default: {
      const worst = fs.find((f) => f.attention === 'alert') ?? fs[0]!;
      return capital(worst.summary);
    }
  }
}

/** The part of a product a finding came from, as a pilot would name it. */
function whenOf(f: Finding): string | null {
  switch (f.basisKind) {
    case 'prevailing':
      return 'forecast for your time';
    case 'overlay':
      // The station is on the card; the period is what this line needs.
      return f.basis.replace(/\s*\(TAF [^)]*\)$/, '').replace(/(\d\d:\d\d)Z–/g, '$1–');
    case 'observed':
    case 'forecast':
      return f.basis;
    default:
      return null;
  }
}

const KIND_ORDER = ['prevailing', 'overlay', 'observed', 'forecast', 'time', 'plan'];

export function concernsOf(stored: StoredBriefing): Concern[] {
  const out: (Concern & { order: number })[] = [];
  labelledPoints(stored).forEach(({ point, role }, order) => {
    const groups = new Map<Topic, Finding[]>();
    for (const f of point.findings) {
      if (!asking(f) || SAID_ELSEWHERE.has(f.rule)) continue;
      const topic = topicOf(f.rule);
      groups.set(topic, [...(groups.get(topic) ?? []), f]);
    }
    for (const [topic, fs] of groups) {
      const sorted = [...fs].sort((a, b) => KIND_ORDER.indexOf(a.basisKind) - KIND_ORDER.indexOf(b.basisKind));
      out.push({
        key: `${order}-${topic}`,
        order,
        waypoint: point.waypoint,
        role,
        topic,
        attention: fs.some((f) => f.attention === 'alert') ? 'alert' : 'caution',
        headline: headline(topic, sorted, point.findings),
        when: [...new Set(sorted.map(whenOf).filter((w): w is string => w !== null))],
        findings: sorted,
      });
    }
  });
  const weight = (a: Attention) => (a === 'alert' ? 0 : 1);
  return out
    .sort((a, b) => weight(a.attention) - weight(b.attention) || a.order - b.order || TOPICS.indexOf(a.topic) - TOPICS.indexOf(b.topic))
    .map(({ order: _, ...c }) => c);
}
