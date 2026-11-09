import type { Kv, SnapshotMeta } from './relay.js';

/** The most metadata Workers KV takes on one entry; over it, the whole write is refused. */
const METADATA_MAX_BYTES = 1024;

/**
 * Workers KV, as far as the relay uses it, in a Map. For the Node adapter
 * and the tests; it counts writes because the free plan does, and refuses
 * what the real one refuses, with the same words.
 */
export class MemoryKv implements Kv {
  private readonly entries = new Map<string, { value: ArrayBuffer; metadata: SnapshotMeta }>();
  writes = 0;

  async getWithMetadata(key: string): Promise<{ value: ArrayBuffer | null; metadata: SnapshotMeta | null }> {
    const e = this.entries.get(key);
    return e ? { value: e.value, metadata: e.metadata } : { value: null, metadata: null };
  }

  async put(key: string, value: ArrayBuffer, options: { metadata: SnapshotMeta }): Promise<void> {
    if (new TextEncoder().encode(JSON.stringify(options.metadata)).length > METADATA_MAX_BYTES) throw new Error('KV PUT failed: 413 Payload Too Large');
    this.writes++;
    this.entries.set(key, { value, metadata: options.metadata });
  }
}
