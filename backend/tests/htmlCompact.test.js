import { describe, expect, it } from "vitest";
import { dropTokenWaste } from "../lib/htmlCompact.js";

describe("dropTokenWaste", () => {
  it("returns an empty string for empty input", () => {
    expect(dropTokenWaste("")).toBe("");
    expect(dropTokenWaste(undefined)).toBe("");
    expect(dropTokenWaste(null)).toBe("");
  });

  it("removes chrome that carries no user text or data", () => {
    const html = `
      <html><head><title>t</title></head>
      <body>
        <nav>menu</nav>
        <script>tracker()</script>
        <style>.a{color:red}</style>
        <noscript>enable js</noscript>
        <svg><path d="M0 0" /></svg>
        <iframe src="ad.html"></iframe>
        <main>Real content</main>
        <footer>footer text</footer>
      </body></html>`;
    const out = dropTokenWaste(html);
    expect(out).toContain("Real content");
    for (const dropped of [
      "tracker()",
      "color:red",
      "enable js",
      "ad.html",
      "footer text",
      "menu",
      "<title>",
    ]) {
      expect(out).not.toContain(dropped);
    }
  });

  it("keeps attributes the model needs to address elements", () => {
    const out = dropTokenWaste(
      '<div id="row" class="c" data-testid="x" style="color:red" onclick="go()">' +
        '<input name="q" placeholder="Search" value="v" aria-label="Search box" role="searchbox" data-idx="3">' +
        '<a href="/next" target="_blank">Next</a></div>',
    );
    for (const kept of [
      'id="row"',
      'class="c"',
      'name="q"',
      'placeholder="Search"',
      'value="v"',
      'aria-label="Search box"',
      'role="searchbox"',
      'href="/next"',
    ]) {
      expect(out).toContain(kept);
    }
    for (const dropped of ["data-testid", "style=", "onclick", "target=", "data-idx"]) {
      expect(out).not.toContain(dropped);
    }
  });

  it("collapses whitespace runs and trims the result", () => {
    // Cheerio normalizes a fragment into a full document while parsing.
    expect(dropTokenWaste("<p>a\n\n   b\t c</p>\n")).toBe(
      "<html><body><p>a b c</p> </body></html>",
    );
  });
});
