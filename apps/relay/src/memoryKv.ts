import type { Kv, SnapshotMeta } from './relay.js';

/**
 * Workers KV, as far as the relay uses it, in a Map. For the Node adapter
 * and the tests; it counts writes because the free plan does.
 */
export class MemoryKv implements Kv {
  private readonly entries = new Map<string, { value: ArrayBuffer; metadata: SnapshotMeta }>();
  writes = 0;

  async getWithMetadata(key: string): Promise<{ value: ArrayBuffer | null; metadata: SnapshotMeta | null }> {
    const e = this.entries.get(key);
    return e ? { value: e.value, metadata: e.metadata } : { value: null, metadata: null };
  }

  async put(key: string, value: ArrayBuffer, options: { metadata: SnapshotMeta }): Promise<void> {
    this.writes++;
    this.entries.set(key, { value, metadata: options.metadata });
  }
}
