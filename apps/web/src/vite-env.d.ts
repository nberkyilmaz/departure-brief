/// <reference types="vite/client" />

/** The build-time switches this app reads, so a typo in one is a type error. */
interface ImportMetaEnv {
  /** `1` in the public demo build: no API, one recorded briefing. */
  readonly VITE_DEMO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv & { readonly BASE_URL: string };
}
