// services/googleSearch.js
// Google Programmable Search Engine (Custom Search JSON API) integration.
// Docs: https://developers.google.com/custom-search/v1/overview

const BASE_URL = "https://www.googleapis.com/customsearch/v1";

/**
 * Search the web via Google's Programmable Search Engine.
 * @param {string} query - The search query string.
 * @param {object} [options]
 * @param {number} [options.numResults=10] - Number of results (max 10 per request).
 * @param {number} [options.startIndex=1] - Pagination start index (1-based).
 * @param {string} [options.dateRestrict] - e.g. "d7" (past 7 days), "m1" (past month).
 * @returns {Promise<{items: Array<{title:string, link:string, snippet:string}>, searchTime: number, totalResults: string}>}
 */
export async function googleSearch(query, options = {}) {
  const GOOGLE_SEARCH_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
  const GOOGLE_SEARCH_ENGINE_ID = process.env.GOOGLE_SEARCH_ENGINE_ID;

  if (!GOOGLE_SEARCH_API_KEY || !GOOGLE_SEARCH_ENGINE_ID) {
    throw new Error(
      "Missing GOOGLE_SEARCH_API_KEY or GOOGLE_SEARCH_ENGINE_ID environment variables."
    );
  }
  if (!query || typeof query !== "string" || !query.trim()) {
    throw new Error("googleSearch: query must be a non-empty string.");
  }

  const { numResults = 10, startIndex = 1, dateRestrict } = options;

  const params = new URLSearchParams({
    key: GOOGLE_SEARCH_API_KEY,
    cx: GOOGLE_SEARCH_ENGINE_ID,
    q: query,
    num: String(Math.min(Math.max(numResults, 1), 10)), // API caps at 10 per call
    start: String(startIndex),
  });

  if (dateRestrict) {
    params.set("dateRestrict", dateRestrict);
  }

  const url = `${BASE_URL}?${params.toString()}`;

  let response;
  try {
    response = await fetch(url, { method: "GET" });
  } catch (err) {
    throw new Error(`googleSearch: network error calling Custom Search API: ${err.message}`);
  }

  if (!response.ok) {
    let detail = "";
    try {
      const errBody = await response.json();
      detail = errBody?.error?.message || JSON.stringify(errBody);
    } catch {
      detail = await response.text().catch(() => "");
    }

    if (response.status === 429) {
      throw new Error(
        `googleSearch: rate limited / quota exceeded (429). ${detail}`
      );
    }
    if (response.status === 403) {
      throw new Error(
        `googleSearch: forbidden (403) — check API key restrictions and that Custom Search API is enabled. ${detail}`
      );
    }
    throw new Error(`googleSearch: request failed (${response.status}). ${detail}`);
  }

  const data = await response.json();

  const items = (data.items || []).map((item) => ({
    title: item.title,
    link: item.link,
    snippet: item.snippet,
    displayLink: item.displayLink,
  }));

  return {
    items,
    searchTime: data.searchInformation?.searchTime ?? null,
    totalResults: data.searchInformation?.totalResults ?? "0",
  };
}

/**
 * Fetch multiple pages of results (Google caps each request at 10 results,
 * so pull in batches of 10 up to `total`).
 */
export async function googleSearchPaged(query, total = 10, options = {}) {
  const pages = Math.ceil(total / 10);
  const allItems = [];

  for (let i = 0; i < pages; i++) {
    const startIndex = i * 10 + 1;
    const { items } = await googleSearch(query, {
      ...options,
      numResults: Math.min(10, total - allItems.length),
      startIndex,
    });
    allItems.push(...items);
    if (items.length < 10) break; // no more results available
  }

  return allItems.slice(0, total);
}