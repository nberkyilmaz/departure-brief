import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { BriefingDocument, StoredBriefing } from '../brief/types.js';
import type { Airport } from '../domain/airport.js';
import type { AssessmentRow, CitationMatch, NotamAssessment } from '../notam/assess.js';
import type { ForecastCheck, ForecastOutcome, VerificationPair } from '../verify/types.js';
import { distanceNm } from '../domain/geo.js';
import type { DecodedRow, FetchAttempt, FetchEvent, ListRawQuery, RawReport, ReportKind, Store } from './types.js';

export const DEFAULT_DATABASE_URL = 'postgres://depbrief:depbrief@localhost:5433/depbrief';

/**
 * Airports per insert statement. Thirteen parameters each, so this is 6,500
 * of the 65,535 a Postgres statement allows — far enough under that a wider
 * airports table later does not quietly break the load.
 */
const AIRPORT_BATCH = 500;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Apply every `migrations/*.sql` not yet recorded in `schema_migrations`, in
 * filename order, each in its own transaction. Plain SQL files, no ORM.
 */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  await pool.query(
    'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
  );
  const applied = new Set(
    (await pool.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [file]);
      await client.query('commit');
      newlyApplied.push(file);
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }
  return newlyApplied;
}

interface RawRow {
  sha256: string;
  kind: ReportKind;
  source: string;
  station: string | null;
  body: string;
  issued_at: Date | null;
  upstream: unknown;
}

/**
 * Migrate, waiting for a database that is not answering yet.
 *
 * Boot order is not something a process controls. A container starts beside
 * its database and wins the race; a hosted database is briefly unreachable
 * while it wakes. Neither is an error worth dying of — and dying of it on a
 * host means a crash loop, where every attempt pays the cold start again.
 *
 * Only connection failures are retried. A migration that fails because the
 * SQL is wrong fails immediately, because waiting will not fix it and a
 * server that eventually starts against a half-migrated schema is worse
 * than one that refuses to.
 */
