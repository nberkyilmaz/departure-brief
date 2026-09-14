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
export * from './wb/compute.js';
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
