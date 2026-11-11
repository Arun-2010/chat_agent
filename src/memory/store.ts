// All reads and writes against the memory database: messages by conversation, date and topic, plus user facts and demo seeding.
import { readFileSync } from 'node:fs';
import { addDays, differenceInCalendarWeeks } from 'date-fns';
import { db } from './db.js';
import { dayKey } from './dates.js';
import type { DayIndexRow, Fact, Role, StoredMessage } from '../types.js';

export const SEED_CONVERSATION = 'demo-seed';
const SEED_REFERENCE_TODAY = '2026-11-12';

const STOPWORDS = new Set(`a about after again all also am an and any are as ask asked at be been before but by can could did do does
for from had has have how i if in into is it its just last me my of on or our say said since so some still tell than that the their them then
there these they this to told us was we were what when where which who why will with would you your today yesterday week day ago
monday tuesday wednesday thursday friday saturday sunday answer correct changed change anything something`.split(/\s+/));

/** Turns free text into an FTS5 expression: quoted terms joined with OR. Bare spaces would mean AND, and raw punctuation is a syntax error. */
export function toMatchExpression(text: string): string {
  const terms = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1 && !STOPWORDS.has(t));
  return [...new Set(terms)].map((t) => `"${t}"`).join(' OR ');
}

export function saveMessage(conversationId: string, role: Role, content: string, now: Date): number {
  const result = db
    .prepare('INSERT INTO messages (conversation_id, role, content, created_at, day) VALUES (?, ?, ?, ?, ?)')
    .run(conversationId, role, content, now.toISOString(), dayKey(now));
  return Number(result.lastInsertRowid);
}

export function getRecent(conversationId: string, limit = 20): StoredMessage[] {
  const rows = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?').all(conversationId, limit);
  return (rows as StoredMessage[]).reverse();
}

export function getByDateRange(from: Date, to: Date): StoredMessage[] {
  return db
    .prepare('SELECT * FROM messages WHERE created_at BETWEEN ? AND ? ORDER BY created_at, id')
    .all(from.toISOString(), to.toISOString()) as StoredMessage[];
}

export function searchTopic(query: string, limit = 10): StoredMessage[] {
  const expression = toMatchExpression(query);
  if (!expression) return [];
  return db
    .prepare('SELECT m.* FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT ?')
    .all(expression, limit) as StoredMessage[];
}

/** The other half of a question/answer pair, so a topic hit always comes with its counterpart. */
export function getTurnPartner(message: StoredMessage): StoredMessage | undefined {
  const sql = message.role === 'user'
    ? "SELECT * FROM messages WHERE conversation_id = ? AND id > ? AND role = 'assistant' ORDER BY id LIMIT 1"
    : "SELECT * FROM messages WHERE conversation_id = ? AND id < ? AND role = 'user' ORDER BY id DESC LIMIT 1";
  return db.prepare(sql).get(message.conversation_id, message.id) as StoredMessage | undefined;
}

export function getDayIndex(limitDays = 30): DayIndexRow[] {
  const rows = db
    .prepare(`SELECT day, role, content FROM messages
              WHERE day IN (SELECT DISTINCT day FROM messages ORDER BY day DESC LIMIT ?) ORDER BY day DESC, id`)
    .all(limitDays) as Pick<StoredMessage, 'day' | 'role' | 'content'>[];
  const byDay = new Map<string, DayIndexRow>();
  for (const row of rows) {
    const entry = byDay.get(row.day) ?? { day: row.day, count: 0, snippets: [] };
    entry.count += 1;
    if (row.role === 'user') entry.snippets.push(row.content.length > 120 ? `${row.content.slice(0, 120)}…` : row.content);
    byDay.set(row.day, entry);
  }
  return [...byDay.values()];
}

export function upsertFact(key: string, value: string, now: Date): void {
  db.prepare('INSERT INTO facts (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, value, now.toISOString());
}

export function getFacts(): Fact[] {
  return db.prepare('SELECT * FROM facts ORDER BY key').all() as Fact[];
}

export function countMessages(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
}

/**
 * Loads data/seed.json (written relative to a "today" of 12 Nov 2026). Timestamps are shifted by a whole
 * number of weeks so that reference day lands in the current week: weekdays survive, so "on Monday" and
 * "last Tuesday" work whenever the demo is run. Idempotent. Returns the days the history landed on.
 */
export function seedDemo(now: Date): { seeded: boolean; days: string[] } {
  const existing = db.prepare('SELECT DISTINCT day FROM messages WHERE conversation_id = ? ORDER BY day').all(SEED_CONVERSATION) as { day: string }[];
  if (existing.length) return { seeded: false, days: existing.map((r) => r.day) };
  const seed = JSON.parse(readFileSync(new URL('../../data/seed.json', import.meta.url), 'utf8')) as { role: Role; content: string; created_at: string }[];
  const weeks = differenceInCalendarWeeks(new Date(`${dayKey(now)}T00:00:00`), new Date(`${SEED_REFERENCE_TODAY}T00:00:00`), { weekStartsOn: 1 });
  const days = new Set<string>();
  db.transaction(() => {
    for (const item of seed) {
      const at = addDays(new Date(item.created_at), weeks * 7);
      saveMessage(SEED_CONVERSATION, item.role, item.content, at);
      days.add(dayKey(at));
    }
  })();
  return { seeded: true, days: [...days] };
}
