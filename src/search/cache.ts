// Tiny in-memory TTL cache so repeated or follow-up questions do not pay for the same search twice.
export class TtlCache<T> {
  private entries = new Map<string, { value: T; expires: number }>();

  constructor(private ttlMs: number) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
  }
}
