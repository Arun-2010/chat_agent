// Tests for date resolution and the FTS match-expression builder. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, resolveDateReferences } from './dates.js';

const TZ = 'Asia/Kolkata';
const NOW = new Date('2026-11-12T10:00:00+05:30'); // a Thursday

const days = (text: string, now = NOW) =>
  resolveDateReferences(text, now, TZ).map((r) => {
    const from = dayKey(r.from, TZ);
    const to = dayKey(r.to, TZ);
    return from === to ? from : `${from}..${to}`;
  });

test('today, yesterday, day before yesterday', () => {
  assert.deepEqual(days('what did we discuss today'), ['2026-11-12']);
  assert.deepEqual(days('Yesterday you said'), ['2026-11-11']);
  assert.deepEqual(days('the day before yesterday'), ['2026-11-10']);
});

test('bare weekday is the most recent one strictly before today', () => {
  assert.deepEqual(days('On Monday we shortlisted 5 CRM tools'), ['2026-11-09']);
  assert.deepEqual(days('on Thursday'), ['2026-11-05']);
  assert.deepEqual(days('what about wednesday'), ['2026-11-11']);
});

test('"last <weekday>" returns both readings, or one when they coincide', () => {
  assert.deepEqual(days('Last Tuesday I asked you about Postgres hosting'), ['2026-11-03', '2026-11-10']);
  assert.deepEqual(days('last friday'), ['2026-11-06']);
  // Spec example: on a Wednesday, "last Tuesday" is 8 days ago or 1 day ago.
  assert.deepEqual(days('last tuesday', new Date('2026-11-11T10:00:00+05:30')), ['2026-11-03', '2026-11-10']);
});

test('week phrases are multi-day ranges', () => {
  assert.deepEqual(days('last week'), ['2026-11-02..2026-11-08']);
  assert.deepEqual(days('earlier this week'), ['2026-11-09..2026-11-12']);
  assert.deepEqual(days('this week'), ['2026-11-09..2026-11-12']);
});

test('calendar dates in several formats', () => {
  for (const phrase of ['3 November', 'November 3', '3rd November', 'Nov 3', '3/11', '2026-11-03', '3rd of november 2026']) {
    assert.deepEqual(days(`What did I ask you on ${phrase}?`), ['2026-11-03'], phrase);
  }
});

test('a day and month still to come this year means last year', () => {
  assert.deepEqual(days('on 25 December'), ['2025-12-25']);
  assert.deepEqual(days('on 1 October'), ['2026-10-01']);
});

test('relative counts', () => {
  assert.deepEqual(days('3 days ago'), ['2026-11-09']);
  assert.deepEqual(days('a week ago'), ['2026-11-05']);
  assert.deepEqual(days('two weeks ago'), ['2026-10-29']);
});

test('ranges cover the whole day in the configured timezone', () => {
  const [range] = resolveDateReferences('yesterday', NOW, TZ);
  assert.equal(range?.from.toISOString(), '2026-11-10T18:30:00.000Z');
  assert.equal(range?.to.toISOString(), '2026-11-11T18:29:59.999Z');
});

test('the day rolls over at local midnight, not UTC midnight', () => {
  assert.deepEqual(days('today', new Date('2026-11-12T20:00:00Z')), ['2026-11-13']);
});

test('nothing matches, invalid dates are ignored', () => {
  assert.deepEqual(days('What is the latest stable Node.js version?'), []);
  assert.deepEqual(days('on 31 February'), []);
});

test('FTS match expression quotes terms, joins with OR and drops stopwords and punctuation', async () => {
  process.env.ANTHROPIC_API_KEY ??= 'test';
  process.env.TAVILY_API_KEY ??= 'test';
  process.env.DB_PATH = ':memory:';
  const store = await import('./store.js');
  assert.equal(store.toMatchExpression('Last Tuesday I asked you about "Postgres" hosting. Has any pricing changed?'), '"postgres" OR "hosting" OR "pricing"');
  assert.equal(store.toMatchExpression('what did I ask you?'), '');

  store.saveMessage('c1', 'user', 'Postgres hosting options for a side project?', NOW);
  store.saveMessage('c1', 'assistant', 'Neon, Supabase and Railway are good options.', NOW);
  store.saveMessage('c2', 'user', 'Best running shoes (under $100)', NOW);
  const hits = store.searchTopic("postgres hosting: what's changed?");
  assert.equal(hits[0]?.content, 'Postgres hosting options for a side project?');
  assert.equal(store.getTurnPartner(hits[0]!)?.role, 'assistant');
  assert.deepEqual(store.searchTopic('???'), []);
});
