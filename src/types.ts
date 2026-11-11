// Shared types used across the memory, search and agent layers.

export type Role = 'user' | 'assistant';

export interface StoredMessage {
  id: number;
  conversation_id: string;
  role: Role;
  content: string;
  created_at: string; // ISO 8601 UTC
  day: string; // YYYY-MM-DD in TIMEZONE
}

export interface Fact {
  key: string;
  value: string;
  updated_at: string;
}

export interface DayIndexRow {
  day: string;
  count: number;
  snippets: string[];
}

export interface DateRange {
  label: string;
  from: Date;
  to: Date;
}

export interface SearchResult {
  title: string;
  url: string;
  publishedDate: string | null;
  content: string;
  score: number;
}

export interface Source {
  title: string;
  url: string;
  publishedDate: string | null;
}

export type AgentEvent =
  | { type: 'token'; text: string }
  | { type: 'status'; text: string }
  | { type: 'sources'; items: Source[] }
  | { type: 'done' }
  | { type: 'error'; message: string };
