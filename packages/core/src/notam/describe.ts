/**
 * The NOTAM part of a briefing document and its text rendering. The
 * document form keeps everything a reader needs to check the ranking —
 * raw text, classification reasons, the model's answer and its citation
 * result — without the upstream metadata (that lives in the store, by hash).
 */

import type { NotamAssessment } from './assess.js';
import type { CitationMatch } from './assess.js';
import type { NotamClassification } from './filter.js';
import type { NotamBriefing, NotamRank, RankedNotam } from './flight.js';
import { describeQCode, type QCodeMeaning } from './qcodes.js';

export interface NotamDocumentItem {
  readonly sha256: string;
  readonly id: string | null;
  readonly raw: string;
  readonly text: string | null;
  readonly qcode: string | null;
  readonly qcodeMeaning: QCodeMeaning | null;
  readonly locations: readonly string[];
  readonly from: string | null;
  readonly to: string | null;
  readonly schedule: string | null;
  readonly sites: readonly string[];
  readonly supersededBy: string | null;
  readonly classification: NotamClassification;
  readonly rank: NotamRank;
  /*
   * Whether the answer came from the cache is deliberately not here. A
   * briefing is named by the hash of this document, and two briefings with
   * the same findings over the same reports must be the same briefing —
   * whether a model was asked again, or its earlier answer reused, is about
   * how the answer arrived, not about what it says.
   */
  readonly assessment: {
    readonly model: string;
    readonly promptVersion: number;
    readonly citation: CitationMatch;
    readonly result: NotamAssessment;
  } | null;
  readonly assessmentError: string | null;
  /** Settled by a deterministic rule; no model involved. */
  readonly rule: { readonly relevance: string; readonly rule: string; readonly reason: string } | null;
}

export interface NotamDocument {
  readonly sites: readonly string[];
  readonly model: string | null;
  readonly promptVersion: number;
  readonly contextHash: string;
  readonly counts: Readonly<Record<NotamRank, number>>;
  readonly fetchErrors: readonly { readonly site: string; readonly error: string }[];
  readonly items: readonly NotamDocumentItem[];
}

function toItem(r: RankedNotam): NotamDocumentItem {
  const d = r.decoded;
  const to = d.to ? ('permanent' in d.to.value ? 'PERM' : `${d.to.value.iso}${d.to.value.estimated ? ' EST' : ''}`) : null;
  return {
    sha256: r.report.sha256,
    id: d.id?.value.text ?? null,
    raw: d.raw,
    text: d.text?.value ?? null,
    qcode: d.q?.value.code.text ?? null,
    qcodeMeaning: d.q ? describeQCode(d.q.value) : null,
    locations: d.locations?.value ?? [],
    from: d.from?.value.iso ?? null,
    to,
    schedule: d.schedule?.value.replace(/\s+/g, ' ') ?? null,
    sites: r.sites,
    supersededBy: r.supersededBy,
    classification: r.classification,
    rank: r.rank,
    assessment: r.assessment
      ? { model: r.assessment.model, promptVersion: r.assessment.promptVersion, citation: r.assessment.citation, result: r.assessment.assessment }
      : null,
    assessmentError: r.assessmentError,
    rule: r.rule,
  };
}

export function notamDocument(nb: NotamBriefing): NotamDocument {
  return {
    sites: nb.sites,
    model: nb.model,
    promptVersion: nb.promptVersion,
    contextHash: nb.contextHash,
    counts: nb.counts,
    fetchErrors: nb.fetchErrors,
    items: nb.items.map(toItem),
  };
}

const RANK_LABEL: Record<NotamRank, string> = {
  critical: 'CRITICAL',
  advisory: 'advisory',
  unverified: 'UNVERIFIED (model cited text not in the NOTAM)',
  'not-assessed': 'in scope, not assessed (no model)',
  irrelevant: 'irrelevant to this flight',
  'out-of-scope': 'outside the flight window or area',
};

export function notamBriefingText(doc: NotamDocument): string {
  const lines: string[] = [
    `NOTAMs for ${doc.sites.join(', ')}${doc.model ? ` — ranked by ${doc.model} (prompt v${doc.promptVersion})` : ' — no model configured; deterministic classification only'}`,
    `${doc.items.length} NOTAMs: ${Object.entries(doc.counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`)
      .join(', ')}. Nothing is hidden; ranking sets order only.`,
  ];
  for (const e of doc.fetchErrors) lines.push(`  ! ${e.site}: fetch failed — ${e.error}`);
  let current: NotamRank | null = null;
  for (const it of doc.items) {
    if (it.rank !== current) {
      current = it.rank;
      lines.push('', `— ${RANK_LABEL[it.rank]} —`);
    }
    const meaning = it.qcodeMeaning ? `${it.qcodeMeaning.subject ?? it.qcode} · ${it.qcodeMeaning.condition ?? ''}`.trim() : (it.qcode ?? '');
    lines.push(`${it.id ?? '(no id)'}  ${meaning}  [${it.sites.join(' ')}]${it.supersededBy ? `  superseded by ${it.supersededBy}` : ''}`);
    if (it.assessment) {
      lines.push(`  ${it.assessment.result.plain_text}`);
      lines.push(`  → ${it.assessment.result.relevance} (${it.assessment.result.category}; ${it.assessment.result.affects.join(', ') || 'no phase'}): ${it.assessment.result.rationale}`);
      lines.push(`  cites "${it.assessment.result.cited_span}" — ${it.assessment.citation === 'none' ? 'NOT FOUND in NOTAM' : 'verified'}`);
    }
    if (it.rule) lines.push(`  → ${it.rule.relevance} by rule ${it.rule.rule}: ${it.rule.reason}`);
    if (it.assessmentError) lines.push(`  ! ${it.assessmentError}`);
    lines.push(`  ${it.classification.reasons.join('; ')}`);
    lines.push(`  ${(it.text ?? it.raw).replace(/\s+/g, ' ')}`);
  }
  return lines.join('\n');
}
