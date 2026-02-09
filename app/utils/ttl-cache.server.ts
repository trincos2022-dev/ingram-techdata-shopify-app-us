type CacheEntry<V> = {
  value: V;
  expiresAt: number;
};

type TtlCacheOptions = {
  ttlMs: number;
  maxEntries?: number;
};

// Tiny TTL cache for hot-path lookups (in-memory, process-local).
export function createTtlCache<K, V>({ ttlMs, maxEntries = 500 }: TtlCacheOptions) {
  const store = new Map<K, CacheEntry<V>>();

  function get(key: K): V | undefined {
    const entry = store.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }

    return entry.value;
  }

  function set(key: K, value: V, customTtlMs?: number) {
    const expiresAt = Date.now() + (customTtlMs ?? ttlMs);
    store.set(key, { value, expiresAt });

    if (store.size > maxEntries) {
      const oldestKey = store.keys().next().value;
      if (oldestKey !== undefined) {
        store.delete(oldestKey);
      }
    }
  }

  function deleteKey(key: K) {
    store.delete(key);
  }

  return {
    get,
    set,
    delete: deleteKey,
    size: () => store.size,
  };
}
