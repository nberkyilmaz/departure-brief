import { describe, expect, it } from 'vitest';
import { PostgresStore } from '../../src/store/postgres.js';

/**
 * Connecting to a database that is not answering yet.
 *
 * Boot order is not something a process controls: a container starts beside
 * its database and wins the race, and a hosted database is briefly away
 * while it wakes. On a host, dying of that is a crash loop in which every
 * attempt pays the cold start again — which is how this was found, as a CI
 * job whose container started before Postgres was listening on TCP.
 *
 * No database is needed here. Every case is about what happens when there
 * is not one.
 */

/** An address in the range reserved for documentation; nothing listens there. */
const NOWHERE = 'postgres://depbrief:depbrief@127.0.0.1:1/depbrief';

describe('connecting to a database that is not there', () => {
  it('waits and tries again, saying so each time', async () => {
    const waited: string[] = [];
    await expect(PostgresStore.connect(NOWHERE, { connectAttempts: 3, connectRetryMs: 1, onWaiting: (m) => waited.push(m) })).rejects.toThrow();
    // Two waits for three attempts: it does not wait after the last one.
    expect(waited).toHaveLength(2);
    expect(waited[0]).toMatch(/database not reachable yet \(ECONNREFUSED\); attempt 1 of 3/);
    expect(waited[1]).toMatch(/attempt 2 of 3/);
  });

  it('gives up eventually rather than hanging forever', async () => {
    await expect(PostgresStore.connect(NOWHERE, { connectAttempts: 2, connectRetryMs: 1 })).rejects.toThrow(/ECONNREFUSED/);
  });

  it('tries once when told to, for a caller that wants to fail fast', async () => {
    const waited: string[] = [];
    await expect(PostgresStore.connect(NOWHERE, { connectAttempts: 1, onWaiting: (m) => waited.push(m) })).rejects.toThrow();
    expect(waited).toEqual([]);
  });

  it('does not wait on a name that does not resolve any longer than on a refused port', async () => {
    const waited: string[] = [];
    await expect(
      PostgresStore.connect('postgres://u:p@no-such-host.invalid:5432/db', { connectAttempts: 2, connectRetryMs: 1, onWaiting: (m) => waited.push(m) }),
    ).rejects.toThrow();
    // A name that cannot be resolved is the same kind of "not there yet" as
    // a port that refuses: a hosted database's DNS can lag its creation.
    expect(waited).toHaveLength(1);
    expect(waited[0]).toMatch(/ENOTFOUND|EAI_AGAIN/);
  });
});
