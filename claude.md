# CLAUDE.md — Build spec for "Recall": a time-aware chat agent with web search

You are building a complete, submission-ready project from this file. Follow it top to bottom.
Do not ask clarifying questions; every decision is specified here. Where something is not
specified, choose the simplest option that keeps the code readable and explainable.

---

## 0. The challenge being solved

> Build a chat agent we can talk to. It has one tool: web search. Make it as good as the best
> ones on the internet today. Judged on architecture: answers fast, gets things right, good to talk to.

Example test prompts (the hidden dataset looks like these):

1. "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"
2. "What did I ask you on 3 November? Is your answer still correct today?"
3. "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"

**What these actually test:**
- Persistent, **timestamped memory** across sessions, retrievable by **date** and **topic**.
- Storing the **verbatim** old answer so it can be re-verified later.
- **Relative date resolution** ("Monday", "last Tuesday", "3 November") done deterministically in code.
- Always knowing **today's date**.
- **Parallel** web searches. Change detection works by **comparing the current state against the stored old answer**; a **date/freshness filter** ("since Monday") is used only for news/launch queries, because pricing pages carry no publish date.
- Honest answers: "no change found" rather than invented changes; cite sources with dates.
- Low latency: streaming, parallel tool execution, bounded search rounds.

Hard rules from the challenge:
- JavaScript or TypeScript on Node. Must run with `npm install` then `npm run dev`.
- Every API key listed in `.env.example`.
- Public GitHub repo with a one-page `DESIGN.md`.

---

## 1. Non-negotiable design decisions

| Decision | Choice | Reason (put these reasons in DESIGN.md) |
|---|---|---|
| Framework | **None.** No LangChain, LangGraph, Vercel AI SDK agents. | The agent loop is ~80 lines; a framework hides what the reviewers are grading. |
| Language | TypeScript, strict mode, ESM | Required by rules; strict typing documents intent. |
| Runtime script | `tsx watch src/server.ts` for `npm run dev` | Zero build step. |
| HTTP server | Express 4 + Server-Sent Events | Smallest thing that streams. |
| LLM | Anthropic SDK (`@anthropic-ai/sdk`), model from env `LLM_MODEL` default `claude-sonnet-5-5`, optional `ANTHROPIC_BASE_URL` for any gateway that speaks the Anthropic Messages API (tested with Rapid Router and the free `google/gemma-4-31b-it:free`) | Native tool calling + streaming; not tied to one provider. The loop reads raw stream events, parses tool arguments itself and strips inline `<thought>` blocks, because open models behind gateways do not behave exactly like Claude. |
| Web search | Tavily (`https://api.tavily.com/search`) via `fetch`, no SDK | Returns page content, supports a date filter (`start_date`, see section 6), `include_raw_content`. |
| Page extraction | `@mozilla/readability` + `jsdom` | Clean article text when Tavily raw content is thin. |
| Memory store | SQLite via `better-sqlite3`, FTS5 virtual table | One file, zero setup, timestamps + keyword search. No vector DB. |
| Date handling | `date-fns` | Resolve relative dates in code, never trust the model with date math. |
| Validation | `zod` | Validate tool-call arguments from the model. |
| UI | Single static `public/index.html`, vanilla JS, streams via `EventSource` (closed explicitly on `done`/`error`, see section 8) | Rules say the screen does not matter. |
| Memory access | Injected into the system prompt by code, **not** a second tool | Respects "one tool: web search"; saves a round trip. |
| Clock | Injectable `now` (env `FAKE_NOW` or header `x-fake-now`) | Lets reviewers simulate "3 November" then "today" within minutes. |

Dependencies (exact list, nothing else):
```
dependencies: @anthropic-ai/sdk, express, better-sqlite3, date-fns, zod, @mozilla/readability, jsdom, dotenv
devDependencies: typescript, tsx, @types/node, @types/express, @types/better-sqlite3, @types/jsdom
```

---

## 2. Repository layout (create exactly this)

