// In dev, Vite's proxy (see vite.config.js) forwards /api/* to the backend,
// so a relative path just works. For a production build served separately
// from the API, set VITE_API_URL (e.g. in a .env file) to the API's origin.
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:3000";

export async function stopTask() {
  const res = await fetch(`${API_BASE}/api/stop`, { method: "POST" });
  return res.json();
}

// Streams ndjson events from POST /api/task, calling onEvent for each parsed
// line as it arrives. Throws if the initial request fails (non-2xx).
export async function runTask(task, onEvent) {
  const res = await fetch(`${API_BASE}/api/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || "Request failed");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line));
      } catch (err) {
        console.error("Bad event line", line, err);
      }
    }
  }
}
