// The agent's single tool, web_search: its schema for the model and the executor that fans queries out in parallel.
import type Anthropic from '@anthropic-ai/sdk';
import { subDays } from 'date-fns';
import { z } from 'zod';
import { dayKey } from '../memory/dates.js';
import { search } from '../search/tavily.js';
import type { SearchResult, Source } from '../types.js';

const FAN_OUT_TIMEOUT_MS = 12_000;
const RESULT_BUDGET_CHARS = 24_000; // ~6,000 tokens per tool result

// One call carries both kinds of lookup, so "what is it now" and "what was announced since" run in the same
// parallel fan-out without relying on the model to issue two tool calls in a turn.
export const webSearchTool: Anthropic.Tool = {
  name: 'web_search',
  description:
    'Search the web. Pass several focused queries at once when the question has several parts (e.g. one per product). Put lookups of the current state (prices, pricing pages, versions) in queries; they are never date filtered. Put searches for news, launches and announcements since a date in news_queries and set days; only those are limited to the last N days.',
  input_schema: {
    type: 'object',
    properties: {
      queries: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Current-state lookups. No date filter.' },
      news_queries: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'News and announcement searches, limited to the last `days` days.' },
      days: { type: 'integer', description: 'How many days back news_queries should look. Omit for no limit.' },
      reason: { type: 'string', description: 'One line on what you are trying to find out.' },
    },
  },
};

const queryList = z.array(z.string().trim().min(1)).max(8).optional().default([]);
const inputSchema = z
  .object({ queries: queryList, news_queries: queryList, days: z.number().int().positive().optional(), reason: z.string().optional() })
  .refine((v) => v.queries.length + v.news_queries.length > 0, { message: 'Provide at least one entry in queries or news_queries' });

/** Parses tool arguments, tolerating several JSON objects written back to back (one per intended call). */
export function parseToolInputs(json: string): unknown[] {
  try {
    return [JSON.parse(json || '{}')];
  } catch {
    // fall through to splitting on top-level braces
  }
  const objects: unknown[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{' && depth++ === 0) start = i;
    else if (ch === '}' && --depth === 0) {
      try {
        objects.push(JSON.parse(json.slice(start, i + 1)));
      } catch {
        // skip a fragment that is not valid JSON
      }
    }
  }
  return objects.length ? objects : [{}];
}

export function queriesOf(input: unknown): string[] {
  const parsed = inputSchema.safeParse(input);
  return parsed.success ? [...new Set([...parsed.data.queries, ...parsed.data.news_queries])] : [];
}

type Outcome = { query: string; startDate?: string; results: SearchResult[]; error?: string };

// Keeps every query represented: take each query's best result, then each one's second best, until the budget is spent.
function fitToBudget(outcomes: Outcome[]): void {
  let budget = RESULT_BUDGET_CHARS;
  const kept = outcomes.map(() => 0);
  for (let rank = 0; rank < 5; rank++) {
    outcomes.forEach((o, i) => {
      const result = o.results[rank];
      if (!result || kept[i] !== rank || result.content.length > budget) return;
      budget -= result.content.length;
      kept[i] = rank + 1;
    });
  }
  outcomes.forEach((o, i) => { o.results = o.results.slice(0, kept[i]); });
}

export async function executeWebSearch(input: unknown, now: Date, signal?: AbortSignal): Promise<{ text: string; sources: Source[] }> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { text: `Invalid web_search arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`, sources: [] };

  // The model thinks in "last N days"; the filter is sent as an absolute date computed from the request's clock.
  const newsStart = parsed.data.days ? dayKey(subDays(now, parsed.data.days)) : undefined;
  const jobs = new Map<string, { query: string; startDate?: string }>();
  for (const query of parsed.data.queries) jobs.set(`${query}|`, { query });
  for (const query of parsed.data.news_queries) jobs.set(`${query}|${newsStart ?? ''}`, { query, startDate: newsStart });

  const timeout = AbortSignal.timeout(FAN_OUT_TIMEOUT_MS);
  const fanOutSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const outcomes: Outcome[] = await Promise.all(
    [...jobs.values()].map(async (job) => {
      try {
        const results = await search(job.query, { startDate: job.startDate, signal: fanOutSignal });
        return { ...job, results: [...results].sort((a, b) => b.score - a.score) };
      } catch (error) {
        const reason = timeout.aborted ? 'timed out' : error instanceof Error ? error.message : String(error);
        return { ...job, results: [], error: reason };
      }
    }),
  );
  fitToBudget(outcomes);

  const text = outcomes
    .map((o) => {
      const heading = `### Query: "${o.query}"  (filter: ${o.startDate ? `since ${o.startDate}` : 'none'})`;
      if (o.error) return `${heading}\nSEARCH FAILED: ${o.error}. Nothing is known from this query.`;
      if (!o.results.length) return `${heading}\nNo results${o.startDate ? ' in that window' : ''}.`;
      return `${heading}\n${o.results.map((r, i) => `${i + 1}. ${r.title} — ${r.url} — published ${r.publishedDate ?? 'unknown'}\n   ${r.content}`).join('\n')}`;
    })
    .join('\n\n');
  const sources = outcomes.flatMap((o) => o.results.map(({ title, url, publishedDate }) => ({ title, url, publishedDate })));
  return { text, sources };
}
