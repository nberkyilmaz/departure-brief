/**
 * Everything needed to judge a flight, and nothing that talks to the world.
 *
 * The root entry point reaches Postgres, the filesystem, pdf.js and the
 * network, so it can only run on a server. This one is the deterministic
 * middle of the pipeline — decode, resolve, judge, assemble — over an
 * in-memory store, which runs anywhere JavaScript does.
 *
 * That is what lets the web app produce a briefing itself, byte for byte
 * the same as the one the API would produce from the same reports, rather
 * than rendering a result it has to take on trust. Fetching still needs a
 * server: neither weather service allows a browser to call it directly.
 *
 * `test/judge.browser.test.ts` bundles this for a browser and fails if
 * anything on the graph reaches for Node.
 */
export * from './domain/units.js';
export * from './domain/time.js';
export * from './domain/geo.js';
export * from './domain/airport.js';
export * from './domain/flight.js';
export * from './domain/profile.js';
export * from './domain/sun.js';
export * from './decode/index.js';
export * from './resolve/index.js';
export * from './rules/index.js';
export * from './brief/index.js';
export * from './hash/sha256.js';
// Weight and balance: the computation and the handbook limits it fills in.
export * from './wb/compute.js';
export { withHandbookLimits } from './wb/aircraft.js';
export { assembleWeightBalance, isCgPointName, missingFrom } from './wb/assemble.js';
export type { CgEnvelope, DocumentCitation, Figure, Loading, LoadingResult, LoadingRow, ReviewItem, Station, StationKind, WbFinding, WeightBalanceSpec } from './wb/types.js';
export type * from './store/types.js';
export { rawReport } from './store/types.js';
export { MemoryStore } from './store/memory.js';
// NOTAMs: decoding, classification and description are deterministic. The
// relevance model and its eval harness are not here — they are a server's job.
export { decodeNotam, NOTAM_DECODER_VERSION } from './notam/decode.js';
export type { DecodedNotam, NotamEnd, NotamId, NotamInstant, NotamType, QCode, QLine } from './notam/types.js';
export { classifyNotam, scheduleIntervals } from './notam/filter.js';
export type { FlightWindow, NotamClassification, TimeStatus } from './notam/filter.js';
export { dedupeNotams } from './notam/dedupe.js';
export type { DedupedNotam } from './notam/dedupe.js';
export { describeQCode, Q_CONDITIONS, Q_PURPOSE, Q_SCOPE, Q_SUBJECTS, Q_TRAFFIC } from './notam/qcodes.js';
export type { QCodeEntry, QCodeMeaning } from './notam/qcodes.js';
export { notamBriefingText, notamDocument } from './notam/describe.js';
export type { NotamDocument, NotamDocumentItem } from './notam/describe.js';
export { ruleRelevance } from './notam/rules.js';
export type { RuleDecision } from './notam/rules.js';
/*
 * Ranking NOTAMs for a flight, including the rules that settle relevance
 * from the Q code. Without a model it ranks what the rules can settle and
 * says the rest was not assessed, which is exactly what should happen where
 * there is no model to call.
 */
export { flightContextOf, notamFactsOf, notamsForFlight, RANK_ORDER, WINDOW_MARGIN_MS } from './notam/flight.js';
export type { NotamBriefing, NotamDeps, NotamRank, NotamSource, RankedNotam } from './notam/flight.js';
export { flightContextHash, PROMPT_VERSION, verifyCitation } from './notam/assess.js';
export type { Affects, Category, FlightContext, NotamAssessment, Relevance } from './notam/assess.js';
export { storeAndDecode } from './store/decode.js';
// Carrying a store's contents somewhere with no database and no network.
export { BundleIntegrityError, loadBundle } from './demo/bundle.js';
export type { BundledReport, DemoBundle } from './demo/bundle.js';
// Implemented by the caller when there is no model to call; the type is erased.
export type { LLMProvider, LLMRequest, LLMResponse } from './llm/provider.js';
