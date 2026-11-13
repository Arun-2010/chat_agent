# Recall

A chat agent with one tool, web search, and a timestamped memory of what you asked and when.
Design notes are in [DESIGN.md](DESIGN.md).

## Run

```
cp .env.example .env    # then set ANTHROPIC_API_KEY and TAVILY_API_KEY (see .env.example for using a gateway such as Rapid Router)
npm install
npm run dev             # http://localhost:3000
```

Needs Node 22.22 or newer (24 LTS is fine). `npm test` runs the date-resolution tests; `npm run eval` replays the example prompts.

## Trying the memory prompts

Memory starts empty. Click **Load demo history** (or set `SEED_ON_START=true`) to load three sample days from `data/seed.json`.
The sample is written for a "today" of Thursday 12 November 2026: set **Pretend today is** to 2026-11-12 in the UI,
or `FAKE_NOW=2026-11-12T10:00:00`, and "Monday" is 9 Nov (CRM shortlist) and "3 November" is the Postgres day.
On any other date the history is shifted by whole weeks, so the weekday prompts still work; "3 November" needs the fake date.
Prices in the sample are illustrative; checking them against the live web is the agent's job.
