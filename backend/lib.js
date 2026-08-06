// Shared, dependency-light helpers used across the backend. Kept pure and
// side-effect free so they can be reasoned about (and reused) in isolation.

import OpenAI from "openai";

// Parse a JSON string, returning `fallback` on empty input or any parse error
// instead of throwing. Used wherever we decode untrusted/model-supplied JSON
// (tool-call arguments, etc.).
export function safeParseJson(str, fallback = {}) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

// Build an OpenAI-compatible fallback provider from an env-driven config.
// A provider is "enabled" only when its API key env var is set; when disabled
// `client` is null. Returns a uniform shape the fallback chain can consume:
// { name, label, apiKeyEnv, enabled, client, model, disabledUntil }.
export function makeOpenAIProvider({
  name,
  label,
  apiKeyEnv,
  model,
  baseURL,
  defaultHeaders,
}) {
  const apiKey = process.env[apiKeyEnv];
  const enabled = !!apiKey;
  const client = enabled
    ? new OpenAI({
        apiKey,
        baseURL,
        ...(defaultHeaders ? { defaultHeaders } : {}),
      })
    : null;
  return {
    name,
    label,
    apiKeyEnv,
    enabled,
    client,
    model,
    disabledUntil: 0,
  };
}
