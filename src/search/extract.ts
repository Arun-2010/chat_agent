// Fetches a page and returns its readable article text. Used when the search API returns little page content.
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

export async function fetchReadable(url: string, timeoutMs = 4000): Promise<string | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; RecallBot/1.0)', accept: 'text/html' },
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('html')) return null;
    const dom = new JSDOM(await response.text(), { url });
    const text = new Readability(dom.window.document).parse()?.textContent ?? '';
    return text.replace(/\s+/g, ' ').trim() || null;
  } catch {
    return null; // extraction is best effort; the search snippet is still used
  }
}
