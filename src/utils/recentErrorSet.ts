// Remembers the error texts that were just logged, so the same failure is not logged a second
// time by React Query or `unhandledrejection` after the invoke wrapper already recorded it.

export interface RecentErrorSet {
  remember(text: string): void;
  has(text: string): boolean;
}

interface RecentErrorSetOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

const KEY_CHARS = 200;

function keyOf(text: string): string {
  return text.trim().slice(0, KEY_CHARS);
}

export function createRecentErrorSet(options: RecentErrorSetOptions = {}): RecentErrorSet {
  const maxEntries = options.maxEntries ?? 50;
  const ttlMs = options.ttlMs ?? 5000;
  const now = options.now ?? Date.now;
  // Map keeps insertion order, so the first key is always the oldest one.
  const seenAt = new Map<string, number>();

  return {
    remember(text) {
      const key = keyOf(text);
      if (!key) return;
      seenAt.delete(key);
      seenAt.set(key, now());
      while (seenAt.size > maxEntries) {
        const oldest = seenAt.keys().next();
        if (oldest.done) break;
        seenAt.delete(oldest.value);
      }
    },
    has(text) {
      const key = keyOf(text);
      const at = seenAt.get(key);
      if (at === undefined) return false;
      if (now() - at > ttlMs) {
        seenAt.delete(key);
        return false;
      }
      return true;
    },
  };
}
