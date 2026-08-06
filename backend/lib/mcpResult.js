// Turns a raw MCP tool result into the compact { text, screenshot, isError }
// shape the agent loop streams to the frontend and feeds back to the model.

const MAX_TEXT_LENGTH = 4000;

const SNAPSHOT_NOISE_PATTERNS = [
  /- navigation "Shortcuts menu"[\s\S]*?- generic \[ref=\w+\]: To move between items, use your keyboard's up or down arrows\.\n/,
  /- combobox "Select the department you want to search in"[\s\S]*?(?=\n\s*- searchbox)/,
  /(?:\s*- generic: "Test: [^\n]+"\n)+/g,
];

export function stripSnapshotNoise(text) {
  let cleaned = text;
  for (const pattern of SNAPSHOT_NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }
  return cleaned;
}

export function summarizeMcpResult(result) {
  const items = result?.content || [];
  let text = items
    .filter((i) => i.type === "text")
    .map((i) => i.text)
    .join("\n");

  text = stripSnapshotNoise(text);
  text = text.slice(0, MAX_TEXT_LENGTH);

  const screenshot = items.find((i) => i.type === "image");
  return {
    text:
      text ||
      (screenshot
        ? "(screenshot captured -- shown to the user, not visible to you)"
        : "(no text output)"),
    screenshot: screenshot
      ? { data: screenshot.data, mimeType: screenshot.mimeType || "image/png" }
      : null,
    isError: !!result?.isError,
  };
}
