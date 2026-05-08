export function createTtlCache(ttlSeconds) {
  const ttlMs = Math.max(0, ttlSeconds) * 1000;
  const entries = new Map();

  return {
    get(key) {
      if (!ttlMs) return undefined;
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expiresAt) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      if (!ttlMs) return;
      entries.set(key, {
        value,
        expiresAt: Date.now() + ttlMs
      });
    },
    clear() {
      entries.clear();
    }
  };
}
