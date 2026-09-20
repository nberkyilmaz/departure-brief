/**
 * A METAR, read back in words, with every line pointing at the characters
 * it was read from.
 *
 * The page has always shown the raw report, which is right — it is the
 * grounding, and hiding it would be the one unforgivable thing. But a raw
 * METAR is a skill, and a pilot who is still learning to read one gets
 * nothing from `BKN008 OVC015 04/03 A2989` except the reassurance that the
 * site fetched something.
 *
 * So: the same report, said plainly, each line carrying the span it came
 * from so the two can be shown against each other. Nothing here interprets
 * or decides — `04/03` becomes "4 °C, dew point 3 °C" and stops. Whether
 * that matters is what the findings are for.
 *
 * Deterministic and in core rather than in the browser, so the words a
 * pilot reads on the page and the words the command line prints are the
 * same words, and both can be tested.
 */
import type { Span } from '../decode/span.js';
import type { DecodedMetar } from '../decode/metar/types.js';
import type { Wind } from '../decode/groups/wind.js';
import type { Visibility } from '../decode/groups/visibility.js';
import type { SkyCondition } from '../decode/groups/sky.js';
import type { Altimeter } from '../decode/groups/pressure.js';
import type { TemperatureGroup } from '../decode/groups/temperature.js';
import type { Remark } from '../decode/metar/remarks.js';
import { weatherText } from '../rules/checks.js';

/** One decoded element of a report. */
export interface MetarLine {
  /** What kind of thing this is: `Wind`, `Visibility`, `Cloud`. */
  readonly label: string;
  /** The reading in words. Never a judgement about it. */
  readonly text: string;
  /** Where in `raw` it was read from, for highlighting. `null` when the group is absent. */
  readonly span: Span | null;
  /**
   * Set when the report said a thing is unavailable rather than saying
   * nothing — `31///KT` is a station that cannot measure speed, which is
   * not the same as a report with no wind group and not the same as calm.
   */
  readonly indeterminate: boolean;
}

const ordinal = (deg: number) => String(Math.round(deg)).padStart(3, '0');

