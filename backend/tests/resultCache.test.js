import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheKey, createResultCache, isTimeSensitive } from "../lib/resultCache.js";

describe("isTimeSensitive", () => {
  it.each([
    "Tell me the top stories right now",
    "What is today's forecast",
    "Get the current price",
    "Currently trending repos",
    "The latest AI news",
    "Show me live scores",
    "Top posts this week",
    "Top posts this month",
    "Top posts this hour",
    "What is happening now",
  ])("flags %j as time sensitive", (task) => {
    expect(isTimeSensitive(task)).toBe(true);
  });

  it.each([
    "Open wikipedia.org and search for Playwright (software)",
    "Summarize the About page of example.com",
    "Find the tallest mountain in Nepal",
  ])("does not flag %j", (task) => {
    expect(isTimeSensitive(task)).toBe(false);
  });
});

describe("cacheKey", () => {
  it("normalizes surrounding whitespace and case", () => {
    expect(cacheKey("  Open Example.com  ")).toBe("open example.com");
  });
});

describe("createResultCache", () => {
  let cache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = createResultCache({ ttlMs: 1000, max: 2 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null for an unknown task", () => {
    expect(cache.get("unknown task")).toBe(null);
  });

  it("stores and retrieves events regardless of case and padding", () => {
    const events = [{ type: "done", text: "ok" }];
    cache.set("Open example.com", events);
    expect(cache.get("  open EXAMPLE.com ")).toBe(events);
    expect(cache.size).toBe(1);
  });

  it("expires entries once the ttl has passed", () => {
    cache.set("open example.com", [{ type: "done" }]);
    vi.advanceTimersByTime(1001);
    expect(cache.get("open example.com")).toBe(null);
    expect(cache.size).toBe(0);
  });

  it("evicts the oldest entry when full", () => {
    cache.set("first", [1]);
    cache.set("second", [2]);
    cache.set("third", [3]);
    expect(cache.size).toBe(2);
    expect(cache.get("first")).toBe(null);
    expect(cache.get("second")).toEqual([2]);
    expect(cache.get("third")).toEqual([3]);
  });

  it("overwrites an existing key without evicting anything", () => {
    cache.set("first", [1]);
    cache.set("second", [2]);
    cache.set("first", [9]);
    expect(cache.size).toBe(2);
    expect(cache.get("first")).toEqual([9]);
    expect(cache.get("second")).toEqual([2]);
  });
});