```
.
├── CLAUDE.md                 ← this file
├── DESIGN.md                 ← one page, written last (section 10)
├── README.md                 ← run instructions, 20 lines max
├── .env.example
├── .gitignore                ← node_modules, .env, data/*.db
├── package.json
├── tsconfig.json
├── public/
│   └── index.html            ← chat UI
├── data/
│   ├── .gitkeep
│   └── seed.json             ← sample multi-day transcript (section 8)
└── src/
    ├── server.ts             ← Express app, routes, SSE
    ├── config.ts             ← env loading + validation
    ├── clock.ts              ← now() with FAKE_NOW / header override
    ├── agent/
    │   ├── loop.ts           ← the agent loop (section 5)
    │   ├── prompt.ts         ← system prompt builder
    │   └── tools.ts          ← web_search tool schema + executor
    ├── memory/
    │   ├── db.ts             ← SQLite schema + connection
    │   ├── store.ts          ← saveMessage, getByDateRange, searchTopic, getDayIndex, facts
    │   ├── dates.ts          ← resolveDateReferences(text, now) → Date ranges
    │   └── context.ts        ← buildMemoryContext(userMessage, now) → string
    ├── search/
    │   ├── tavily.ts         ← search(query, opts) with cache
    │   ├── extract.ts        ← fetchReadable(url) via Readability
    │   └── cache.ts          ← in-memory Map keyed by query+start date, TTL 10 min
    ├── eval.ts               ← replays the three example prompts against the seed (`npm run eval`)
    └── types.ts
```

---

## 3. Configuration

`.env.example` (commit this; `.env` is gitignored):
```
# Required
ANTHROPIC_API_KEY=
TAVILY_API_KEY=

# Optional
ANTHROPIC_BASE_URL=           # empty = api.anthropic.com; Rapid Router = https://rapidrouter.ai/api
LLM_MODEL=claude-sonnet-5-5   # via Rapid Router: anthropic/claude-sonnet-5-5 or google/gemma-4-31b-it:free
FACT_MODEL=claude-haiku-4-5   # small model for background fact extraction
SEED_ON_START=false           # true = load the demo history from data/seed.json when the DB is empty
PORT=3000
TIMEZONE=Asia/Kolkata
FAKE_NOW=            # ISO date e.g. 2026-11-03T10:00:00 — overrides "today" for testing
DB_PATH=./data/recall.db
```

`src/config.ts`: load with `dotenv`, validate with `zod`, throw a readable error listing missing keys at startup.

---

## 4. Memory layer

### 4.1 Schema (`src/memory/db.ts`)
```sql
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,           -- ISO 8601 UTC
  day TEXT NOT NULL                    -- YYYY-MM-DD in TIMEZONE, for fast date lookup
);
CREATE INDEX IF NOT EXISTS idx_messages_day ON messages(day);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content=messages, content_rowid=id);
-- triggers to keep FTS in sync on insert/delete

CREATE TABLE IF NOT EXISTS facts (
  key TEXT PRIMARY KEY,                -- e.g. "team_size"
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 4.2 Store API (`src/memory/store.ts`)
- `saveMessage(conversationId, role, content, now)` — computes `day` in `TIMEZONE`.
- `getRecent(conversationId, limit=20)` — current conversation window.
- `getByDateRange(from: Date, to: Date)` — all messages, ordered, any conversation.
- `searchTopic(query, limit=10)` — FTS5 `MATCH`, returns messages with `day`. Build the match expression in code: strip punctuation, drop stopwords, wrap each remaining term in double quotes and join with ` OR ` (FTS5 treats bare spaces as AND and throws on raw punctuation). Order by `bm25`. Return `[]` when no terms remain.
- `getDayIndex(limitDays=30)` — one row per day: `day`, message count, first 120 chars of each user message joined. Used as a compact table of contents in the prompt.
- `upsertFact(key, value, now)`, `getFacts()`.

### 4.3 Date resolution (`src/memory/dates.ts`)
Pure function: `resolveDateReferences(text: string, now: Date): { label: string; from: Date; to: Date }[]`

Must handle, case-insensitive, using `date-fns`:
- `today`, `yesterday`, `day before yesterday`
- `on Monday` / `Monday` … `Sunday` → the most recent such weekday strictly before today
- `last Monday` … → ambiguous in everyday English, so return **both** candidates as separate ranges: the previous week's weekday and the most recent such weekday strictly before today (if today is Wednesday, "last Tuesday" = 8 days ago and 1 day ago). When both are the same day, return one range. The context builder shows whichever days actually have messages; document this rule in a comment. Bare "Tuesday" stays single: 1 day ago.
- `last week`, `this week`, `earlier this week`
- `3 November`, `November 3`, `3rd November`, `Nov 3`, `3/11` (day/month), `2026-11-03` → that calendar day; if the month/day is in the future relative to `now`, assume previous year
- `N days ago`, `a week ago`, `two weeks ago`
Return an empty array when nothing matches. Each range is a full day (00:00–23:59:59 in TIMEZONE) unless the phrase is multi-day.
Write unit tests for this function in `src/memory/dates.test.ts` using `node:test` (run with `npm test`).

### 4.4 Context builder (`src/memory/context.ts`)
`buildMemoryContext(userMessage, conversationId, now)` returns a string block for the system prompt:

```
## Today
Thursday, 12 November 2026, 14:05 (Asia/Kolkata). ISO: 2026-11-12.

