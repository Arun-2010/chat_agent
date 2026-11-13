# Recall: design

## How it works

```
browser ──GET /api/chat (SSE)──▶ server.ts ──▶ agent/loop.ts
                                                 │ 1. memory/context.ts builds the memory block (no LLM involved)
                                                 │      dates.ts   "last Tuesday" ─▶ concrete day ranges
                                                 │      store.ts   SQLite: messages by day + FTS5 topic search + facts
                                                 │ 2. Claude streams; tokens go straight to the browser
                                                 │ 3. tool_use ─▶ agent/tools.ts ─▶ N Tavily queries in parallel
                                                 │ 4. results back to Claude; at most 2 search rounds
                                                 ▼ 5. final answer saved verbatim with a timestamp
```

- **Memory is injected, not queried.** Before each model call, code resolves any date phrase in the message, pulls every message from those days verbatim, adds FTS5 topic matches (each hit with its question/answer partner), a 30-day table of contents, known user facts and today's date. The model starts with what it needs, so recall costs zero round trips.
- **One tool, `web_search`.** One call carries two lists: `queries` (current state, never date filtered) and `news_queries` (limited to the last `days` days). All of them run with `Promise.all` under a 12 s cap; whatever finished is used.
- **Change detection is a comparison.** For "has pricing changed since Monday" the model looks up current prices and compares them against its stored old answer, and separately searches dated news and launches. A date filter on a pricing page would hide it, because pricing pages have no publish date.
- **Any model behind the Anthropic Messages API.** `ANTHROPIC_BASE_URL` points the same code at Anthropic or a gateway. It was tested on a free open model (Gemma 4 through Rapid Router), so the loop reads raw stream events, parses tool arguments itself and strips inline `<thought>` reasoning rather than assuming Claude's behaviour.
- **Streaming** over Server-Sent Events: tokens, a "Searching: …" status, sources, done.

## Why this way

- **The dataset is a memory problem.** All three example prompts refer to a past day. Web search alone cannot answer "what did I ask on 3 November", so timestamped verbatim storage and retrieval by date is the core of the design.
- **Dates are resolved in code.** Models are unreliable at calendar arithmetic. `resolveDateReferences` is a pure function with unit tests, and the model is told the resolved dates.
- **Verbatim storage.** "Is your answer still correct?" can only be checked against the exact figures given at the time. Only the final round of text is stored, so pre-search chatter never pollutes it.
- **No framework.** The loop is about 50 lines. A framework would hide the part being judged and add latency I cannot account for.
- **SQLite + FTS5.** One file, no services, and exact-term search suits product names like "Postgres" or "HubSpot".
- **Injectable clock.** `FAKE_NOW`, `?now=` or `x-fake-now` set "today" for a request, so a multi-day story can be tested in minutes. The search date filter is computed from the same clock.
- **Honesty is in the prompt and the tool output.** Failed searches are reported to the model as failures; the prompt separates "no change" from "could not verify" and forbids inventing a past conversation.

## Considered and rejected

- **LangChain / LangGraph / agent SDKs:** more moving parts than the problem has.
- **Vector DB and embeddings:** an extra service and an embedding call per message, for recall that dates plus keywords already cover at this scale.
- **Summarised memory:** summaries lose the exact prices that re-verification depends on.
- **Memory as a second tool:** breaks "one tool" and costs a model round trip on every memory question.
- **Letting the model pick dates:** non-deterministic and untestable.
- **A date filter on pricing lookups:** pricing pages have no publish date, so the filter hides the very page needed.
- **Two tool calls per turn (one filtered, one not):** weaker models and gateways mangle parallel tool calls, so both lists travel in one call.
- **One meaning for "last Tuesday":** people use it both ways, so both candidate days are checked and the one with messages wins.
- **Auto-seeding demo history:** a reviewer should not find conversations they never had; seeding is opt-in.
- **Multi-agent planner/executor, React frontend:** latency and code with no gain in answer quality.

## With another week

- Grow `npm run eval` into a scored harness over the full dataset, with an LLM judge for correctness and latency percentiles.
- Change detection that stores a snapshot of each cited pricing page and diffs it later, instead of comparing against prose.
- Source ranking that prefers official pricing pages and changelogs over blogs.
- Per-user accounts and memory namespaces.
- Latency: on the free model a search answer takes about a minute, almost all of it model time. A faster model, or a small model for query planning and a larger one for synthesis, is the first fix.
- Semantic search as a fallback when keyword search misses a paraphrase.
- Proactive nudges: "since you asked on Monday, Pipedrive changed its pricing".
