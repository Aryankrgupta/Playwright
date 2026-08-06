// Parses the planner model's reply -- a JSON array of sub-goals, sometimes
// wrapped in markdown fences -- into the internal sub-goal shape. Returns
// null when the reply isn't a usable plan so the caller can fall back to
// running the whole task as a single sub-goal.

export function tryParsePlan(text) {
  try {
    const cleaned = text
      .trim()
      .replace(/^```(json)?/i, "")
      .replace(/```$/, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((p) => p && typeof p.goal === "string")
    ) {
      return parsed.map((p, i) => ({
        id: i + 1,
        goal: p.goal,
        status: "pending",
      }));
    }
  } catch {
    // fall through
  }
  return null;
}
