import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App.jsx";
import { resumeTask, runTask, stopTask } from "../src/api.js";

vi.mock("../src/api.js", () => ({
  runTask: vi.fn(),
  stopTask: vi.fn(),
  resumeTask: vi.fn(),
}));

const STORAGE_KEY = "wayfinder_history_v1";

// Lets a test drive runTask's callback by hand: the returned promise stays
// pending until finish() is called, mirroring the open ndjson stream.
function deferredRun() {
  let emit;
  let finish;
  let fail;
  vi.mocked(runTask).mockImplementation(async (task, onEvent) => {
    emit = onEvent;
    return new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
  });
  return {
    emit: (event) => emit(event),
    finish: () => finish(),
    fail: (err) => fail(err),
  };
}

const storedRuns = () => JSON.parse(localStorage.getItem(STORAGE_KEY));

const sidebar = () => within(document.querySelector(".history-sidebar"));

const typeTask = async (text) => {
  await userEvent.type(screen.getByPlaceholderText(/Go to news.ycombinator.com/), text);
  await userEvent.click(screen.getByRole("button", { name: "Run task" }));
};

beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("App history restore", () => {
  it("starts empty when nothing is stored", () => {
    render(<App />);
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
    expect(screen.getByText(/No run yet/)).toBeInTheDocument();
  });

  it("ignores unparseable stored history", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    render(<App />);
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
  });

  it("restores finished runs as-is", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { id: 0, task: "old task", events: [{ type: "done", text: "all good" }] },
      ]),
    );
    render(<App />);
    expect(screen.getByText("all good")).toBeInTheDocument();
    expect(sidebar().getByText("Done")).toBeInTheDocument();
  });

  it("marks a run that was in flight as interrupted", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ id: 0, task: "old task", running: true, events: [] }]),
    );
    render(<App />);
    expect(screen.getByText("Interrupted by page reload.")).toBeInTheDocument();
    expect(sidebar().getByText("Stopped")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });
});

