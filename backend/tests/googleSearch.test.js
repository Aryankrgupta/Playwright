import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googleSearch, googleSearchPaged } from "../services/googleSearch.js";

const okResponse = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

const errorResponse = (status, body) => ({
  ok: false,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const resultPage = (count, prefix = "r") => ({
  items: Array.from({ length: count }, (_, i) => ({
    title: `${prefix}${i}`,
    link: `https://example.com/${prefix}${i}`,
    snippet: `snippet ${prefix}${i}`,
    displayLink: "example.com",
    extraFieldWeDrop: true,
  })),
  searchInformation: { searchTime: 0.12, totalResults: String(count) },
});

const lastRequestParams = () =>
  new URL(vi.mocked(fetch).mock.calls.at(-1)[0]).searchParams;

describe("googleSearch", () => {
  beforeEach(() => {
    process.env.GOOGLE_SEARCH_API_KEY = "test-key";
    process.env.GOOGLE_SEARCH_ENGINE_ID = "test-cx";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    delete process.env.GOOGLE_SEARCH_API_KEY;
    delete process.env.GOOGLE_SEARCH_ENGINE_ID;
    vi.unstubAllGlobals();
  });

  it("throws when credentials are missing", async () => {
    delete process.env.GOOGLE_SEARCH_API_KEY;
    await expect(googleSearch("hello")).rejects.toThrow(
      /Missing GOOGLE_SEARCH_API_KEY or GOOGLE_SEARCH_ENGINE_ID/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([["", "empty"], ["   ", "blank"], [undefined, "missing"], [42, "non-string"]])(
    "rejects a %s query (%s)",
    async (query) => {
      await expect(googleSearch(query)).rejects.toThrow(
        /query must be a non-empty string/,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("maps results down to the fields callers use", async () => {
    fetch.mockResolvedValue(okResponse(resultPage(2)));

    await expect(googleSearch("playwright mcp")).resolves.toEqual({
      items: [
        {
          title: "r0",
          link: "https://example.com/r0",
          snippet: "snippet r0",
          displayLink: "example.com",
        },
        {
          title: "r1",
          link: "https://example.com/r1",
          snippet: "snippet r1",
          displayLink: "example.com",
        },
      ],
      searchTime: 0.12,
      totalResults: "2",
    });
  });

  it("sends credentials, query and default pagination", async () => {
    fetch.mockResolvedValue(okResponse(resultPage(1)));
    await googleSearch("playwright mcp");

    const params = lastRequestParams();
    expect(Object.fromEntries(params)).toEqual({
      key: "test-key",
      cx: "test-cx",
      q: "playwright mcp",
      num: "10",
      start: "1",
    });
    expect(fetch).toHaveBeenCalledWith(expect.any(String), { method: "GET" });
  });

  it("clamps numResults to the API's 1..10 range", async () => {
    fetch.mockResolvedValue(okResponse(resultPage(1)));

    await googleSearch("q", { numResults: 50 });
    expect(lastRequestParams().get("num")).toBe("10");

    await googleSearch("q", { numResults: 0 });
    expect(lastRequestParams().get("num")).toBe("1");
  });

  it("passes through startIndex and dateRestrict", async () => {
    fetch.mockResolvedValue(okResponse(resultPage(1)));
    await googleSearch("q", { startIndex: 11, dateRestrict: "d7" });

    const params = lastRequestParams();
    expect(params.get("start")).toBe("11");
    expect(params.get("dateRestrict")).toBe("d7");
  });

  it("omits dateRestrict when not requested", async () => {
    fetch.mockResolvedValue(okResponse(resultPage(1)));
    await googleSearch("q");
    expect(lastRequestParams().has("dateRestrict")).toBe(false);
  });

  it("defaults search metadata when the API omits it", async () => {
    fetch.mockResolvedValue(okResponse({}));
    await expect(googleSearch("q")).resolves.toEqual({
      items: [],
      searchTime: null,
      totalResults: "0",
    });
  });

  it("wraps network failures", async () => {
    fetch.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(googleSearch("q")).rejects.toThrow(
      /network error calling Custom Search API: ECONNREFUSED/,
    );
  });

  it("labels a 429 as rate limited and includes the API detail", async () => {
    fetch.mockResolvedValue(
      errorResponse(429, { error: { message: "Quota exceeded" } }),
    );
    await expect(googleSearch("q")).rejects.toThrow(
      /rate limited \/ quota exceeded \(429\)\. Quota exceeded/,
    );
  });

  it("labels a 403 with the key-restriction hint", async () => {
    fetch.mockResolvedValue(
      errorResponse(403, { error: { message: "API key not valid" } }),
    );
    await expect(googleSearch("q")).rejects.toThrow(
      /forbidden \(403\).*API key not valid/,
    );
  });

  it("reports other statuses with the raw body when it isn't JSON", async () => {
    fetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
      text: async () => "upstream exploded",
    });
    await expect(googleSearch("q")).rejects.toThrow(
      /request failed \(500\)\. upstream exploded/,
    );
  });
});

describe("googleSearchPaged", () => {
  beforeEach(() => {
    process.env.GOOGLE_SEARCH_API_KEY = "test-key";
    process.env.GOOGLE_SEARCH_ENGINE_ID = "test-cx";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    delete process.env.GOOGLE_SEARCH_API_KEY;
    delete process.env.GOOGLE_SEARCH_ENGINE_ID;
    vi.unstubAllGlobals();
  });

  it("pulls successive pages and trims to the requested total", async () => {
    fetch
      .mockResolvedValueOnce(okResponse(resultPage(10, "a")))
      .mockResolvedValueOnce(okResponse(resultPage(10, "b")));

    const items = await googleSearchPaged("q", 15);

    expect(items).toHaveLength(15);
    expect(items[0].title).toBe("a0");
    expect(items[10].title).toBe("b0");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(fetch).mock.calls.map(([url]) => new URL(url).searchParams.get("start")),
    ).toEqual(["1", "11"]);
  });

  it("stops early when a page comes back short", async () => {
    fetch.mockResolvedValueOnce(okResponse(resultPage(3, "a")));

    const items = await googleSearchPaged("q", 30);

    expect(items).toHaveLength(3);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("requests a single page for the default total", async () => {
    fetch.mockResolvedValue(okResponse(resultPage(10, "a")));

    const items = await googleSearchPaged("q");

    expect(items).toHaveLength(10);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("propagates errors from the underlying search", async () => {
    fetch.mockResolvedValue(errorResponse(429, { error: { message: "slow down" } }));
    await expect(googleSearchPaged("q", 20)).rejects.toThrow(/rate limited/);
  });
});
