const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:3000";

export async function stopTask(taskId) {
  const res = await fetch(`${API_BASE}/api/stop/${taskId}`, { method: "POST" });
  return res.json();
}

export async function resumeTask(taskId) {
  const res = await fetch(`${API_BASE}/api/resume/${taskId}`, { method: "POST" });
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