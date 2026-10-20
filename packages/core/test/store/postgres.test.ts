/**
 * Runs the store contract against a real Postgres when one is reachable.
 * Uses a dedicated `depbrief_test` database (created on demand) so that no
 * test row — they contain synthetic airports — can ever land in the
 * development database. Skips when nothing answers on the Compose port, so
 * `npm test` passes without Docker; run `npm run db:up` to include it.
 */
import pg from 'pg';
import { afterAll, describe, it } from 'vitest';
import { DEFAULT_DATABASE_URL, migrate, PostgresStore } from '../../src/store/postgres.js';
import { storeContract } from './contract.js';

/*
 * One database per process, not one shared by every run.
 *
 * The contract truncates on every `make()`, so two suites running at once
 * — a watch process and a one-off, or simply the same command twice —
 * wiped each other's rows mid-test. That surfaced as a scatter of
 * impossible failures: a decoding that had just been written coming back
 * undefined, an airport load reporting rows it had not inserted, a
 * forecast outcome violating the foreign key to a check that existed a
 * moment earlier. Naming the database after the process removes the whole
 * class of it, and the drop at the end leaves nothing behind.
 */
const TEST_DB = `depbrief_test_${process.pid}`;
const adminUrl = process.env.DEPBRIEF_TEST_ADMIN_URL ?? DEFAULT_DATABASE_URL;
const testUrl = process.env.DEPBRIEF_TEST_DATABASE_URL ?? adminUrl.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);

/** Create the test database if the server is up; false when it is not. */
async function prepare(): Promise<boolean> {
  const admin = new pg.Pool({ connectionString: adminUrl, connectionTimeoutMillis: 1500 });
  try {
    const exists = await admin.query('select 1 from pg_database where datname = $1', [TEST_DB]);
    if (exists.rowCount === 0) await admin.query(`create database ${TEST_DB}`);
    return true;
  } catch {
    return false;
  } finally {
    await admin.end();
  }
}

const available = await prepare();

if (available) {
  const pools: pg.Pool[] = [];
  storeContract('PostgresStore', async () => {
    const pool = new pg.Pool({ connectionString: testUrl });
    pools.push(pool);
    await migrate(pool);
    // Every table, including fetch_attempts — it was added after this list
    // and left out of it, which passes on a fresh database and fails the
    // second time the suite is run against the same one.
    await pool.query(
      'truncate forecast_outcomes, forecast_checks, notam_assessments, report_fetches, fetch_attempts, decoded_reports, raw_reports, airports, briefings',
    );
    // Sanity check on the JSON backfill migration: a row inserted with no
    // `source` in its document must come back with one.
    await pool.query(
      `insert into airports (source, cycle, site_no, site_type, faa_id, icao_id, name, lat, lon, airport, loaded_at)
       values ('nasr', '2020-01-01', 'legacy', 'A', 'LGY', null, 'legacy', 0, 0, '{"faaId":"LGY","country":"US"}', now())`,
    );
    await pool.query(`update airports set airport = airport || jsonb_build_object('source', source) where airport->>'source' is null`);
    const legacy = await pool.query<{ airport: { source?: string } }>(`select airport from airports where site_no = 'legacy'`);
    if (legacy.rows[0]?.airport.source !== 'nasr') throw new Error('source backfill did not apply');
    await pool.query(`delete from airports where site_no = 'legacy'`);
    return new PostgresStore(pool);
  });
  afterAll(async () => {
    // Every pool the contract opened, closed, before the database it is
    // connected to can be dropped.
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
    const admin = new pg.Pool({ connectionString: adminUrl });
    await admin.query(`drop database if exists ${TEST_DB}`).catch(() => {});
    await admin.end();
  });
} else {
  describe('ReportStore contract: PostgresStore', () => {
    it.skip(`skipped: no database at ${adminUrl} (run npm run db:up)`, () => {});
  });
}
