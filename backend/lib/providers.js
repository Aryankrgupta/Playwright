// Helpers for talking to the OpenAI-compatible providers: cooldown parsing
// from rate-limit errors and normalizing assistant messages so a message
// produced by one provider can be replayed to another.

export function parseCooldownMs(message, fallbackMs = 15 * 60 * 1000) {
  const match =
    /try again in\s*(?:([\d.]+)h)?\s*(?:([\d.]+)m)?\s*(?:([\d.]+)s)?/i.exec(
      message || "",
    );
  if (!match) return fallbackMs;
  const [, h, m, s] = match;
  const ms =
    ((parseFloat(h) || 0) * 3600 +
      (parseFloat(m) || 0) * 60 +
      (parseFloat(s) || 0)) *
    1000;
  return ms > 0 ? ms : fallbackMs;
}

// Cerebras's gpt-oss model attaches extra non-standard fields (like
// `reasoning`) to assistant messages. Other providers reject those fields
// outright, so any message pushed into the shared conversation history
// must be stripped down to the standard OpenAI shape first.
export function sanitizeAssistantMessage(msg) {
  if (!msg) return msg;

  const clean = {
    role: msg.role,
    content: msg.content ?? null,
  };

  // 1. If it's a tool-use message, normalize the call structures cleanly
  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    clean.tool_calls = msg.tool_calls.map((call) => ({
      id: call.id || `call_${Math.random().toString(36).slice(2, 11)}`, // Fallback safe ID generator
      type: "function",
      function: {
        name: call.function?.name || call.name,
        arguments:
          typeof call.function?.arguments === "string"
            ? call.function.arguments
            : JSON.stringify(call.function?.arguments || call.arguments || {}),
      },
    }));
  }

  // 2. If it's a structural tool response message, enforce strict tool_call_id parameter mapping
  if (msg.role === "tool") {
    clean.tool_call_id = msg.tool_call_id || msg.id || "";
  }

  return clean;
}

// Reads how long to wait from a provider's rate-limit response headers.
// Returns whole seconds, or null when no reset header is present.
export function parseRetrySeconds(err) {
  const headers = err?.headers || err?.response?.headers;
  if (!headers) return null;

  const getHeader = (name) =>
    typeof headers.get === "function" ? headers.get(name) : headers[name];

  const resetKeys = [
    "x-ratelimit-reset-tokens-minute",
    "x-ratelimit-reset-requests-minute",
    "x-ratelimit-reset-tokens-hour",
    "x-ratelimit-reset-requests-hour",
    "x-ratelimit-reset-tokens-day",
    "x-ratelimit-reset-requests-day",
    "retry-after",
  ];

  let maxSeconds = null;
  for (const key of resetKeys) {
    const value = getHeader(key);
    if (value === undefined || value === null) continue;
    const num = parseFloat(value);
    if (!Number.isNaN(num) && (maxSeconds === null || num > maxSeconds)) {
      maxSeconds = num;
    }
  }

  return maxSeconds !== null ? Math.ceil(maxSeconds) : null;
}
