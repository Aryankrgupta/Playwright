import { describe, expect, it } from "vitest";
import { tryParsePlan } from "../lib/plan.js";

describe("tryParsePlan", () => {
  it("numbers sub-goals and marks them pending", () => {
    expect(tryParsePlan('[{"goal":"Navigate to X"},{"goal":"Extract Y"}]')).toEqual([
      { id: 1, goal: "Navigate to X", status: "pending" },
      { id: 2, goal: "Extract Y", status: "pending" },
    ]);
  });

  it("unwraps markdown-fenced JSON", () => {
    expect(tryParsePlan('```json\n[{"goal":"Navigate to X"}]\n```')).toEqual([
      { id: 1, goal: "Navigate to X", status: "pending" },
    ]);
    expect(tryParsePlan('```\n[{"goal":"Navigate to X"}]\n```')).toEqual([
      { id: 1, goal: "Navigate to X", status: "pending" },
    ]);
  });

  it("ignores extra fields the planner adds", () => {
    expect(tryParsePlan('[{"goal":"Navigate to X","why":"because"}]')).toEqual([
      { id: 1, goal: "Navigate to X", status: "pending" },
    ]);
  });

  it("returns null for non-JSON or prose replies", () => {
    expect(tryParsePlan("Sure! Here is the plan:")).toBe(null);
    expect(tryParsePlan("")).toBe(null);
  });

  it("returns null for an empty plan", () => {
    expect(tryParsePlan("[]")).toBe(null);
  });

  it("returns null when the JSON is not an array of goals", () => {
    expect(tryParsePlan('{"goal":"Navigate to X"}')).toBe(null);
    expect(tryParsePlan('["Navigate to X"]')).toBe(null);
    expect(tryParsePlan('[{"goal":1}]')).toBe(null);
    expect(tryParsePlan("[null]")).toBe(null);
  });
});
