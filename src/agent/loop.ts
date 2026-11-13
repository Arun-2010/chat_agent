// The agent loop: stream the model, run any web searches in parallel, feed results back, at most MAX_ROUNDS times.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { config } from '../config.js';
import { buildMemoryContext } from '../memory/context.js';
import { getRecent, saveMessage, upsertFact } from '../memory/store.js';
import { buildSystemPrompt } from './prompt.js';
import { executeWebSearch, parseToolInputs, queriesOf, webSearchTool } from './tools.js';
import type { AgentEvent, Source } from '../types.js';

const MAX_ROUNDS = 2;
const anthropic = new Anthropic({ apiKey: config.llmApiKey, baseURL: config.llmBaseUrl });

export interface AgentInput {
  conversationId: string;
  userMessage: string;
  now: Date;
  signal?: AbortSignal;
}

export async function* runAgent({ conversationId, userMessage, now, signal }: AgentInput): AsyncGenerator<AgentEvent> {
  try {
    // History and memory are read before the new message is saved, so it is neither sent twice
    // nor shown to the model as its own "past conversation".
    const messages: Anthropic.MessageParam[] = getRecent(conversationId, 20).map((m) => ({ role: m.role, content: m.content }));
    messages.push({ role: 'user', content: userMessage });
    const system = buildSystemPrompt(buildMemoryContext(userMessage, conversationId, now));
    saveMessage(conversationId, 'user', userMessage, now);

    const sources = new Map<string, Source>();
    let finalText = '';
    for (let round = 0; ; round++) {
      // After MAX_ROUNDS the tool stays declared (the history contains tool calls) but may not be used,
      // which forces an answer from what was gathered.
      const stream = await anthropic.messages.create(
        { model: config.model, max_tokens: 4000, stream: true, system, messages, tools: [webSearchTool], tool_choice: { type: round < MAX_ROUNDS ? 'auto' : 'none' } },
        { signal },
      );
      // Raw events are read directly and tool arguments are parsed here rather than by the SDK: some gateways
      // and open models send several tool calls as one block, or report end_turn alongside a tool call.
      let roundText = '';
      const visible = thoughtFilter();
      const rawCalls = new Map<number, { id: string; json: string }>();
      for await (const event of stream) {
        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          rawCalls.set(event.index, { id: event.content_block.id, json: '' });
        } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
          const call = rawCalls.get(event.index);
          if (call) call.json += event.delta.partial_json;
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          const text = visible(event.delta.text);
          roundText += text;
          if (text) yield { type: 'token', text };
        }
      }
      const tail = visible('', true);
      roundText += tail;
      if (tail) yield { type: 'token', text: tail };

      const toolUses = [...rawCalls.values()].flatMap((call) =>
        parseToolInputs(call.json).map((input, i) => ({ type: 'tool_use' as const, id: i ? `${call.id}_${i}` : call.id, name: webSearchTool.name, input })));
      if (!toolUses.length || round >= MAX_ROUNDS) {
        finalText = roundText || 'I could not put an answer together from the searches. Please try asking again.';
        if (!roundText) yield { type: 'token', text: finalText };
        break;
      }

      yield { type: 'status', text: `Searching: ${toolUses.flatMap((t) => queriesOf(t.input)).join(' · ')}` };
      const results = await Promise.all(toolUses.map((t) => executeWebSearch(t.input, now, signal)));
      for (const source of results.flatMap((r) => r.sources)) sources.set(source.url, source);
      messages.push({ role: 'assistant', content: [...(roundText ? [{ type: 'text' as const, text: roundText }] : []), ...toolUses] });
      messages.push({ role: 'user', content: toolUses.map((t, i) => ({ type: 'tool_result' as const, tool_use_id: t.id, content: results[i]!.text })) });
    }

    if (sources.size) yield { type: 'sources', items: [...sources.values()] };
    // Only the final round is stored: text written before a search is not part of the answer
    // and would pollute later "is that still correct?" checks.
    saveMessage(conversationId, 'assistant', finalText, new Date(now.getTime() + 1));
    void extractFacts(userMessage, finalText, now);
    yield { type: 'done' };
  } catch (error) {
    if (signal?.aborted) return;
    yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

// Some open models write their reasoning into the text as <thought>…</thought>. This removes those blocks
// from a stream, holding back only the few characters that might be the start of a tag.
const OPEN = '<thought>';
const CLOSE = '</thought>';
function thoughtFilter(): (chunk: string, flush?: boolean) => string {
  let buffer = '';
  let inside = false;
  return (chunk, flush = false) => {
    buffer += chunk;
    let out = '';
    for (;;) {
      const at = buffer.indexOf(inside ? CLOSE : OPEN);
      if (at < 0) break;
      if (!inside) out += buffer.slice(0, at);
      buffer = buffer.slice(at + (inside ? CLOSE : OPEN).length);
      inside = !inside;
    }
    const tag = inside ? CLOSE : OPEN;
    let keep = flush ? 0 : Math.min(buffer.length, tag.length - 1);
    while (keep > 0 && !tag.startsWith(buffer.slice(-keep))) keep--;
    if (!inside) out += buffer.slice(0, buffer.length - keep);
    buffer = buffer.slice(buffer.length - keep);
    return out;
  };
}

const factsSchema = z.object({ facts: z.array(z.object({ key: z.string().min(1), value: z.string().min(1) })) });

// Fire-and-forget: durable facts about the user are pulled out with a small model after the reply has been sent.
async function extractFacts(userMessage: string, assistantReply: string, now: Date): Promise<void> {
  if (userMessage.length < 40) return;
  try {
    const reply = await anthropic.messages.create({
      model: config.factModel,
      max_tokens: 600,
      system: 'Extract durable facts about the USER (team size, company, role, tech stack, budget, preferences) from this exchange. Only facts the user stated about themselves; nothing about products or the world. Reply with JSON only: {"facts":[{"key":"snake_case_key","value":"short value"}]}. Use {"facts":[]} if there are none.',
      messages: [{ role: 'user', content: `USER: ${userMessage}\n\nASSISTANT: ${assistantReply.slice(0, 1500)}` }],
    });
    const text = thoughtFilter()(reply.content.map((block) => (block.type === 'text' ? block.text : '')).join(''), true);
    const parsed = factsSchema.safeParse(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
    if (parsed.success) for (const fact of parsed.data.facts) upsertFact(fact.key, fact.value, now);
  } catch {
    // facts are a nice-to-have; a failure here must never surface to the user
  }
}
