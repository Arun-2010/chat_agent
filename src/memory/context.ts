// Builds the memory block injected into the system prompt: today's date, user facts, a day index,
// verbatim messages from any day the user referred to, and topic matches.
import { config } from '../config.js';
import { dayKey, formatInTz, resolveDateReferences } from './dates.js';
import { getByDateRange, getDayIndex, getFacts, getRecent, getTurnPartner, searchTopic, toMatchExpression } from './store.js';
import type { StoredMessage } from '../types.js';

const DATE_BUDGET_CHARS = 24_000; // ~6,000 tokens
const TOPIC_BUDGET_CHARS = 12_000;
const USER_TRUNCATE_CHARS = 400;

const weekday = (day: string) => formatInTz(new Date(`${day}T12:00:00Z`), { weekday: 'short' }, 'UTC');
const dayHeading = (day: string) => `${day} (${weekday(day)})`;
const line = (m: StoredMessage, content = m.content) =>
  `[${m.role} ${formatInTz(new Date(m.created_at), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}] ${content}`;

function groupByDay(messages: StoredMessage[]): Map<string, StoredMessage[]> {
  const groups = new Map<string, StoredMessage[]>();
  for (const m of messages) groups.set(m.day, [...(groups.get(m.day) ?? []), m]);
  return groups;
}

export function buildMemoryContext(userMessage: string, conversationId: string, now: Date): string {
  const out: string[] = [];
  const today = formatInTz(now, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  out.push(`## Today\n${today} (${config.timezone}). ISO: ${dayKey(now)}.`);

  const facts = getFacts();
  out.push(`## Known facts about the user\n${facts.length ? facts.map((f) => `- ${f.key}: ${f.value} (noted ${dayKey(new Date(f.updated_at))})`).join('\n') : '- none yet'}`);

  const index = getDayIndex(30);
  out.push(`## Past conversation days (most recent first)\n${index.length
    ? index.map((d) => `- ${dayHeading(d.day)}: ${d.snippets.map((s) => JSON.stringify(s)).join(' | ')}`).join('\n')
    : '- none yet'}`);

  // Messages already in the live conversation window reach the model as chat turns, so they are not repeated here.
  const shown = new Set(getRecent(conversationId, 20).map((m) => m.id));
  const relevant: string[] = [];

  const ranges = resolveDateReferences(userMessage, now);
  const empty: string[] = [];
  let dated: { label: string; messages: StoredMessage[] }[] = [];
  for (const range of ranges) {
    const messages = getByDateRange(range.from, range.to).filter((m) => !shown.has(m.id));
    const span = dayKey(range.from) === dayKey(range.to) ? dayKey(range.from) : `${dayKey(range.from)} to ${dayKey(range.to)}`;
    if (messages.length) dated.push({ label: range.label, messages });
    else if (dayKey(range.from) !== dayKey(now)) empty.push(`"${range.label}" = ${span}`);
  }
  // Over budget: assistant answers stay whole (they are what gets re-verified); user messages are shortened.
  const total = dated.reduce((n, d) => n + d.messages.reduce((k, m) => k + m.content.length, 0), 0);
  const shorten = total > DATE_BUDGET_CHARS;
  for (const { label, messages } of dated) {
    for (const [day, dayMessages] of groupByDay(messages)) {
      relevant.push(`### ${dayHeading(day)} — matched "${label}"`);
      for (const m of dayMessages) {
        shown.add(m.id);
        relevant.push(line(m, shorten && m.role === 'user' && m.content.length > USER_TRUNCATE_CHARS ? `${m.content.slice(0, USER_TRUNCATE_CHARS)}…` : m.content));
      }
    }
  }
  if (empty.length) relevant.push(`No stored messages for: ${empty.join('; ')}.`);

  const hits: StoredMessage[] = [];
  let budget = TOPIC_BUDGET_CHARS;
  for (const hit of searchTopic(userMessage, 10)) {
    const partner = getTurnPartner(hit);
    const turn = [hit, ...(partner ? [partner] : [])].filter((m) => !shown.has(m.id)).sort((a, b) => a.id - b.id);
    const size = turn.reduce((n, m) => n + m.content.length, 0);
    if (!turn.length || size > budget) continue;
    budget -= size;
    for (const m of turn) { shown.add(m.id); hits.push(m); }
  }
  if (hits.length) {
    relevant.push(`### Topic matches for ${toMatchExpression(userMessage).replaceAll(' OR ', ', ')}`);
    for (const [day, dayMessages] of groupByDay(hits.sort((a, b) => a.id - b.id))) {
      relevant.push(`#### ${dayHeading(day)}`, ...dayMessages.map((m) => line(m)));
    }
  }

  out.push(`## Relevant past messages\n${relevant.length ? relevant.join('\n') : 'No earlier conversations matched.'}`);
  return out.join('\n\n');
}