## Known facts about the user
- team_size: 20-person sales team (noted 2026-11-09)

## Past conversation days (most recent first)
- 2026-11-09 (Mon): "we shortlisted 5 CRM tools…" | "which has best HubSpot import?"
- 2026-11-03 (Tue): "Postgres hosting options for a side project"
…

## Relevant past messages
### 2026-11-09 (Mon) — matched "Monday"
[user 10:12] On Monday we shortlisted…
[assistant 10:12] The five tools: HubSpot Starter ($20/seat)…   ← VERBATIM, untruncated
### Topic matches for "CRM pricing"
…
```

Rules:
- Always include Today and Facts.
- Include Day Index (last 30 days) always — it is small.
- If `resolveDateReferences` matches → include **full verbatim** messages from those days (cap 6,000 tokens; if over, keep assistant messages whole and truncate user ones). When a phrase produced several candidate days ("last Tuesday"), show only the candidates that have messages; if none do, say so naming every candidate date.
- Also run `searchTopic` using the user message with stopwords removed; include up to 10 hits not already shown.
- If nothing relevant and no date matched, the section says "No earlier conversations matched."

### 4.5 Fact extraction
After each assistant reply, run one cheap non-streaming LLM call (model from env `FACT_MODEL`, max_tokens 200) with the last user+assistant turn asking for JSON `{ "facts": [{"key":"...","value":"..."}] }` of durable facts about the user (team size, stack, company, preferences). Upsert them. Skip if the user message is under 40 chars. Fire-and-forget; never block the response.

---

## 5. Agent loop (`src/agent/loop.ts`)

```ts
export async function* runAgent(input: { conversationId: string; userMessage: string; now: Date }): AsyncGenerator<AgentEvent>
```
`AgentEvent` = `{ type: 'token', text }` | `{ type: 'status', text }` | `{ type: 'sources', items: Source[] }` | `{ type: 'done' }` | `{ type: 'error', message }`.

Steps:
1. `messages = getRecent(conversationId, 20)` mapped to Anthropic format + the new user message. Load history **before** saving so the new message is not included twice.
2. `system = buildSystemPrompt(buildMemoryContext(...))`. Build the context before saving too, so the current message never appears as its own "past conversation".
3. `saveMessage(user)`.
4. Loop `round = 0..MAX_ROUNDS (2)`:
   a. Stream `anthropic.messages.stream({ model, system, messages, tools: [webSearchTool], max_tokens: 2000 })`.
   b. Yield `token` events for text deltas as they arrive.
   c. On completion, if `stop_reason !== 'tool_use'` → break.
   d. Collect all `tool_use` blocks. Yield `status: "Searching: q1 · q2 · q3"`.
   e. Execute **all** tool calls with `Promise.all`; each `web_search` call itself may carry multiple queries (see 6) which are also run in parallel.
   f. Append assistant turn + `tool_result` blocks; continue.
5. If the loop exits because `MAX_ROUNDS` hit while still asking for tools, do one final call **without tools** so the user gets an answer from what was gathered.
6. Collect every source used; yield `sources`.
7. `saveMessage(assistant, finalText)` where `finalText` is the text of the **last** round only. Text emitted before a tool call ("Let me check…") is streamed to the UI but not stored, so the saved answer stays clean for later re-verification. Kick off fact extraction; yield `done`.

Latency budget: first token < 1.5 s when no search needed; for a search question, the "Searching: …" status within 2 s and the answer starting to stream within ~10 s. Enforce a 12 s timeout per search fan-out; on timeout return whatever finished.

---

## 6. Web search tool (`src/agent/tools.ts`, `src/search/*`)

Tool schema given to the model (single tool, as the challenge requires):
```json
{
  "name": "web_search",
  "description": "Search the web. Pass several focused queries at once when the question has several parts (e.g. one per product). Put lookups of the current state (prices, pricing pages, versions) in queries; they are never date filtered. Put searches for news, launches and announcements since a date in news_queries and set days; only those are limited to the last N days.",
  "input_schema": {
    "type": "object",
    "properties": {
      "queries": { "type": "array", "items": { "type": "string" }, "maxItems": 8 },
      "news_queries": { "type": "array", "items": { "type": "string" }, "maxItems": 8 },
      "days": { "type": "integer", "description": "How many days back news_queries should look. Omit for no limit." },
      "reason": { "type": "string", "description": "One line on what you are trying to find out." }
    },
    "required": []
  }
}
```

Executor:
- Validate with `zod`. Dedupe queries. The executor receives the request's `now` (so `FAKE_NOW` is respected).
- Convert `days` to an absolute date in code: `start_date = format(subDays(now, days), 'yyyy-MM-dd')`, so the filter follows the request's clock rather than the real one.
- For each query (parallel): `POST https://api.tavily.com/search` with `Authorization: Bearer <key>` and `{ query, search_depth: "basic", max_results: 5, start_date, include_raw_content: true, include_answer: false, include_published_date: true }` (omit `start_date` when `days` is absent). `basic` depth keeps latency inside the budget.
- Checked against the Tavily API reference: `start_date` (YYYY-MM-DD) works for general search and leaves undated pages in by default; `published_date` is only returned when `include_published_date` is true. If a filtered query returns zero results, report "no results in that window" to the model rather than retrying unfiltered.
- Cache key `query|start_date`, TTL 10 min, in-memory `Map`.
- For each result keep `{ title, url, published_date, content }`. If `raw_content` is under 500 chars and the URL is http(s), call `fetchReadable(url)` with a 4 s timeout; ignore failures.
- Truncate each result's content to 1,500 chars; cap total tool_result at ~6,000 tokens by dropping the lowest-scored results.
- Return to the model as plain text:
  ```
  ### Query: "<q>"  (filter: since <start_date>, or "none")
  1. <title> — <url> — published <date or "unknown">
     <content>
  ```
- Also return the structured `Source[]` list up the stack for the UI.

---

## 7. System prompt (`src/agent/prompt.ts`)

Compose: persona + rules + memory context. Rules the prompt must contain, verbatim in spirit:

- You are Recall, a concise, friendly research assistant with one tool: `web_search`. Today's date is in the context; trust it over your training data.
- **When to search:** anything about prices, releases, news, versions, "has X changed", or anything after your training cutoff. Do not search for greetings, opinions, or things fully answered by memory.
- **Fan out:** if the question covers several items (e.g. 5 CRM tools), issue one query per item in a single `web_search` call.
- **Detecting change "since" a date:** make **one** `web_search` call that fills both lists (parallel tool calls proved unreliable on open models). (a) `queries`: one per item for its **current** price/pricing page; compare what you find against the figures in your stored earlier answer — that comparison is the evidence of a price change. (b) `news_queries` with `days` equal to the days since the referenced date: one per item for news, launches and announcements. Never put pricing lookups in `news_queries`.
- **Memory:** the context shows past conversations with dates. When the user refers to an earlier day, quote what they asked and what you answered before checking if it still holds. If memory has nothing for that date, say so plainly and ask what they remember — never invent a past conversation.
- **Verification answers** ("is your answer still correct?"): structure as *What you asked* → *What I said then* → *What I find now* → *Verdict* (Still correct / Changed: … / Could not verify).
- **Honesty:** if search finds no evidence of a change, say "I found no announced change" and cite what you checked. Never fabricate prices or dates. Distinguish "no change" from "could not find".
- **Citations:** inline markdown links `[Source](url)` with the published date where known; end with "As of <today>".
- **Style:** lead with the answer, then detail. Short paragraphs or a compact table for comparisons. No filler, no "Great question".
- Use the user's known facts (team size etc.) to tailor recommendations without re-asking.

---

## 8. HTTP API and UI

`src/server.ts`:
- `GET /` → `public/index.html`
- `GET /api/chat?conversationId=&message=` → SSE stream of `AgentEvent`s (use GET so `EventSource` works; also accept `POST /api/chat` with JSON for curl).
- `GET /api/history?conversationId=` → messages for the UI to render on load.
- `GET /api/days` → `getDayIndex()`.
- `POST /api/seed` → load `data/seed.json` into the DB (idempotent; skip if already seeded). Seeding is **opt-in**: it runs at startup only when the DB is empty and `SEED_ON_START === 'true'`, so a reviewer's memory never contains conversations they did not have unless they ask for the demo. Seeded rows use `conversation_id = 'demo-seed'`.
- Seed dates are written relative to a reference "today" of `2026-11-12`. At load time, shift every timestamp by a **whole number of weeks** so the reference today lands in the same week as the effective `now` (shift = 0 when `now` is in the week of 12 Nov 2026). Whole weeks keep weekdays intact, so "On Monday…" and "Last Tuesday…" work on any day the reviewer runs it. The response of `/api/seed` lists the days the history landed on.
- `GET /api/health` → `{ ok, now, model }`.
- Read `x-fake-now` header or `?now=` query → passed to `clock.now()` for that request only.

`public/index.html` (keep under 250 lines):
- Message list, input box, Send. Streams tokens. Call `es.close()` on the `done` and `error` events and in `onerror`: `EventSource` reconnects automatically when the server ends the stream, which would re-send the message and re-run the agent. The server also aborts the agent run when the client disconnects. Shows a grey "Searching: …" status line while tools run. Renders sources as a collapsible list under each answer. Renders basic markdown (bold, links, lists, tables) with a tiny hand-written renderer or `marked` loaded from a CDN `<script>` — CDN is acceptable here.
- A small "Pretend today is: [date input]" control in the header that sets `x-fake-now`/`?now=` on requests, with a note "for testing memory". Shows the effective date.
- A "Load demo history" button that calls `POST /api/seed` and shows which days were loaded, labelled clearly as sample data.
- `conversationId` = `localStorage` UUID.

`data/seed.json` — an array of `{ role, content, created_at }` forming a believable history that makes the three example prompts answerable. Include at minimum:
- `2026-11-03T10:14:00+05:30` user asks about Postgres hosting for a small app; assistant answers with 3–4 providers and specific prices.
- `2026-11-09T09:40:00+05:30` user says "we shortlisted 5 CRM tools for our 20-person sales team: HubSpot, Pipedrive, Zoho CRM, Freshsales, Close" and asks for a comparison; assistant gives a table with pricing per seat.
- One unrelated day (e.g. `2026-11-06`) so the day index is realistic.
Dates must be relative to a chosen "today" of `2026-11-12`; mention in README that setting `FAKE_NOW=2026-11-12T10:00:00` makes the seed line up exactly ("Monday" = 9 Nov, "3 November" = Postgres day), and that on any other date the weekday prompts still work thanks to the whole-week shift while the absolute-date prompt ("3 November") needs `FAKE_NOW`.

---

## 9. Quality bar and acceptance tests

Run through these manually before writing DESIGN.md; fix anything that fails.

1. `npm install && npm run dev` starts with only the two required keys set. Missing key → clear error naming it.
2. "hi" → responds in < 1.5 s with no search.
3. "What's the latest stable Node.js version?" → one search, answer with source + date, "As of …".
4. With seed + `FAKE_NOW=2026-11-12T10:00:00`: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?" → recalls the 5 tools from 9 Nov **without asking which tools**, issues 5 unfiltered pricing queries plus 5 news queries with `days≈3` in parallel, compares current prices against the stored 9 Nov table, answers per tool, says "no announced change" where appropriate.
5. "What did I ask you on 3 November? Is your answer still correct today?" → quotes the Postgres question and prior answer, re-searches providers, gives verdict per provider.
6. "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?" → candidates are 3 Nov and 10 Nov (today is Thu 12 Nov); only 3 Nov has messages, so it resolves to 3 Nov and states that date. Same behaviour as 5.
7. "What did I ask you on 1 October?" → "I have no record of a conversation on 1 October 2026" — no hallucination.
8. Ask something personal then later ask for a recommendation → uses the stored fact.
9. Kill network for Tavily → agent says it could not search and answers from knowledge with a caveat; no crash.
10. `npm test` passes (date resolution tests, including the two-candidate "last <weekday>" rule and the FTS match-expression builder).
11. Without seeding (default), "What did I ask you on 3 November?" → "no record", no demo data leaks in.
12. Sending one message in the UI produces exactly one user row and one assistant row in the DB (no `EventSource` re-run, no duplicate user message in the model input).
13. `npm run eval` (`src/eval.ts`): seeds a temp DB with `FAKE_NOW=2026-11-12T10:00:00`, runs the three example prompts through `runAgent`, and prints per prompt: resolved dates, search queries issued (with filters), time to first token, total time, and pass/fail on simple string checks (mentions all 5 CRM names; quotes the Postgres question; contains "As of"). Keep it under 80 lines.

---

## 10. DESIGN.md (write last, one page, these four headings exactly)

**How it works** — diagram in ASCII, the loop, memory context injection, parallel search, change detection by comparing current pages against the stored verbatim answer (date filter only for news), streaming.

**Why this way** — frameworks hide the loop; memory-by-date is the real problem in the dataset; dates resolved in code; one tool kept honest by injecting memory via context; SQLite+FTS over vectors; verbatim storage enables re-verification; clock override for testability.

**Considered and rejected** — LangChain/LangGraph; vector DB + embeddings; summarised memory; multi-agent planner/executor; letting the model pick dates; giving memory as a second tool; a React frontend; a date filter on pricing lookups (pricing pages have no publish date); guessing one meaning for "last Tuesday" (both candidates are checked instead); auto-seeding demo history (opt-in instead).

**With another week** — growing the small eval script into a scored harness over the full dataset; per-user auth and memory namespaces; source credibility weighting (official docs/pricing pages first); change-detection that diffs cached pricing pages; proactive "since you asked, X changed" nudges; smaller model for query planning, larger for synthesis; semantic search as a fallback when FTS misses.

---

## 11. Build order (do it in this order, commit after each)

1. `package.json`, `tsconfig.json`, `.env.example`, `.gitignore`, `src/config.ts`, `src/clock.ts`, `src/server.ts` with `/api/health`. Verify `npm run dev`.
2. `src/memory/db.ts`, `store.ts`. Verify by inserting and reading a row in a scratch script, then delete the script.
3. `src/memory/dates.ts` + tests. `npm test` green.
4. `src/search/cache.ts`, `tavily.ts`, `extract.ts`. Verify with one real query via a scratch script, then delete it.
5. `src/agent/tools.ts`, `prompt.ts`, `loop.ts`. Verify by curl `POST /api/chat`.
6. `src/memory/context.ts` + fact extraction. Verify acceptance tests 4–7 with seed.
7. `public/index.html`. Verify streaming + status + sources in the browser.
8. `data/seed.json`, `/api/seed` with the whole-week date shift, opt-in seed on start, `src/eval.ts` + `npm run eval`.
9. `README.md`, `DESIGN.md`.
10. Final pass: remove dead code, make sure every file has a 1–2 line header comment stating its purpose, run all acceptance tests again.

Code style: small pure functions, no classes unless holding state (DB, cache), explicit types, no `any`, comments only where the *why* is non-obvious. Keep total `src/` under ~900 lines — if it grows past that, you are over-engineering.