async function migrateWhenReachable(pool: pg.Pool, options: PostgresOptions): Promise<void> {
  const attempts = Math.max(1, options.connectAttempts ?? 10);
  const delay = options.connectRetryMs ?? 2_000;
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate(pool);
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      const unreachable = code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ETIMEDOUT' || code === 'ECONNRESET';
      if (!unreachable || attempt >= attempts) throw e;
      options.onWaiting?.(`database not reachable yet (${code}); attempt ${attempt} of ${attempts}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export interface PostgresOptions {
  readonly max?: number;
  /** Tries before giving up on a database that is not answering. Default 10. */
  readonly connectAttempts?: number;
  /** Between those tries. Default two seconds, so the default wait is twenty. */
  readonly connectRetryMs?: number;
  /** Called before each wait, so a boot log says what is happening rather than nothing. */
  readonly onWaiting?: (message: string) => void;
  readonly connectionTimeoutMillis?: number;
  readonly idleTimeoutMillis?: number;
  /**
   * Called when the pool reports an error on an idle connection. Default is
   * silence: the error is already handled by ignoring it, and a store that
   * wrote to the console would be doing the caller's logging for it.
   */
  readonly onPoolError?: (err: Error) => void;
}

interface DecodedDbRow {
  sha256: string;
  kind: ReportKind;
  decoder_version: number;
  decoded: unknown;
  decoded_at: Date;
}

export class PostgresStore implements Store {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Connect and bring the schema up to date.
   *
   * The `error` listener is not optional. A pooled connection sitting idle
   * is dropped eventually by anything between here and the database — a
   * hosted Postgres closing it after a few minutes, a load balancer, a
   * laptop's network changing — and `pg` reports that on the pool itself,
   * asynchronously, with nothing awaiting it. An unhandled `error` event on
   * an EventEmitter is a process-level throw, so without this the first
   * dropped idle connection takes the whole server down. The connection is
   * already gone; the pool will open another when one is next asked for.
   * There is nothing to do but say so.
   */
  static async connect(databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, options: PostgresOptions = {}): Promise<PostgresStore> {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      // A free hosted Postgres allows few connections, and this process is
      // one of several sharing them.
      max: options.max ?? Number(process.env.PGPOOLSIZE ?? 8),
      // Do not wait forever on a database that is not answering; a request
      // that fails at once can say so.
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
      idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    });
    pool.on('error', (err) => options.onPoolError?.(err));
    try {
      await migrateWhenReachable(pool, options);
    } catch (e) {
      // The caller never gets a store, so it can never close this pool.
      // Without this every failed boot leaves one behind holding its
      // connection attempts and its idle timers — and the retry above
      // means a database that is down for a while produces several.
      await pool.end().catch(() => {});
      throw e;
    }
    return new PostgresStore(pool);
  }

  async putRaw(report: RawReport, fetch: FetchEvent): Promise<{ inserted: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const res = await client.query(
        `insert into raw_reports (sha256, kind, source, station, body, issued_at, upstream, first_seen_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (sha256) do nothing`,
        [
          report.sha256,
          report.kind,
          report.source,
          report.station,
          report.body,
          report.issuedAt,
          report.upstream === undefined ? null : JSON.stringify(report.upstream),
          fetch.fetchedAt,
        ],
      );
      await client.query('insert into report_fetches (sha256, fetched_at, request, station) values ($1, $2, $3, $4)', [
        report.sha256,
        fetch.fetchedAt,
        fetch.request,
        fetch.station,
      ]);
      await client.query('commit');
      return { inserted: (res.rowCount ?? 0) > 0 };
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }

  async getRaw(sha256: string): Promise<RawReport | null> {
    const res = await this.pool.query<RawRow>(
      'select sha256, kind, source, station, body, issued_at, upstream from raw_reports where sha256 = $1',
      [sha256],
    );
    const row = res.rows[0];
    return row ? toRawReport(row) : null;
  }

  async listRaw(query: ListRawQuery): Promise<RawReport[]> {
    const res = await this.pool.query<RawRow>(
      // A null station means every report of this kind, for the products
      // that belong to an area rather than to an aerodrome.
      `select r.sha256, r.kind, r.source, r.station, r.body, r.issued_at, r.upstream from raw_reports r
       where r.kind = $2
         and (
           ($1::text is null and ($4::timestamptz is null or r.first_seen_at <= $4))
           or (r.station = $1 and ($4::timestamptz is null or r.first_seen_at <= $4))
           or exists (
             select 1 from report_fetches f
             where f.sha256 = r.sha256 and f.station = $1 and ($4::timestamptz is null or f.fetched_at <= $4)
           )
         )
       order by r.issued_at desc nulls last, r.first_seen_at desc
       limit $3`,
      [query.station ?? null, query.kind, query.limit ?? 20, query.knownBy ?? null],
    );
    return res.rows.map(toRawReport);
  }

  async putDecoded(row: DecodedRow): Promise<{ inserted: boolean }> {
    const res = await this.pool.query(
      `insert into decoded_reports (sha256, decoder_version, kind, decoded, decoded_at)
       values ($1, $2, $3, $4, $5)
       on conflict (sha256, decoder_version) do nothing`,
      [row.sha256, row.decoderVersion, row.kind, JSON.stringify(row.decoded), row.decodedAt],
    );
    return { inserted: (res.rowCount ?? 0) > 0 };
  }

  async getDecoded(sha256: string, decoderVersion: number): Promise<DecodedRow | null> {
    const res = await this.pool.query<DecodedDbRow>(
      'select sha256, kind, decoder_version, decoded, decoded_at from decoded_reports where sha256 = $1 and decoder_version = $2',
      [sha256, decoderVersion],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      sha256: row.sha256,
      kind: row.kind,
      decoderVersion: row.decoder_version,
      decoded: row.decoded,
      decodedAt: row.decoded_at,
    };
  }

  /**
   * Load a snapshot, in batches of {@link AIRPORT_BATCH} rows per statement.
   *
   * A full OurAirports snapshot of Canada and the United States is about
   * 26,000 airports. One statement each is 26,000 round trips, which over a
   * local socket is a few seconds and against a hosted database on another
   * continent is several minutes — long enough that a first boot looks hung.
   * The whole load is still one transaction: a snapshot is present or it is
   * not, never half.
   */
  async putAirports(airports: readonly Airport[], loadedAt: Date): Promise<{ inserted: number }> {
    const client = await this.pool.connect();
    let inserted = 0;
    try {
      await client.query('begin');
      for (let i = 0; i < airports.length; i += AIRPORT_BATCH) {
        const batch = airports.slice(i, i + AIRPORT_BATCH);
        const values: unknown[] = [];
        const rows = batch.map((a, n) => {
          values.push(a.source, a.cycle, a.siteNo, a.siteType, a.faaId, a.icaoId, a.name, a.lat, a.lon, a.elevation, a.magneticVariation, JSON.stringify(a), loadedAt);
          const base = n * 13;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13})`;
        });
        const res = await client.query(
          `insert into airports (source, cycle, site_no, site_type, faa_id, icao_id, name, lat, lon, elevation_ft, mag_var_deg, airport, loaded_at)
           values ${rows.join(', ')}
           on conflict (source, cycle, site_no, site_type) do nothing`,
          values,
        );
        inserted += res.rowCount ?? 0;
      }
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
    return { inserted };
  }

  async countAirports(): Promise<number> {
    const res = await this.pool.query<{ n: string }>('select count(*)::text as n from airports');
    return Number(res.rows[0]?.n ?? 0);
  }

  async getAirport(id: string): Promise<Airport | null> {
    const wanted = id.trim().toUpperCase();
    const res = await this.pool.query<{ airport: Airport }>(
      `select airport from airports
       where upper(icao_id) = $1 or upper(faa_id) = $1
       order by case
                  when source = 'nasr' and airport->>'country' = 'US' then 2
                  when source = 'ourairports' then 1
                  else 0
                end desc,
                cycle desc
       limit 1`,
      [wanted],
    );
    return res.rows[0]?.airport ?? null;
  }

  async listAirportsNear(lat: number, lon: number, radiusNm: number): Promise<Airport[]> {
    // Bounding box in SQL, exact great-circle filter and ordering here.
    const dLat = radiusNm / 60;
    const dLon = radiusNm / (60 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
    const res = await this.pool.query<{ airport: Airport }>(
      `select distinct on (source, site_no, site_type) airport from airports
       where lat between $1 and $2 and lon between $3 and $4
       order by source, site_no, site_type, cycle desc`,
      [lat - dLat, lat + dLat, lon - dLon, lon + dLon],
    );
    const here = { lat, lon };
    return res.rows
      .map((r) => ({ a: r.airport, d: distanceNm(here, r.airport) }))
      .filter((x) => x.d <= radiusNm)
      .sort((x, y) => x.d - y.d)
      .map((x) => x.a);
  }

  async putBriefing(b: StoredBriefing): Promise<{ inserted: boolean }> {
    const res = await this.pool.query(
      `insert into briefings (sha256, flight_key, as_of, created_at, document)
       values ($1, $2, $3, $4, $5)
       on conflict (sha256) do nothing`,
      [b.sha256, b.flightKey, b.asOf, b.createdAt, JSON.stringify(b.document)],
    );
    return { inserted: (res.rowCount ?? 0) > 0 };
  }

  async getBriefing(sha256: string): Promise<StoredBriefing | null> {
    const res = await this.pool.query<BriefingRow>('select sha256, flight_key, as_of, created_at, document from briefings where sha256 = $1', [sha256]);
    const row = res.rows[0];
    return row ? toBriefing(row) : null;
  }

  async listBriefings(flightKey: string, limit = 20): Promise<StoredBriefing[]> {
    const res = await this.pool.query<BriefingRow>(
      'select sha256, flight_key, as_of, created_at, document from briefings where flight_key = $1 order by as_of desc, created_at desc limit $2',
      [flightKey, limit],
    );
    return res.rows.map(toBriefing);
  }

  async putFetchAttempt(attempt: FetchAttempt): Promise<void> {
    await this.pool.query(
      `insert into fetch_attempts (scope, kind, attempted_at, request) values ($1, $2, $3, $4)
       on conflict (scope, kind, attempted_at) do nothing`,
      [attempt.scope.toUpperCase(), attempt.kind, attempt.attemptedAt, attempt.request],
    );
  }

  async lastFetchAt(station: string, kind: ReportKind): Promise<Date | null> {
    const res = await this.pool.query<{ last: Date | null }>(
      // The later of: when something was last received for this station, and
      // when the upstream was last asked — which are different whenever the
      // answer was "nothing", and that is the usual answer for some products.
      `select greatest(
         (select max(f.fetched_at)
          from report_fetches f join raw_reports r on r.sha256 = f.sha256
          where r.kind = $2 and (f.station = $1 or r.station = $1)),
         (select max(a.attempted_at) from fetch_attempts a where a.scope = $1 and a.kind = $2)
       ) as last`,
      [station.toUpperCase(), kind],
    );
    return res.rows[0]?.last ?? null;
  }

  async putForecastCheck(c: ForecastCheck): Promise<{ inserted: boolean }> {
    const res = await this.pool.query(
      `insert into forecast_checks (key, station, valid_at, taf_sha256, taf_issued_at, taf_decoder_version, lead_hours,
                                    ceiling_ft, visibility_sm, visibility_at_least, wind_dir_true, wind_kt, gust_kt, category, overlay_worst_category, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       on conflict (key) do nothing`,
      [c.key, c.station, c.validAt, c.tafSha256, c.tafIssuedAt, c.tafDecoderVersion, c.leadHours, c.ceilingFt, c.visibilitySm, c.visibilityAtLeast, c.windDirTrue, c.windKt, c.gustKt, c.category, c.overlayWorstCategory, c.createdAt],
    );
    return { inserted: (res.rowCount ?? 0) > 0 };
  }

  async listUnmatchedChecks(query: { station?: string | null; before: Date; limit?: number }): Promise<ForecastCheck[]> {
    const res = await this.pool.query<CheckDbRow>(
      `select c.* from forecast_checks c
       where c.valid_at <= $1 and ($2::text is null or c.station = $2)
         and not exists (select 1 from forecast_outcomes o where o.check_key = c.key)
       order by c.valid_at desc limit $3`,
      [query.before, query.station ?? null, query.limit ?? 500],
    );
    return res.rows.map(toCheck);
  }

  async putForecastOutcome(o: ForecastOutcome): Promise<{ inserted: boolean }> {
    const res = await this.pool.query(
      `insert into forecast_outcomes (check_key, metar_sha256, observed_at, offset_minutes, ceiling_ft, visibility_sm, visibility_at_least, wind_dir_true, wind_kt, gust_kt, category, matched_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (check_key, metar_sha256) do nothing`,
      [o.checkKey, o.metarSha256, o.observedAt, o.offsetMinutes, o.ceilingFt, o.visibilitySm, o.visibilityAtLeast, o.windDirTrue, o.windKt, o.gustKt, o.category, o.matchedAt],
    );
    return { inserted: (res.rowCount ?? 0) > 0 };
  }

  async listVerificationPairs(query: { station?: string | null; since?: Date | null; limit?: number }): Promise<VerificationPair[]> {
    const res = await this.pool.query<CheckDbRow & OutcomeDbRow>(
      `select c.*, o.metar_sha256, o.observed_at, o.offset_minutes,
              o.ceiling_ft as o_ceiling_ft, o.visibility_sm as o_visibility_sm, o.visibility_at_least as o_visibility_at_least, o.wind_dir_true as o_wind_dir_true,
              o.wind_kt as o_wind_kt, o.gust_kt as o_gust_kt, o.category as o_category, o.matched_at
       from forecast_outcomes o join forecast_checks c on c.key = o.check_key
       where ($1::text is null or c.station = $1) and ($2::timestamptz is null or c.valid_at >= $2)
       order by c.valid_at desc limit $3`,
      [query.station ?? null, query.since ?? null, query.limit ?? 500],
    );
    return res.rows.map((r) => ({
      check: toCheck(r),
      outcome: {
        checkKey: r.key,
        metarSha256: r.metar_sha256,
        observedAt: r.observed_at,
        offsetMinutes: r.offset_minutes,
        ceilingFt: r.o_ceiling_ft,
        visibilitySm: r.o_visibility_sm,
        visibilityAtLeast: r.o_visibility_at_least,
        windDirTrue: r.o_wind_dir_true,
        windKt: r.o_wind_kt,
        gustKt: r.o_gust_kt,
        category: r.o_category,
        matchedAt: r.matched_at,
      },
    }));
  }

  async putAssessment(row: AssessmentRow): Promise<{ inserted: boolean }> {
    const res = await this.pool.query(
      `insert into notam_assessments (notam_sha256, context_hash, prompt_version, model, assessment, citation, provider, usage_input, usage_output, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (notam_sha256, context_hash, prompt_version, model) do nothing`,
      [row.notamSha256, row.contextHash, row.promptVersion, row.model, JSON.stringify(row.assessment), row.citation, row.provider, row.usage.input, row.usage.output, row.createdAt],
    );
    return { inserted: (res.rowCount ?? 0) > 0 };
  }

  async getAssessment(notamSha256: string, contextHash: string, promptVersion: number, model: string): Promise<AssessmentRow | null> {
    const res = await this.pool.query<AssessmentDbRow>(
      `select notam_sha256, context_hash, prompt_version, model, assessment, citation, provider, usage_input, usage_output, created_at
       from notam_assessments where notam_sha256 = $1 and context_hash = $2 and prompt_version = $3 and model = $4`,
      [notamSha256, contextHash, promptVersion, model],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      notamSha256: r.notam_sha256,
      contextHash: r.context_hash,
      promptVersion: r.prompt_version,
      model: r.model,
      assessment: r.assessment,
      citation: r.citation,
      provider: r.provider,
      usage: { input: r.usage_input, output: r.usage_output },
      createdAt: r.created_at,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

interface AssessmentDbRow {
  notam_sha256: string;
  context_hash: string;
  prompt_version: number;
  model: string;
  assessment: NotamAssessment;
  citation: CitationMatch;
  provider: string;
  usage_input: number;
  usage_output: number;
  created_at: Date;
}

interface BriefingRow {
  sha256: string;
  flight_key: string;
  as_of: Date;
  created_at: Date;
  document: BriefingDocument;
}

function toBriefing(row: BriefingRow): StoredBriefing {
  return { sha256: row.sha256, flightKey: row.flight_key, asOf: row.as_of, createdAt: row.created_at, document: row.document };
}

function toRawReport(row: RawRow): RawReport {
  return {
    sha256: row.sha256,
    kind: row.kind,
    source: row.source,
    station: row.station,
    body: row.body,
    issuedAt: row.issued_at,
    upstream: row.upstream,
  };
}

interface CheckDbRow {
  key: string;
  station: string;
  valid_at: Date;
  taf_sha256: string;
  taf_issued_at: Date | null;
  taf_decoder_version: number;
  lead_hours: number | null;
  ceiling_ft: number | null;
  visibility_sm: number | null;
  visibility_at_least: boolean;
  wind_dir_true: number | null;
  wind_kt: number | null;
  gust_kt: number | null;
  category: ForecastCheck['category'];
  overlay_worst_category: ForecastCheck['category'];
  created_at: Date;
}

interface OutcomeDbRow {
  metar_sha256: string;
  observed_at: Date;
  offset_minutes: number;
  o_ceiling_ft: number | null;
  o_visibility_sm: number | null;
  o_visibility_at_least: boolean;
  o_wind_dir_true: number | null;
  o_wind_kt: number | null;
  o_gust_kt: number | null;
  o_category: ForecastCheck['category'];
  matched_at: Date;
}

function toCheck(r: CheckDbRow): ForecastCheck {
  return {
    key: r.key,
    station: r.station,
    validAt: r.valid_at,
    tafSha256: r.taf_sha256,
    tafIssuedAt: r.taf_issued_at,
    tafDecoderVersion: r.taf_decoder_version,
    leadHours: r.lead_hours,
    ceilingFt: r.ceiling_ft,
    visibilitySm: r.visibility_sm,
    visibilityAtLeast: r.visibility_at_least,
    windDirTrue: r.wind_dir_true,
    windKt: r.wind_kt,
    gustKt: r.gust_kt,
    category: r.category,
    overlayWorstCategory: r.overlay_worst_category,
    createdAt: r.created_at,
  };
}
