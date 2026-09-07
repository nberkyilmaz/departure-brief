import type { DayTime } from '../../domain/time.js';
import { decodeTafTemperature, parseConditions, type TafTemperature } from '../conditions.js';
import { parseDayTime, parseValidity, type ValidityPeriod } from '../groups/time.js';
import { joinSpans, sliceSpan, sourced, type Sourced, type Span } from '../span.js';
import { tokenize, type Token } from '../tokenizer.js';
import type { UnparsedToken } from '../unparsed.js';
import type {
  DecodedTaf,
  PeriodKind,
  PeriodValidity,
  TafModifier,
  TafNotice,
  TafPeriod,
  TafRemarks,
  TafStatus,
} from './types.js';

/** Bump when decoder output changes shape or meaning for the same input. */
export const TAF_DECODER_VERSION = 1;

const STATION = /^[A-Z][A-Z0-9]{3}$/;
const MODIFIER = /^(AMD|COR)$/;
const STATUS = /^(NIL|CNL)$/;
const FM = /^FM(\d{2})(\d{2})(\d{2})$/;
const SIX_DIGITS = /^\d{6}$/;
const PROB = /^PROB(30|40)$/;
const CHANGE = /^(BECMG|TEMPO|INTER)$/;
const FORECASTER = /^F[NS]\d{3,6}$/;

const at = (t: Token): Span => ({ start: t.start, end: t.end });

/** `FM071500`, or the space-split form `FM 071500` some centres emit. Returns tokens consumed. */
function fmIndicator(tokens: readonly Token[], i: number, end: number): { time: DayTime | null; consumed: number } | null {
  const t = tokens[i]!;
  let m = FM.exec(t.text);
  let consumed = 1;
  if (!m && t.text === 'FM' && i + 1 < end && SIX_DIGITS.test(tokens[i + 1]!.text)) {
    m = FM.exec(`FM${tokens[i + 1]!.text}`);
    consumed = 2;
  }
  if (!m) return null;
  const day = Number(m[1]);
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  const time = day >= 1 && day <= 31 && hour <= 24 && minute <= 59 ? { day, hour, minute } : null;
  return { time, consumed };
}

/** True when the token opens a new period. */
function isPeriodBoundary(tokens: readonly Token[], i: number, end: number): boolean {
  const t = tokens[i]!;
  return fmIndicator(tokens, i, end) !== null || PROB.test(t.text) || CHANGE.test(t.text);
}

/** The keyword that opens the trailer of notices, if the token is one. */
function trailerKind(tokens: readonly Token[], i: number): TafNotice['kind'] | null {
  const t = tokens[i]!.text;
  const next = tokens[i + 1]?.text;
  if (t === 'AMD') return 'amendment';
  if (t === 'LAST' && next === 'NO') return 'amendment';
  if (t === 'AUTOMATED' && next === 'SENSOR') return 'metwatch';
  return null;
}

/** Inside the trailer, the additional keywords that start a new notice. */
function noticeKind(tokens: readonly Token[], i: number): TafNotice['kind'] | null {
  const t = tokens[i]!.text;
  if (t === 'COR') return 'correction';
  if (FORECASTER.test(t)) return 'forecaster';
  return trailerKind(tokens, i);
}

interface ParsedPeriod {
  readonly period: TafPeriod;
  readonly temperatures: readonly Sourced<TafTemperature>[];
  readonly unparsed: readonly UnparsedToken[];
}

/**
 * Parse one period occupying `tokens[start, end)`. If `tokens[start]` is an
 * indicator it is decoded; otherwise this is the base period and its
 * validity is the header's.
 */
function parsePeriod(
  raw: string,
  tokens: readonly Token[],
  start: number,
  end: number,
  headerValidity: Sourced<ValidityPeriod> | null,
): ParsedPeriod {
  const first = tokens[start]!;
  let kind: PeriodKind = 'base';
  let probability: 30 | 40 | null = null;
  let indicator: Sourced<string> | null = null;
  let validity: Sourced<PeriodValidity> | null = null;
  let i = start;

  const fm = fmIndicator(tokens, start, end);
  const prob = PROB.exec(first.text);
  const change = CHANGE.exec(first.text);

  if (fm) {
    kind = 'FM';
    const span = joinSpans(first, tokens[start + fm.consumed - 1]!);
    indicator = sourced(sliceSpan(raw, span), span);
    validity = fm.time ? sourced({ from: fm.time, to: null }, span) : null;
    i = start + fm.consumed;
  } else if (prob || change) {
    if (prob) {
      probability = Number(prob[1]) as 30 | 40;
      const next = tokens[start + 1];
      const qualified = next && start + 1 < end ? CHANGE.exec(next.text) : null;
      kind = qualified ? (qualified[1] as PeriodKind) : 'PROB';
      i = qualified ? start + 2 : start + 1;
    } else {
      kind = change![1] as PeriodKind;
      i = start + 1;
    }
    const indicatorSpan = joinSpans(first, tokens[i - 1]!);
    indicator = sourced(sliceSpan(raw, indicatorSpan), indicatorSpan);
    const v = i < end ? parseValidity(tokens, i) : null;
    if (v) {
      validity = sourced({ from: v.value.from, to: v.value.to }, at(tokens[i]!));
      i += v.consumed;
    }
  } else if (headerValidity) {
    validity = sourced({ from: headerValidity.value.from, to: headerValidity.value.to }, headerValidity.span);
  }

  const result = parseConditions(tokens, i, end);
  return {
    period: {
      kind,
      probability,
      indicator,
      validity,
      conditions: result.conditions,
      span: joinSpans(first, tokens[end - 1]!),
    },
    temperatures: result.temperatures,
    unparsed: result.unparsed,
  };
}

