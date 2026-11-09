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

/** This device's zone at that instant, as a clock prints it: EDT, PST. */
export function zoneOf(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date(iso)).find((p) => p.type === 'timeZoneName')?.value ?? '';
}

/** "14:32": the wall clock on twenty-four hours, so a time fits a narrow column. */
export function clock24(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** "Thu 5:00 PM EDT": the clock a pilot plans by, in this device's time zone. */
export function localClock(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}
