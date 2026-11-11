// The only place that decides what "now" is: real clock, FAKE_NOW env, or a per-request override.
import { config } from './config.js';
import { zonedTimeToUtc } from './memory/dates.js';

// Accepts "2026-11-12", "2026-11-12T10:00:00" (both read as wall time in TIMEZONE) or a full ISO string with offset.
function parseOverride(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (m) {
    const [y, mo, d, h, mi, s] = m.slice(1).map((p) => (p === undefined ? undefined : Number(p)));
    return zonedTimeToUtc(y!, mo!, d!, h ?? 12, mi ?? 0, s ?? 0, config.timezone);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function now(override?: string): Date {
  return (override && parseOverride(override)) || (config.fakeNow && parseOverride(config.fakeNow)) || new Date();
}