describe("App run lifecycle", () => {
  it("streams a run from queued through done and persists it", async () => {
    const run = deferredRun();
    render(<App />);

    await typeTask("open example.com");

    expect(runTask).toHaveBeenCalledWith("open example.com", expect.any(Function), {
      turbo: true,
      record: false,
    });
    expect(screen.getByText(/Queued, waiting for a free slot/)).toBeInTheDocument();

    run.emit({ type: "queued", taskId: "t-1", position: 2 });
    await screen.findByText(/Queued — position 2/);

    run.emit({ type: "start", taskId: "t-1", task: "open example.com" });
    await screen.findByRole("button", { name: "Stop" });

    run.emit({ type: "thought", text: "thinking about it" });
    run.emit({ type: "done", text: "finished" });
    await screen.findByText("finished");

    run.finish();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop" })).toBeNull(),
    );

    await waitFor(() => {
      const [stored] = storedRuns();
      expect(stored.task).toBe("open example.com");
      expect(stored.taskId).toBe("t-1");
      expect(stored.running).toBe(false);
      expect(stored.events.map((e) => e.type)).toEqual(["thought", "done"]);
    });
  });

  it("ignores a blank task", async () => {
    render(<App />);
    await userEvent.type(screen.getByPlaceholderText(/Go to news.ycombinator.com/), "   ");
    await userEvent.click(screen.getByRole("button", { name: "Run task" }));
    expect(runTask).not.toHaveBeenCalled();
  });

  it("forwards the turbo and record toggles", async () => {
    deferredRun();
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: /⚡ Turbo On/ }));
    await userEvent.click(screen.getByRole("button", { name: /Record Off/ }));
    await typeTask("open example.com");

    expect(runTask).toHaveBeenCalledWith("open example.com", expect.any(Function), {
      turbo: false,
      record: true,
    });
  });

  it("shows a request failure as an error entry", async () => {
    vi.mocked(runTask).mockRejectedValue(new Error("Backend unreachable"));
    render(<App />);

    await typeTask("open example.com");

    expect(await screen.findByText("Backend unreachable")).toBeInTheDocument();
    expect(sidebar().getByText("Error")).toBeInTheDocument();
  });

  it("stops a running task by its server-side id", async () => {
    const run = deferredRun();
    vi.mocked(stopTask).mockResolvedValue({ stopped: true });
    render(<App />);

    await typeTask("open example.com");
    run.emit({ type: "start", taskId: "t-1", task: "open example.com" });

    await userEvent.click(await screen.findByRole("button", { name: "Stop" }));
    expect(stopTask).toHaveBeenCalledWith("t-1");
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
  });

  it("re-enables the stop button when stopping fails", async () => {
    const run = deferredRun();
    vi.mocked(stopTask).mockRejectedValue(new Error("nope"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<App />);

    await typeTask("open example.com");
    run.emit({ type: "start", taskId: "t-1", task: "open example.com" });

    await userEvent.click(await screen.findByRole("button", { name: "Stop" }));
    expect(await screen.findByRole("button", { name: "Stop" })).toBeEnabled();
  });

  it("resumes a rate-limited task when the user clicks resume", async () => {
    const run = deferredRun();
    vi.mocked(resumeTask).mockResolvedValue({ resumed: true });
    render(<App />);

    await typeTask("open example.com");
    run.emit({ type: "start", taskId: "t-1", task: "open example.com" });
    run.emit({ type: "rate_limited", text: "Rate limit reached.", retryAfterSeconds: 30 });

    await userEvent.click(await screen.findByRole("button", { name: "Resume now" }));
    expect(resumeTask).toHaveBeenCalledWith("t-1");
  });

  it("re-runs a cached result with forceRefresh and clears the old events", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: 0,
          taskId: "t-old",
          task: "open example.com",
          cached: true,
          events: [{ type: "done", text: "stale answer" }],
        },
      ]),
    );
    const run = deferredRun();
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "⟳ Force refresh" }));

    expect(runTask).toHaveBeenCalledWith("open example.com", expect.any(Function), {
      forceRefresh: true,
      turbo: true,
    });
    expect(screen.queryByText("stale answer")).toBeNull();

    run.emit({ type: "start", taskId: "t-new", task: "open example.com" });
    run.emit({ type: "done", text: "fresh answer" });
    expect(await screen.findByText("fresh answer")).toBeInTheDocument();
  });

  it("shows a force-refresh failure as an error entry", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { id: 0, taskId: "t-old", task: "open example.com", cached: true, events: [] },
      ]),
    );
    vi.mocked(runTask).mockRejectedValue(new Error("Backend unreachable"));
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "⟳ Force refresh" }));
    expect(await screen.findByText("Backend unreachable")).toBeInTheDocument();
  });

  it("scrolls to and flashes the run picked from the history sidebar", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ id: 0, task: "old task", events: [{ type: "done", text: "ok" }] }]),
    );
    render(<App />);

    await userEvent.click(sidebar().getByText("old task"));

    const panel = document.getElementById("run-0");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
    expect(panel).toHaveClass("run-panel-flash");

    vi.advanceTimersByTime(1000);
    expect(panel).not.toHaveClass("run-panel-flash");
  });

  it("opens and closes a screenshot in the lightbox", async () => {
    const run = deferredRun();
    render(<App />);

    await typeTask("open example.com");
    run.emit({ type: "start", taskId: "t-1", task: "open example.com" });
    run.emit({
      type: "observation",
      tool: "browser_take_screenshot",
      text: "shot",
      screenshot: { mimeType: "image/png", data: "AAA" },
    });

    await userEvent.click(await screen.findByAltText("Screenshot"));
    expect(document.querySelector(".lightbox")).toBeTruthy();

    await userEvent.click(document.querySelector(".lightbox"));
    expect(document.querySelector(".lightbox")).toBeNull();
  });
});
