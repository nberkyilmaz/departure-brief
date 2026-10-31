/** Zulu first, local beside it — never instead of it. */
export function zulu(iso: string): string {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function local(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short', month: 'short', day: 'numeric' });
}

export function hhmmZ(iso: string): string {
  return zulu(iso).slice(11, 16) + 'Z';
}

/** "Thu 5:00 PM EDT": the clock a pilot plans by, in this device's time zone. */
export function localClock(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}
