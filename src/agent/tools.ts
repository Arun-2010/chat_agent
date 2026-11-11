// The agent's single tool, web_search: its schema for the model and the executor that fans queries out in parallel.
import type Anthropic from '@anthropic-ai/sdk';
import { subDays } from 'date-fns';
import { z } from 'zod';
import { dayKey } from '../memory/dates.js';
import { search } from '../search/tavily.js';
import type { SearchResult, Source } from '../types.js';

const FAN_OUT_TIMEOUT_MS = 12_000;
const RESULT_BUDGET_CHARS = 24_000; // ~6,000 tokens per tool result

export const webSearchTool: Anthropic.Tool = {
  name: 'web_search',
  description:
    "Search the web. Pass several focused queries at once when the question has several parts (e.g. one per product). Set days only on calls looking for news or announcements 'since' a date; never set it when looking up a current price or pricing page, because those pages have no publish date. Use two separate calls in the same turn when you need both.",
  input_schema: {
    type: 'object',
    properties: {
      queries: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
      days: { type: 'integer', description: 'Only return results published within the last N days. Omit for no limit.' },
      reason: { type: 'string', description: 'One line on what you are trying to find out.' },
    },
    required: ['queries'],
  },
};

const inputSchema = z.object({
  queries: z.array(z.string().trim().min(1)).min(1).max(8),
  days: z.number().int().positive().optional(),
  reason: z.string().optional(),
});

export function queriesOf(input: unknown): string[] {
  const parsed = inputSchema.safeParse(input);
  return parsed.success ? [...new Set(parsed.data.queries)] : [];
}

type Outcome = { query: string; results: SearchResult[]; error?: string };

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
  const startDate = parsed.data.days ? dayKey(subDays(now, parsed.data.days)) : undefined;
  const timeout = AbortSignal.timeout(FAN_OUT_TIMEOUT_MS);
  const fanOutSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const outcomes: Outcome[] = await Promise.all(
    [...new Set(parsed.data.queries)].map(async (query) => {
      try {
        const results = await search(query, { startDate, signal: fanOutSignal });
        return { query, results: [...results].sort((a, b) => b.score - a.score) };
      } catch (error) {
        const reason = timeout.aborted ? 'timed out' : error instanceof Error ? error.message : String(error);
        return { query, results: [], error: reason };
      }
    }),
  );
  fitToBudget(outcomes);

  const filter = startDate ? `since ${startDate}` : 'none';
  const text = outcomes
    .map((o) => {
      const heading = `### Query: "${o.query}"  (filter: ${filter})`;
      if (o.error) return `${heading}\nSEARCH FAILED: ${o.error}. Nothing is known from this query.`;
      if (!o.results.length) return `${heading}\nNo results${startDate ? ' in that window' : ''}.`;
      return `${heading}\n${o.results.map((r, i) => `${i + 1}. ${r.title} — ${r.url} — published ${r.publishedDate ?? 'unknown'}\n   ${r.content}`).join('\n')}`;
    })
    .join('\n\n');
  const sources = outcomes.flatMap((o) => o.results.map(({ title, url, publishedDate }) => ({ title, url, publishedDate })));
  return { text, sources };
}
