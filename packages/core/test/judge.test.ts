/**
 * The `@depbrief/core/judge` entry point has to run in a browser, because
 * that is what lets the web app produce a briefing itself instead of
 * rendering one it has to take on trust.
 *
 * Nothing enforces that at compile time — the first sign of a mistake would
 * be a blank page — so the import graph is walked here. Any module reachable
 * from `judge.ts` that reaches for Node, or for a package, fails this.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleBriefing, decodeMetar, MemoryStore, parsePilotProfile, sha256Hex } from '../src/judge.js';

const SRC = resolve(__dirname, '..', 'src');

/**
 * Every import in a module that survives compilation. `import type` and
 * `export type` are erased, so a type reaching into the server half of the
 * package costs a browser nothing — only values are followed here.
 */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specs: string[] = [];
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)(?!\s+type\b)[\s\S]*?from\s+'([^']+)'/g)) specs.push(m[1]!);
  for (const m of text.matchAll(/import\('([^']+)'\)/g)) specs.push(m[1]!);
  return specs;
}

/** Walks from an entry point, returning what it reaches and what it reaches for. */
function graph(entry: string): { files: string[]; external: { from: string; spec: string }[] } {
  const seen = new Set<string>();
  const external: { from: string; spec: string }[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) {
      if (!spec.startsWith('.')) {
        external.push({ from: relative(SRC, file).replace(/\\/g, '/'), spec });
        continue;
      }
      queue.push(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
    }
  }
  return { files: [...seen], external };
}

describe('the judging entry point', () => {
  it('reaches for nothing outside itself', () => {
    const { files, external } = graph(join(SRC, 'judge.ts'));
    // It is a real slice of the pipeline, not a stub.
    expect(files.length).toBeGreaterThan(30);
    expect(external).toEqual([]);
  });

  it('still reaches the parts a briefing is made of', () => {
    const { files } = graph(join(SRC, 'judge.ts'));
    const names = files.map((f) => relative(SRC, f).replace(/\\/g, '/'));
    for (const needed of ['decode/metar/index.ts', 'decode/taf/index.ts', 'rules/evaluate.ts', 'brief/assemble.ts', 'store/memory.ts', 'notam/decode.ts']) {
      expect(names).toContain(needed);
    }
    // And not the parts that only a server can run.
    for (const serverOnly of ['store/postgres.ts', 'fetch/http.ts', 'docs/reader/render.ts', 'llm/ollama.ts']) {
      expect(names).not.toContain(serverOnly);
    }
  });

  it('exports a working pipeline, not just types', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(decodeMetar('METAR CYSN 121900Z 18008KT 15SM BKN072 26/19 A2990').station?.value).toBe('CYSN');
    expect(new MemoryStore()).toBeDefined();
    expect(typeof assembleBriefing).toBe('function');
    const profile = parsePilotProfile(JSON.parse(readFileSync(resolve(SRC, '..', '..', '..', 'profiles', 'default.json'), 'utf8')));
    expect(profile.ceiling).toBe(2500);
    expect(profile.crosswind).toBe(15);
  });
});