/**
 * Decode one TAF. Total: never throws, every token is accounted for in
 * exactly one field or in `unparsed`. Deterministic.
 */
export function decodeTaf(raw: string): DecodedTaf {
  const tokens = tokenize(raw);
  const unparsed: UnparsedToken[] = [];
  const modifiers: Sourced<TafModifier>[] = [];
  let reportType: Sourced<'TAF'> | null = null;
  let station: Sourced<string> | null = null;
  let issued: Sourced<DayTime> | null = null;
  let validity: Sourced<ValidityPeriod> | null = null;
  let status: Sourced<TafStatus> | null = null;

  // Header. Each element is optional so that a truncated or malformed header
  // still yields whatever was recognisable.
  let i = 0;
  if (tokens[i]?.text === 'TAF') {
    reportType = sourced('TAF', at(tokens[i]!));
    i++;
  }
  for (;;) {
    const t = tokens[i];
    const m = t ? MODIFIER.exec(t.text) : null;
    if (!t || !m) break;
    modifiers.push(sourced(m[1] as TafModifier, at(t)));
    i++;
  }
  if (tokens[i] && STATION.test(tokens[i]!.text) && !STATUS.test(tokens[i]!.text)) {
    station = sourced(tokens[i]!.text, at(tokens[i]!));
    i++;
  }
  const dt = parseDayTime(tokens, i);
  if (dt) {
    issued = sourced(dt.value, at(tokens[i]!));
    i += dt.consumed;
  } else if (tokens[i] && SIX_DIGITS.test(tokens[i]!.text) && parseValidity(tokens, i + 1)) {
    // Issue time with the `Z` dropped. Only read as such when the validity
    // group follows, which rules out an old-style `ddhhhh` validity.
    const z = parseDayTime([{ ...tokens[i]!, text: `${tokens[i]!.text}Z` }], 0);
    if (z) {
      issued = sourced(z.value, at(tokens[i]!));
      i++;
    }
  }
  const v = parseValidity(tokens, i);
  if (v) {
    validity = sourced(v.value, at(tokens[i]!));
    i += v.consumed;
  }
  const st = tokens[i] ? STATUS.exec(tokens[i]!.text) : null;
  if (st) {
    status = sourced(st[1] as TafStatus, at(tokens[i]!));
    i++;
  }

  // Layout after the header: periods, then an optional trailer of notices,
  // then optional remarks.
  const rmk = tokens.findIndex((t, k) => k >= i && t.text === 'RMK');
  const end = rmk >= 0 ? rmk : tokens.length;
  let trailer = end;
  for (let k = i; k < end; k++) {
    if (trailerKind(tokens, k)) {
      trailer = k;
      break;
    }
  }

  const periods: TafPeriod[] = [];
  const temperatures: Sourced<TafTemperature>[] = [];
  let p = i;
  while (p < trailer) {
    let q = p + 1;
    // A `PROB30` followed by `TEMPO`/`INTER` is one indicator, not two boundaries.
    if (PROB.test(tokens[p]!.text) && q < trailer && CHANGE.test(tokens[q]!.text)) q++;
    // A space-split `FM 071500` is one indicator too.
    if (tokens[p]!.text === 'FM' && q < trailer && SIX_DIGITS.test(tokens[q]!.text)) q++;
    while (q < trailer && !isPeriodBoundary(tokens, q, trailer)) q++;
    const parsed = parsePeriod(raw, tokens, p, q, validity);
    periods.push(parsed.period);
    temperatures.push(...parsed.temperatures);
    unparsed.push(...parsed.unparsed);
    p = q;
  }

  // Trailer: each notice runs from its keyword to the next keyword, a
  // temperature group, or the end. Temperature groups are hoisted; anything
  // else outside a notice is unparsed.
  const notices: Sourced<TafNotice>[] = [];
  let open: { kind: TafNotice['kind']; start: number; last: number } | null = null;
  const close = () => {
    if (!open) return;
    const span = joinSpans(tokens[open.start]!, tokens[open.last]!);
    notices.push(sourced({ kind: open.kind, text: sliceSpan(raw, span) }, span));
    open = null;
  };
  for (let k = trailer; k < end; k++) {
    const t = tokens[k]!;
    const temp = decodeTafTemperature(t.text);
    if (temp) {
      close();
      temperatures.push(sourced(temp, at(t)));
      continue;
    }
    const kind = noticeKind(tokens, k);
    if (kind) {
      close();
      open = { kind, start: k, last: k };
    } else if (open) {
      open.last = k;
    } else {
      unparsed.push({ text: t.text, span: at(t), section: 'body' });
    }
  }
  close();

  let remarks: TafRemarks | null = null;
  if (rmk >= 0) {
    remarks = { span: joinSpans(tokens[rmk]!, tokens[tokens.length - 1]!) };
    for (let k = rmk + 1; k < tokens.length; k++) {
      unparsed.push({ text: tokens[k]!.text, span: at(tokens[k]!), section: 'remarks' });
    }
  }

  return {
    raw,
    reportType,
    modifiers,
    station,
    issued,
    validity,
    status,
    periods,
    temperatures,
    notices,
    remarks,
    unparsed,
  };
}
