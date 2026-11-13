# Recall

A chat agent with one tool, web search, and a timestamped memory of what you asked and when.

It is built for questions like these:

- "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"
- "What did I ask you on 3 November? Is your answer still correct today?"
- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"

Each one refers to a past day, so the agent has to remember exactly what was said, work out which day you mean, and then check the live web against its own earlier answer.

The reasoning behind the design is in [DESIGN.md](DESIGN.md).

## Quick start

Needs Node 22.22 or newer (24 LTS is fine).

```bash
cp .env.example .env     # then fill in the two keys
npm install
npm run dev              # http://localhost:3000
```

Two keys go in `.env`, and both have a free tier:

| Variable | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | A [Rapid Router](https://rapidrouter.ai/dashboard/keys) key. The default model, `google/gemma-4-31b-it:free`, is free (50 requests a day). |
| `TAVILY_API_KEY` | [Tavily](https://tavily.com) |

The variable is called `ANTHROPIC_API_KEY` because the code speaks the Anthropic Messages API. Any provider with that API works by changing `ANTHROPIC_BASE_URL` and the model names; `.env.example` shows the settings for Claude.

## Trying the memory prompts

Memory starts empty, so a fresh install has nothing to recall.

1. Click **Load demo history**. This loads three sample days from `data/seed.json`.
2. Set **Pretend today is** to **12 Nov 2026**. The sample is written for that date: "Monday" is 9 Nov (the CRM shortlist) and "3 November" is the Postgres day.
3. Click one of the starter cards under the chat.

Without the fake date, the sample is shifted by whole weeks so the weekday prompts ("on Monday", "last Tuesday") still line up; the absolute-date prompt ("3 November") needs the fake date.

Prices in the sample are illustrative. Checking them against the live web is the agent's job.

## How it works

```
browser ──SSE──▶ server ──▶ agent loop
                              1. build memory context in code (no model call)
                                   date phrases ─▶ concrete days ─▶ verbatim messages from SQLite
                                   topic keywords ─▶ FTS5 matches
                              2. model streams an answer, or asks to search
                              3. all searches run in parallel (Tavily)
                              4. results go back to the model, at most 2 rounds
                              5. final answer is saved verbatim with a timestamp
```

- **Memory is injected, not a tool.** The relevant past messages are placed in the prompt before the model runs, so the agent keeps exactly one tool.
- **Dates are resolved in code.** `src/memory/dates.ts` turns "last Tuesday", "3 November", "two weeks ago" and similar into exact days, with unit tests.
- **Change detection is a comparison.** Current prices are looked up without a date filter and compared against the stored answer; news and launches are searched with a date filter.
- **No framework.** The loop is in `src/agent/loop.ts` and is short enough to read in one sitting.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Starts the server with reload on change |
| `npm test` | Unit tests: date resolution, topic search, tool-argument parsing |
| `npm run eval` | Replays the example prompts against the demo history and prints searches, timings and pass/fail. Uses about 13 model requests. |
| `npm run typecheck` | TypeScript check |

## Project layout

```
src/
  server.ts          Express routes and SSE streaming
  config.ts          .env loading and validation
  clock.ts           "now", with FAKE_NOW and per-request override
  agent/
    loop.ts          the agent loop and background fact extraction
    prompt.ts        system prompt
    tools.ts         the web_search tool and its parallel executor
  memory/
    db.ts            SQLite schema (messages, FTS5 index, facts)
    store.ts         reads and writes, demo seeding
    dates.ts         date-phrase resolution and timezone helpers
    context.ts       builds the memory block for the prompt
  search/            Tavily client, cache, readable-page fallback
  eval.ts            replay script
public/index.html    the chat UI
data/seed.json       demo history
```

## Configuration

All settings live in `.env`; see [.env.example](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `https://rapidrouter.ai/api` | Model endpoint. Empty means api.anthropic.com. |
| `LLM_MODEL` | `google/gemma-4-31b-it:free` | Model that answers |
| `FACT_MODEL` | `google/gemma-4-31b-it:free` | Model for background fact extraction |
| `TIMEZONE` | `Asia/Kolkata` | Timezone used to decide which day a message belongs to |
| `FAKE_NOW` | empty | Overrides "today", e.g. `2026-11-12T10:00:00` |
| `SEED_ON_START` | `false` | Load the demo history when the database is empty |
| `PORT` | `3000` | Server port |
| `DB_PATH` | `./data/recall.db` | SQLite file |

## Known limits

- **Speed on the free model.** A greeting takes about 4 seconds; an answer that needs search takes about a minute, nearly all of it model time. A faster model is a settings change.
- **Free quota.** A search question uses about 3 model requests, so the free tier covers roughly 15 questions a day.
- **Claude is untested.** The code targets the Anthropic Messages API, but it has only been run against Gemma through Rapid Router.
- **Single user.** Memory is shared across all conversations on the server; there are no accounts.
