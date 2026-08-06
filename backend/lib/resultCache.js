// Short-lived cache of completed task event streams, keyed by the task text.
// Tasks that ask about "right now"/"latest"/etc. are never cached since a
// replay would show stale data.

const TIME_SENSITIVE_PATTERN =
  /\b(right now|today|current(ly)?|latest|live|this (week|month|hour)|now\b)/i;

export function isTimeSensitive(task) {
  return TIME_SENSITIVE_PATTERN.test(task);
}

export function cacheKey(task) {
  return task.trim().toLowerCase();
}

export function createResultCache({ ttlMs, max }) {
  const entries = new Map();

  return {
    get size() {
      return entries.size;
    },

    get(task) {
      const key = cacheKey(task);
      const entry = entries.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        entries.delete(key);
        return null;
      }
      return entry.events;
    },

    set(task, events) {
      const key = cacheKey(task);
      if (entries.size >= max && !entries.has(key)) {
        const oldestKey = entries.keys().next().value;
        entries.delete(oldestKey);
      }
      entries.set(key, { events, expiresAt: Date.now() + ttlMs });
    },
  };
}
