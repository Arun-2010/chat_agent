// Deterministic date maths: timezone helpers plus resolveDateReferences, which turns phrases like
// "last Tuesday" or "3 November" into concrete day ranges. The model is never asked to do this.
import { addDays, getDay, isAfter, startOfWeek, subDays } from 'date-fns';
import type { DateRange } from '../types.js';

const DEFAULT_TZ = process.env.TIMEZONE?.trim() || 'Asia/Kolkata';

function tzOffsetMs(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant at which the wall clock in `tz` reads the given date and time. */
export function zonedTimeToUtc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, tz = DEFAULT_TZ): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = guess - tzOffsetMs(new Date(guess), tz);
  return new Date(guess - tzOffsetMs(new Date(first), tz)); // second pass settles DST edges
}

/** YYYY-MM-DD of an instant as seen in `tz`. */
export function dayKey(instant: Date, tz = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

export function formatInTz(instant: Date, options: Intl.DateTimeFormatOptions, tz = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...options }).format(instant);
}

// Calendar days are handled as system-local midnight Dates so date-fns arithmetic is safe;
// they are converted to real instants in the target timezone only at the edges.
const toCal = (key: string): Date => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};
const calStart = (cal: Date, tz: string): Date => zonedTimeToUtc(cal.getFullYear(), cal.getMonth() + 1, cal.getDate(), 0, 0, 0, tz);

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

export function resolveDateReferences(text: string, now: Date, tz = DEFAULT_TZ): DateRange[] {
  const today = toCal(dayKey(now, tz));
  const weekStart = startOfWeek(today, { weekStartsOn: 1 });
  const ranges: DateRange[] = [];
  let rest = text.toLowerCase();

  const add = (label: string, first: Date, last = first) => {
    const from = calStart(first, tz);
    const to = new Date(calStart(addDays(last, 1), tz).getTime() - 1);
    if (!ranges.some((r) => r.from.getTime() === from.getTime() && r.to.getTime() === to.getTime())) ranges.push({ label, from, to });
  };
  // Each matched phrase is blanked out so a later, looser pattern cannot match inside it
  // ("day before yesterday" must not also count as "yesterday").
  const scan = (re: RegExp, handle: (m: RegExpExecArray) => void) => {
    rest = rest.replace(re, (...args) => {
      handle(args.slice(0, -2) as unknown as RegExpExecArray);
      return ' '.repeat((args[0] as string).length);
    });
  };
  // A day and month with no year means the most recent such date, so a future one rolls back a year.
  const addCalendarDay = (label: string, day: number, monthIndex: number, year?: number) => {
    let cal = new Date(year ?? today.getFullYear(), monthIndex, day);
    if (cal.getMonth() !== monthIndex || cal.getDate() !== day) return; // e.g. 31 February
    if (year === undefined && isAfter(cal, today)) cal = new Date(today.getFullYear() - 1, monthIndex, day);
    add(label, cal);
  };
  const fullYear = (y?: string) => (y === undefined ? undefined : y.length === 2 ? 2000 + Number(y) : Number(y));
  const monthIndex = (name: string) => MONTHS.indexOf(name.slice(0, 3));

  scan(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => addCalendarDay(m[0], Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  scan(/\bday before yesterday\b/g, (m) => add(m[0], subDays(today, 2)));
  scan(/\byesterday\b/g, (m) => add(m[0], subDays(today, 1)));
  scan(/\btoday\b/g, (m) => add(m[0], today));
  scan(/\b(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten) (day|week)s? ago\b/g, (m) => {
    const n = NUMBER_WORDS[m[1]!] ?? Number(m[1]);
    add(m[0], subDays(today, m[2] === 'week' ? n * 7 : n));
  });
  scan(/\b(?:earlier )?this week\b/g, (m) => add(m[0], weekStart, today));
  scan(/\blast week\b/g, (m) => add(m[0], subDays(weekStart, 7), subDays(weekStart, 1)));

  // "last Tuesday" is ambiguous in everyday English: some mean the Tuesday of the previous
  // Mon-Sun week, others the most recent Tuesday. Return both candidates (one range when they
  // coincide); the context builder shows whichever day actually has messages.
  // A bare "Tuesday" / "on Tuesday" is unambiguous: the most recent Tuesday strictly before today.
  const mostRecent = (weekday: number) => subDays(today, ((getDay(today) - weekday + 6) % 7) + 1);
  scan(new RegExp(`\\blast (${WEEKDAYS.join('|')})\\b`, 'g'), (m) => {
    const weekday = WEEKDAYS.indexOf(m[1]!);
    add(`${m[0]} (previous week)`, addDays(subDays(weekStart, 7), (weekday + 6) % 7));
    add(`${m[0]} (most recent)`, mostRecent(weekday));
  });
  scan(new RegExp(`\\b(?:on )?(${WEEKDAYS.join('|')})\\b`, 'g'), (m) => add(m[0], mostRecent(WEEKDAYS.indexOf(m[1]!))));

  scan(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${MONTH_RE}\\b(?:,? (\\d{4}))?`, 'g'), (m) =>
    addCalendarDay(m[0], Number(m[1]), monthIndex(m[2]!), fullYear(m[3])));
  scan(new RegExp(`\\b${MONTH_RE} (\\d{1,2})(?:st|nd|rd|th)?\\b(?:,? (\\d{4}))?`, 'g'), (m) =>
    addCalendarDay(m[0], Number(m[2]), monthIndex(m[1]!), fullYear(m[3])));
  scan(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/g, (m) => addCalendarDay(m[0], Number(m[1]), Number(m[2]) - 1, fullYear(m[3])));

  return ranges.sort((a, b) => a.from.getTime() - b.from.getTime());
}
