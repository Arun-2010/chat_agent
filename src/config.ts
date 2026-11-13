// Loads .env and validates it once at startup, failing with a readable list of missing keys.
import 'dotenv/config';
import { z } from 'zod';

const optional = (fallback: string) =>
  z.string().optional().transform((v) => (v && v.trim() ? v.trim() : fallback));

const schema = z.object({
  LLM_API_KEY: z.string().min(1),
  TAVILY_API_KEY: z.string().min(1),
  LLM_BASE_URL: z.string().optional().transform((v) => (v === undefined ? 'https://rapidrouter.ai/api' : v.trim())),
  LLM_MODEL: optional('google/gemma-4-31b-it:free'),
  FACT_MODEL: optional('google/gemma-4-31b-it:free'),
  SEED_ON_START: optional('false'),
  PORT: optional('3000'),
  TIMEZONE: optional('Asia/Kolkata'),
  FAKE_NOW: optional(''),
  DB_PATH: optional('./data/recall.db'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
  throw new Error(`Missing required environment variables: ${missing}. Copy .env.example to .env and fill them in.`);
}

export const config = {
  llmApiKey: parsed.data.LLM_API_KEY,
  tavilyApiKey: parsed.data.TAVILY_API_KEY,
  llmBaseUrl: parsed.data.LLM_BASE_URL || undefined,
  model: parsed.data.LLM_MODEL,
  factModel: parsed.data.FACT_MODEL,
  seedOnStart: parsed.data.SEED_ON_START === 'true',
  port: Number(parsed.data.PORT),
  timezone: parsed.data.TIMEZONE,
  fakeNow: parsed.data.FAKE_NOW,
  dbPath: parsed.data.DB_PATH,
};
