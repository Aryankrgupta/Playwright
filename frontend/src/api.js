const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:3000";

async function parseError(res, fallback) {
  const body = await res.json().catch(() => null);
  return new Error(body?.error || `${fallback} (HTTP ${res.status})`);
}

export async function stopTask(taskId) {
  const res = await fetch(`${API_BASE}/api/stop/${taskId}`, { method: "POST" });
  if (!res.ok) throw await parseError(res, "Failed to stop task");
  return res.json();
}

export async function resumeTask(taskId) {
  const res = await fetch(`${API_BASE}/api/resume/${taskId}`, { method: "POST" });
  if (!res.ok) throw await parseError(res, "Failed to resume task");
  return res.json();
}

export async function runTask(task, onEvent, options = {}) {
  const res = await fetch(`${API_BASE}/api/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task,
      forceRefresh: !!options.forceRefresh,
      turbo: options.turbo !== false,
      record: !!options.record,
    }),
  });

  if (!res.ok) {
    throw await parseError(res, "Request failed");
  }

  if (!res.body) {
    throw new Error("Server returned an empty response stream.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const emit = (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch (err) {
      console.error("Bad event line", line, err);
      onEvent({ type: "error", text: `Received a malformed event from the server: ${err.message}` });
      return;
    }
    onEvent(event);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) emit(line);
  }

  // A stream that ends without a trailing newline still holds a full event.
  buffer += decoder.decode();
  emit(buffer);
}