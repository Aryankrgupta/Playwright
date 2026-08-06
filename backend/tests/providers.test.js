import { describe, expect, it } from "vitest";
import {
  parseCooldownMs,
  parseRetrySeconds,
  sanitizeAssistantMessage,
} from "../lib/providers.js";

const FIFTEEN_MINUTES = 15 * 60 * 1000;

describe("parseCooldownMs", () => {
  it("reads combined hour/minute/second durations", () => {
    expect(parseCooldownMs("Rate limit reached, try again in 1h2m3s")).toBe(
      (3600 + 120 + 3) * 1000,
    );
  });

  it("reads a fractional seconds-only duration", () => {
    expect(parseCooldownMs("please try again in 7.5s")).toBe(7500);
  });

  it("is case insensitive", () => {
    expect(parseCooldownMs("Try Again In 2m")).toBe(120_000);
  });

  it("falls back when the message has no duration", () => {
    expect(parseCooldownMs("quota exceeded")).toBe(FIFTEEN_MINUTES);
    expect(parseCooldownMs("quota exceeded", 1234)).toBe(1234);
  });

  it("falls back on a zero duration", () => {
    expect(parseCooldownMs("try again in 0s", 999)).toBe(999);
  });

  it("falls back for empty or missing messages", () => {
    expect(parseCooldownMs(undefined)).toBe(FIFTEEN_MINUTES);
    expect(parseCooldownMs("")).toBe(FIFTEEN_MINUTES);
  });
});

describe("sanitizeAssistantMessage", () => {
  it("passes through falsy input untouched", () => {
    expect(sanitizeAssistantMessage(null)).toBe(null);
    expect(sanitizeAssistantMessage(undefined)).toBe(undefined);
  });

  it("drops non-standard fields and normalizes missing content to null", () => {
    const clean = sanitizeAssistantMessage({
      role: "assistant",
      reasoning: "internal chain of thought",
      extra: 1,
    });
    expect(clean).toEqual({ role: "assistant", content: null });
  });

  it("keeps string tool-call arguments as-is", () => {
    const clean = sanitizeAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "browser_navigate", arguments: '{"url":"a.com"}' },
          reasoning: "drop me",
        },
      ],
    });
    expect(clean.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "browser_navigate", arguments: '{"url":"a.com"}' },
      },
    ]);
  });

  it("serializes object arguments and flattened name/arguments shapes", () => {
    const clean = sanitizeAssistantMessage({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", name: "browser_find", arguments: { text: "Sign in" } },
      ],
    });
    expect(clean.tool_calls[0].function).toEqual({
      name: "browser_find",
      arguments: '{"text":"Sign in"}',
    });
  });

  it("serializes an empty object when arguments are absent", () => {
    const clean = sanitizeAssistantMessage({
      role: "assistant",
      tool_calls: [{ id: "c1", function: { name: "browser_snapshot" } }],
    });
    expect(clean.tool_calls[0].function.arguments).toBe("{}");
  });

  it("generates a fallback id for a tool call that has none", () => {
    const clean = sanitizeAssistantMessage({
      role: "assistant",
      tool_calls: [{ function: { name: "browser_snapshot", arguments: "{}" } }],
    });
    expect(clean.tool_calls[0].id).toMatch(/^call_\w+$/);
  });

  it("ignores a non-array tool_calls value", () => {
    const clean = sanitizeAssistantMessage({
      role: "assistant",
      content: "hi",
      tool_calls: "nope",
    });
    expect(clean).toEqual({ role: "assistant", content: "hi" });
  });

  it("maps tool responses onto tool_call_id, falling back to id", () => {
    expect(
      sanitizeAssistantMessage({
        role: "tool",
        content: "ok",
        tool_call_id: "call_9",
      }).tool_call_id,
    ).toBe("call_9");
    expect(
      sanitizeAssistantMessage({ role: "tool", content: "ok", id: "call_8" })
        .tool_call_id,
    ).toBe("call_8");
    expect(
      sanitizeAssistantMessage({ role: "tool", content: "ok" }).tool_call_id,
    ).toBe("");
  });
});

describe("parseRetrySeconds", () => {
  it("returns null when the error carries no headers", () => {
    expect(parseRetrySeconds(undefined)).toBe(null);
    expect(parseRetrySeconds({})).toBe(null);
  });

  it("reads plain-object headers off err.response", () => {
    expect(
      parseRetrySeconds({ response: { headers: { "retry-after": "12" } } }),
    ).toBe(12);
  });

  it("reads Headers-like objects via get()", () => {
    const headers = new Map([["x-ratelimit-reset-tokens-minute", "4.2"]]);
    expect(parseRetrySeconds({ headers })).toBe(5);
  });

  it("takes the longest of several reset headers and rounds up", () => {
    expect(
      parseRetrySeconds({
        headers: {
          "x-ratelimit-reset-requests-minute": "10",
          "x-ratelimit-reset-tokens-hour": "90.1",
          "retry-after": "30",
        },
      }),
    ).toBe(91);
  });

  it("ignores unparseable and unrelated header values", () => {
    expect(
      parseRetrySeconds({
        headers: { "retry-after": "soon", "x-request-id": "abc" },
      }),
    ).toBe(null);
  });
});
