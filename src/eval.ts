// Replays the challenge's three example prompts against the demo history and prints what the agent did. Run with `npm run eval`.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(tmpdir(), `recall-eval-${Date.now()}.db`);
process.env.FAKE_NOW = '2026-11-12T10:00:00';

const { now } = await import('./clock.js');
const { runAgent } = await import('./agent/loop.js');
const { dayKey, resolveDateReferences } = await import('./memory/dates.js');
const { seedDemo } = await import('./memory/store.js');

const CASES: { prompt: string; mustMention: string[] }[] = [
  {
    prompt: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
    mustMention: ['HubSpot', 'Pipedrive', 'Zoho', 'Freshsales', 'Close', 'As of'],
  },
  { prompt: 'What did I ask you on 3 November? Is your answer still correct today?', mustMention: ['Postgres', 'Neon', 'Supabase', 'As of'] },
  { prompt: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?', mustMention: ['3 November', 'Neon', 'Supabase', 'As of'] },
  { prompt: 'What did I ask you on 1 October?', mustMention: ['1 October'] },
];

console.log('Seeded days:', seedDemo(now()).days.join(', '));
let failures = 0;
for (const [index, { prompt, mustMention }] of CASES.entries()) {
  const started = Date.now();
  let firstTokenMs: number | undefined;
  let answer = '';
  const searches: string[] = [];
  for await (const event of runAgent({ conversationId: `eval-${index}`, userMessage: prompt, now: now() })) {
    if (event.type === 'token') {
      firstTokenMs ??= Date.now() - started;
      answer += event.text;
    } else if (event.type === 'status') {
      searches.push(event.text);
      answer = ''; // text before a search is not part of the answer
    } else if (event.type === 'error') answer += `\n[ERROR] ${event.message}`;
  }
  const missing = mustMention.filter((term) => !answer.toLowerCase().includes(term.toLowerCase()));
  if (missing.length) failures += 1;
  console.log(`\n=== ${prompt}`);
  console.log('Resolved dates:', resolveDateReferences(prompt, now()).map((r) => `${r.label} = ${dayKey(r.from)}`).join('; ') || 'none');
  for (const search of searches) console.log(search);
  console.log(`First token: ${firstTokenMs ?? '-'} ms, total: ${Date.now() - started} ms`);
  console.log(missing.length ? `FAIL, answer does not mention: ${missing.join(', ')}` : 'PASS');
  console.log(answer.trim());
}
process.exit(failures ? 1 : 0);
