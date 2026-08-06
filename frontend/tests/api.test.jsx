import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resumeTask, runTask, stopTask } from "../src/api.js";

const API_BASE = "http://localhost:3000";

// Builds a Response-like object whose body streams the given chunks, so we
// can drive runTask's ndjson reader with arbitrary line splits.
function streamingResponse(chunks, { ok = true } = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok,
    json: async () => ({}),
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { value: encoder.encode(chunks[i++]), done: false }
            : { value: undefined, done: true },
      }),
    },
  };
}

describe("stopTask / resumeTask", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to the stop endpoint and returns the parsed body", async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => ({ stopped: true }) });
    await expect(stopTask("t-1")).resolves.toEqual({ stopped: true });
    expect(fetch).toHaveBeenCalledWith(`${API_BASE}/api/stop/t-1`, { method: "POST" });
  });

  it("POSTs to the resume endpoint and returns the parsed body", async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => ({ resumed: true }) });
    await expect(resumeTask("t-2")).resolves.toEqual({ resumed: true });
    expect(fetch).toHaveBeenCalledWith(`${API_BASE}/api/resume/t-2`, { method: "POST" });
  });
});

describe("runTask", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the task with default options", async () => {
    fetch.mockResolvedValue(streamingResponse([]));
    await runTask("open example.com", () => {});

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`${API_BASE}/api/task`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({
      task: "open example.com",
      forceRefresh: false,
      turbo: true,
      record: false,
    });
  });

  it("forwards caller options, treating turbo as opt-out", async () => {
    fetch.mockResolvedValue(streamingResponse([]));
    await runTask("t", () => {}, { forceRefresh: true, turbo: false, record: true });

    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1].body)).toEqual({
      task: "t",
      forceRefresh: true,
      turbo: false,
      record: true,
    });
  });

  it("emits one event per ndjson line, including lines split across chunks", async () => {
    fetch.mockResolvedValue(
      streamingResponse([
        '{"type":"start","taskId":"t-1"}\n{"type":"thou',
        'ght","text":"thinking"}\n',
        '{"type":"done","text":"finished"}\n',
      ]),
    );

    const events = [];
    await runTask("t", (evt) => events.push(evt));

    expect(events).toEqual([
      { type: "start", taskId: "t-1" },
      { type: "thought", text: "thinking" },
      { type: "done", text: "finished" },
    ]);
  });

  it("skips blank lines and logs unparseable ones instead of throwing", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    fetch.mockResolvedValue(
      streamingResponse(['\n\n{"type":"done"}\nnot json\n{"type":"stopped"}\n']),
    );

    const events = [];
    await runTask("t", (evt) => events.push(evt));

    expect(events).toEqual([{ type: "done" }, { type: "stopped" }]);
    expect(consoleError).toHaveBeenCalledWith(
      "Bad event line",
      "not json",
      expect.any(Error),
    );
  });

  it("ignores a trailing line that never gets terminated", async () => {
    fetch.mockResolvedValue(
      streamingResponse(['{"type":"done"}\n{"type":"thought"']),
    );

    const events = [];
    await runTask("t", (evt) => events.push(evt));

    expect(events).toEqual([{ type: "done" }]);
  });

  it("throws the server's error message on a failed request", async () => {
    fetch.mockResolvedValue({ ok: false, json: async () => ({ error: "Missing task" }) });
    await expect(runTask("", () => {})).rejects.toThrow("Missing task");
  });

  it("throws a generic error when the failure body isn't JSON", async () => {
    fetch.mockResolvedValue({
      ok: false,
      json: async () => {
        throw new Error("not json");
      },
    });
    await expect(runTask("t", () => {})).rejects.toThrow("Request failed");
  });
});
