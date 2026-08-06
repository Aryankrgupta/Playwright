import { describe, expect, it } from "vitest";
import { stripSnapshotNoise, summarizeMcpResult } from "../lib/mcpResult.js";

describe("stripSnapshotNoise", () => {
  it("leaves unrelated snapshot text alone", () => {
    const text = '- button "Add to cart" [ref=e12]\n- heading "Results" [ref=e3]\n';
    expect(stripSnapshotNoise(text)).toBe(text);
  });

  it("drops the shortcuts-menu navigation block", () => {
    const text =
      '- navigation "Shortcuts menu"\n' +
      '  - link "Deals" [ref=e5]\n' +
      "  - generic [ref=e9]: To move between items, use your keyboard's up or down arrows.\n" +
      '- searchbox "Search" [ref=e20]\n';
    expect(stripSnapshotNoise(text)).toBe('- searchbox "Search" [ref=e20]\n');
  });

  it("drops the department combobox up to the following searchbox", () => {
    const text =
      '- combobox "Select the department you want to search in" [ref=e7]\n' +
      '  - option "All Departments"\n' +
      '  - option "Books"\n' +
      '- searchbox "Search Amazon" [ref=e8]\n';
    expect(stripSnapshotNoise(text)).toBe('\n- searchbox "Search Amazon" [ref=e8]\n');
  });

  it("drops every consecutive test-marker generic line", () => {
    const text =
      '- generic: "Test: alpha"\n' +
      '  - generic: "Test: beta"\n' +
      '- heading "Real" [ref=e1]\n' +
      '- generic: "Test: gamma"\n';
    expect(stripSnapshotNoise(text)).toBe('- heading "Real" [ref=e1]');
  });
});

describe("summarizeMcpResult", () => {
  it("joins text parts with newlines and reports no error", () => {
    expect(
      summarizeMcpResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
    ).toEqual({ text: "a\nb", screenshot: null, isError: false });
  });

  it("truncates long text to 4000 characters", () => {
    const { text } = summarizeMcpResult({
      content: [{ type: "text", text: "x".repeat(5000) }],
    });
    expect(text).toHaveLength(4000);
  });

  it("strips snapshot noise before truncating", () => {
    const { text } = summarizeMcpResult({
      content: [{ type: "text", text: '- generic: "Test: alpha"\n- heading "Real"\n' }],
    });
    expect(text).toBe('- heading "Real"\n');
  });

  it("extracts a screenshot and defaults its mime type", () => {
    const { screenshot } = summarizeMcpResult({
      content: [
        { type: "text", text: "page loaded" },
        { type: "image", data: "AAA" },
      ],
    });
    expect(screenshot).toEqual({ data: "AAA", mimeType: "image/png" });
  });

  it("keeps an explicit screenshot mime type", () => {
    const { screenshot } = summarizeMcpResult({
      content: [{ type: "image", data: "AAA", mimeType: "image/jpeg" }],
    });
    expect(screenshot.mimeType).toBe("image/jpeg");
  });

  it("explains a screenshot-only result to the model", () => {
    expect(summarizeMcpResult({ content: [{ type: "image", data: "AAA" }] }).text).toBe(
      "(screenshot captured -- shown to the user, not visible to you)",
    );
  });

  it("falls back to a placeholder for empty or missing content", () => {
    expect(summarizeMcpResult({ content: [] }).text).toBe("(no text output)");
    expect(summarizeMcpResult(undefined)).toEqual({
      text: "(no text output)",
      screenshot: null,
      isError: false,
    });
  });

  it("propagates the error flag", () => {
    expect(
      summarizeMcpResult({ isError: true, content: [{ type: "text", text: "Tool error" }] })
        .isError,
    ).toBe(true);
  });
});
