// One Tavily search per call, cached, with an optional publish-date floor and a readable-text fallback for thin pages.
import { config } from '../config.js';
import { TtlCache } from './cache.js';
import { fetchReadable } from './extract.js';
import type { SearchResult } from '../types.js';

const MAX_CONTENT_CHARS = 1500;
const THIN_CONTENT_CHARS = 500;
const cache = new TtlCache<SearchResult[]>(10 * 60 * 1000);

interface TavilyResult {
  title?: string;
  url: string;
  content?: string;
  raw_content?: string | null;
  published_date?: string | null;
  score?: number;
}

// The snippet is the query-relevant passage, so it goes first; page text fills the remaining room.
async function toResult(r: TavilyResult): Promise<SearchResult> {
  let page = r.raw_content ?? '';
  if (page.length < THIN_CONTENT_CHARS && /^https?:\/\//.test(r.url)) page = (await fetchReadable(r.url)) ?? page;
  const snippet = r.content ?? '';
  const content = `${snippet}\n${page.replace(/\s+/g, ' ')}`.trim().slice(0, MAX_CONTENT_CHARS);
  return { title: r.title || r.url, url: r.url, publishedDate: r.published_date ?? null, content, score: r.score ?? 0 };
}

/** `startDate` (YYYY-MM-DD) keeps only results published on or after that day; undated pages are still returned. */
export async function search(query: string, opts: { startDate?: string; signal?: AbortSignal } = {}): Promise<SearchResult[]> {
  const key = `${query}|${opts.startDate ?? ''}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    signal: opts.signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.tavilyApiKey}` },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      max_results: 5,
      include_raw_content: true,
      include_answer: false,
      include_published_date: true,
      ...(opts.startDate ? { start_date: opts.startDate } : {}),
    }),
  });
  if (!response.ok) throw new Error(`Tavily ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = (await response.json()) as { results?: TavilyResult[] };
  const results = await Promise.all((body.results ?? []).map(toResult));
  cache.set(key, results);
  return results;
}
