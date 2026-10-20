/// <reference types="vite/client" />

/** The build-time switches this app reads, so a typo in one is a type error. */
interface ImportMetaEnv {
  /** `1` in the public build: no API; the page judges the reports itself. */
  readonly VITE_DEMO?: string;
  /**
   * The relay's address, in the public build. Set, the page fetches live
   * weather through it on every load and falls back to the recorded
   * reports if it cannot; unset or empty, it carries the recorded ones only.
   */
  readonly VITE_RELAY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv & { readonly BASE_URL: string };
}
