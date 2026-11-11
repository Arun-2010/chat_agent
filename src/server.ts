// Express app: serves the UI, streams agent events over SSE, and exposes history, the day index, seeding and health.
import express, { type Request, type Response } from 'express';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { runAgent } from './agent/loop.js';
import { now } from './clock.js';
import { config } from './config.js';
import { dayKey } from './memory/dates.js';
import { countMessages, getDayIndex, getRecent, seedDemo } from './memory/store.js';

const app = express();
app.use(express.json());
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

// "Today" can be overridden per request (x-fake-now header or ?now=) so a reviewer can replay different days.
const requestNow = (req: Request): Date => now(req.header('x-fake-now') || (typeof req.query.now === 'string' ? req.query.now : undefined));

const chatInput = z.object({ conversationId: z.string().min(1).max(100), message: z.string().trim().min(1).max(8000) });

async function chat(req: Request, res: Response): Promise<void> {
  const parsed = chatInput.safeParse(req.method === 'GET' ? req.query : req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'conversationId and message are required' });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  // A closed connection stops the model stream and any in-flight searches.
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const events = runAgent({ conversationId: parsed.data.conversationId, userMessage: parsed.data.message, now: requestNow(req), signal: abort.signal });
  for await (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
}

app.get('/api/chat', chat);
app.post('/api/chat', chat);

app.get('/api/history', (req, res) => {
  const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : '';
  res.json(getRecent(conversationId, 200));
});

app.get('/api/days', (_req, res) => res.json(getDayIndex()));

app.post('/api/seed', (req, res) => res.json(seedDemo(requestNow(req))));

app.get('/api/health', (req, res) => {
  const at = requestNow(req);
  res.json({ ok: true, now: at.toISOString(), today: dayKey(at), timezone: config.timezone, model: config.model });
});

if (config.seedOnStart && countMessages() === 0) seedDemo(now());

app.listen(config.port, () => console.log(`Recall is running at http://localhost:${config.port}`));