/** `5` → `5`, `5.5` → `5.5`; never `5.0`, never `-0`. */
const num = (n: number): string => {
  const rounded = Math.round(n * 10) / 10;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

function windText(w: Wind): { text: string; indeterminate: boolean } {
  const unit = w.unit === 'KT' ? 'kt' : w.unit === 'MPS' ? 'm/s' : 'km/h';
  if (w.direction === null && w.speed === null) return { text: 'reported unavailable', indeterminate: true };
  if (w.speed === 0 && w.direction !== 'VRB') return { text: 'calm', indeterminate: false };

  const from =
    w.direction === null
      ? 'from an unavailable direction'
      : w.direction === 'VRB'
        ? 'variable in direction'
        : `from ${ordinal(w.direction)}° true`;
  const speed = w.speed === null ? 'at an unavailable speed' : `at ${num(w.speed)} ${unit}`;
  const gust = w.gust === null ? '' : `, gusting ${num(w.gust)} ${unit}`;
  const varies = w.variableFrom !== null && w.variableTo !== null ? `, varying between ${ordinal(w.variableFrom)}° and ${ordinal(w.variableTo)}°` : '';
  return { text: `${from} ${speed}${gust}${varies}`, indeterminate: w.direction === null || w.speed === null };
}

function visibilityText(v: Visibility): { text: string; indeterminate: boolean } {
  switch (v.kind) {
    case 'statute': {
      const qualifier = v.qualifier === 'lessThan' ? 'less than ' : v.qualifier === 'greaterThan' ? 'more than ' : '';
      return { text: `${qualifier}${num(v.miles)} statute ${v.miles === 1 && !v.qualifier ? 'mile' : 'miles'}`, indeterminate: false };
    }
    case 'meters': {
      // 9999 is the code for "10 km or more"; 0000 for "less than 50 m".
      const base = v.meters >= 9999 ? '10 km or more' : v.meters === 0 ? 'less than 50 m' : `${v.meters.toLocaleString('en')} m`;
      const direction = v.direction !== null && v.direction !== 'NDV' ? ` to the ${v.direction}` : '';
      const minimum = v.minimum ? `, as little as ${v.minimum.meters.toLocaleString('en')} m to the ${v.minimum.direction}` : '';
      return { text: `${base}${direction}${minimum}`, indeterminate: false };
    }
    case 'cavok':
      // CAVOK is a single code asserting three things at once, and a pilot
      // should be told all three rather than the abbreviation.
      return { text: '10 km or more, no cloud below 5,000 ft or below the highest minimum sector altitude, no cumulonimbus, and no significant weather', indeterminate: false };
    case 'missing':
      return { text: 'reported unavailable', indeterminate: true };
  }
}

const AMOUNT: Record<string, string> = { FEW: 'few', SCT: 'scattered', BKN: 'broken', OVC: 'overcast' };
const CLEAR: Record<string, string> = {
  CLR: 'no cloud below 12,000 ft (automated)',
  SKC: 'sky clear',
  NSC: 'no significant cloud',
  NCD: 'no cloud detected (automated)',
};
const CLOUD_TYPE: Record<string, string> = { CB: 'cumulonimbus', TCU: 'towering cumulus' };

function skyText(s: SkyCondition): { text: string; indeterminate: boolean } {
  switch (s.kind) {
    case 'clear':
      return { text: CLEAR[s.code] ?? s.code, indeterminate: false };
    case 'missing':
      return { text: 'sky condition reported unavailable', indeterminate: true };
    case 'verticalVisibility':
      return s.height === null
        ? { text: 'obscured sky, vertical visibility reported unavailable', indeterminate: true }
        : { text: `obscured sky, vertical visibility ${s.height.toLocaleString('en')} ft`, indeterminate: false };
    case 'layer': {
      const amount = s.amount === null ? 'an unavailable amount of cloud' : AMOUNT[s.amount] ?? s.amount;
      const base = s.base === null ? 'at an unavailable height' : `at ${s.base.toLocaleString('en')} ft`;
      const type = s.type ? `, ${CLOUD_TYPE[s.type] ?? s.type}` : '';
      return { text: `${amount} ${base}${type}`, indeterminate: s.amount === null || s.base === null };
    }
  }
}

function temperatureText(t: TemperatureGroup): { text: string; indeterminate: boolean } {
  const say = (c: number | null) => (c === null ? 'unavailable' : `${num(c)} °C`);
  return {
    text: `${say(t.temperature)}, dew point ${say(t.dewpoint)}`,
    indeterminate: t.temperature === null || t.dewpoint === null,
  };
}

function altimeterText(a: Altimeter): { text: string; indeterminate: boolean } {
  if (a.value === null) return { text: 'reported unavailable', indeterminate: true };
  return { text: a.unit === 'inHg' ? `${a.value.toFixed(2)} inHg` : `${Math.round(a.value)} hPa`, indeterminate: false };
}

/**
 * A remark, in words where the words are worth having.
 *
 * Thirty-one kinds are decoded and most of them are of no use to a light
 * aircraft on a Saturday — pressure tendency characteristics and
 * twenty-four-hour precipitation totals are for climatology. So the ones a
 * pilot acts on get prose, and the rest are shown as the report wrote them,
 * which is still better than not shown. `null` means "print the raw text",
 * never "leave it out".
 */
function remarkText(r: Remark): string | null {
  switch (r.kind) {
    /*
     * The one this project has a particular use for: a field that measures
     * its own density altitude has answered the question a performance
     * chart would otherwise have to be interpolated for.
     */
    case 'densityAltitude':
      return `density altitude ${r.altitude.toLocaleString('en')} ft`;
    case 'peakWind':
      return `peak wind ${ordinal(r.direction)}° at ${num(r.speed)} kt, at ${remarkTime(r.time)}`;
    case 'windShift':
      return `wind shifted at ${remarkTime(r.time)}${r.frontalPassage ? ', with a frontal passage' : ''}`;
    case 'variableCeiling':
      return `ceiling varying between ${r.low.toLocaleString('en')} and ${r.high.toLocaleString('en')} ft`;
    case 'variableVisibility':
      return `visibility varying between ${r.lowQualifier === 'lessThan' ? 'less than ' : ''}${num(r.low)} and ${num(r.high)} statute miles`;
    case 'variableSky':
      return `a layer${r.base === null ? '' : ` at ${r.base.toLocaleString('en')} ft`} varying between ${AMOUNT[r.from] ?? r.from} and ${AMOUNT[r.to] ?? r.to}`;
    case 'secondSiteCeiling':
      return `ceiling ${r.height.toLocaleString('en')} ft at a second sensor${r.location ? ` by ${r.location}` : ''}`;
    case 'towerVisibility':
      return `tower visibility ${num(r.miles)} statute miles`;
    case 'surfaceVisibility':
      return `surface visibility ${num(r.miles)} statute miles`;
    case 'obscuration':
      return `${weatherText(r.weather)} hiding ${AMOUNT[r.amount] ?? r.amount} of the sky at ${r.base.toLocaleString('en')} ft`;
    case 'lightning': {
      const how = r.frequency === 'OCNL' ? 'occasional' : r.frequency === 'FRQ' ? 'frequent' : r.frequency === 'CONS' ? 'continuous' : '';
      const where = r.locations.length > 0 ? ` to the ${r.locations.join(' ')}` : '';
      return `${[how, 'lightning'].filter(Boolean).join(' ')}${r.distant ? ', distant' : ''}${where}${r.movement ? `, moving ${r.movement}` : ''}`;
    }
    case 'pressureChangeRapid':
      return `pressure ${r.direction} rapidly`;
    case 'altimeterEstimated':
      return 'altimeter setting estimated';
    case 'preciseTemperature':
      return `${num(r.temperature)} °C${r.dewpoint === null ? '' : `, dew point ${num(r.dewpoint)} °C`}, to a tenth`;
    case 'seaLevelPressure':
      return r.pressure === null ? 'sea level pressure not available' : `sea level pressure ${num(r.pressure)} hPa`;
    case 'automatedStationType':
      return r.type === 'AO1'
        ? `automated station without a precipitation discriminator${r.augmented ? ', with an observer' : ''}`
        : `automated station with a precipitation discriminator${r.augmented ? ', with an observer' : ''}`;
    case 'maintenanceNeeded':
      return 'the station is flagged as needing maintenance';
    case 'elementMissing':
      return 'an element of this report is missing';
    case 'sensorStatus':
      return 'a sensor is reported out of service';
    default:
      // Decoded, but not worth paraphrasing. Shown as written.
      return null;
  }
}

function remarkTime(t: { readonly hour: number | null; readonly minute: number }): string {
  return t.hour === null ? `${String(t.minute).padStart(2, '0')} past the hour` : `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')} Zulu`;
}

/**
 * Every group the decoder found, in the order the report writes them.
 *
 * Absent groups produce no line — a report that does not mention cloud is
 * not a report of no cloud, and inventing "cloud: none" would be inventing
 * a reading. A group the report explicitly marks unavailable *does*
 * produce a line, flagged, because "the station cannot measure this" is
 * information a pilot needs.
 */
export function explainMetar(m: DecodedMetar): MetarLine[] {
  const lines: MetarLine[] = [];
  const add = (label: string, text: string, span: Span | null, indeterminate = false) => lines.push({ label, text, span, indeterminate });

  if (m.station) add('Station', m.station.value, m.station.span);
  if (m.reportType) {
    add('Type', m.reportType.value === 'SPECI' ? 'special report, issued off the hour' : 'routine hourly report', m.reportType.span);
  }
  if (m.time) {
    const t = m.time.value;
    add('Observed', `day ${t.day} of the month at ${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')} Zulu`, m.time.span);
  }
  for (const mod of m.modifiers) {
    add('Modifier', mod.value === 'AUTO' ? 'automated, no human observer' : mod.value === 'COR' ? 'a correction to an earlier report' : String(mod.value), mod.span);
  }
  if (m.wind) {
    const { text, indeterminate } = windText(m.wind.value);
    add('Wind', text, m.wind.span, indeterminate);
  }
  if (m.visibility) {
    const { text, indeterminate } = visibilityText(m.visibility.value);
    add('Visibility', text, m.visibility.span, indeterminate);
  }
  for (const r of m.rvr) {
    add('Runway visual range', `runway ${r.value.runway}`, r.span);
  }
  for (const w of m.weather) add('Weather', weatherText(w.value), w.span);
  for (const s of m.sky) {
    const { text, indeterminate } = skyText(s.value);
    add('Cloud', text, s.span, indeterminate);
  }
  if (m.temperature) {
    const { text, indeterminate } = temperatureText(m.temperature.value);
    add('Temperature', text, m.temperature.span, indeterminate);
  }
  if (m.altimeter) {
    const { text, indeterminate } = altimeterText(m.altimeter.value);
    add('Altimeter', text, m.altimeter.span, indeterminate);
  }
  if (m.altimeterAlternate) {
    const { text, indeterminate } = altimeterText(m.altimeterAlternate.value);
    add('Altimeter', `${text}, the same pressure in the other unit`, m.altimeterAlternate.span, indeterminate);
  }
  for (const w of m.recentWeather) add('Recent weather', `${weatherText(w.value)}, since the last report`, w.span);
  for (const s of m.windShear) add('Wind shear', s.value.runway === 'ALL' ? 'on all runways' : `on runway ${s.value.runway}`, s.span);

  /*
   * Remarks, which is where a Canadian station puts the things this tool
   * most wants — its own measured density altitude among them. Every one
   * appears; the ones a pilot acts on appear in words and the rest as the
   * report wrote them.
   */
  for (const r of m.remarks?.items ?? []) {
    add('Remark', remarkText(r.value) ?? m.raw.slice(r.span.start, r.span.end), r.span);
  }

  /*
   * Anything the decoder did not account for is listed rather than
   * dropped, so the decode is visibly complete: a reader can check every
   * group of the raw report against a line here. Remarks are called out
   * separately — an undecoded remark is a gap in a corner of the format,
   * and an undecoded body group is a gap in the part that matters.
   */
  for (const u of m.unparsed) add(u.section === 'remarks' ? 'Remark, not decoded' : 'Not decoded', u.text, u.span, true);
  return lines;
}
