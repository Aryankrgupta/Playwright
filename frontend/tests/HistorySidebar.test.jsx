import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import HistorySidebar from "../src/components/HistorySidebar.jsx";

const run = (id, task, extra = {}) => ({ id, task, events: [], ...extra });

describe("HistorySidebar", () => {
  it("shows an empty state when there are no runs", () => {
    render(<HistorySidebar runs={[]} onSelect={vi.fn()} />);
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("lists the most recent run first", () => {
    render(
      <HistorySidebar runs={[run(1, "older task"), run(2, "newer task")]} onSelect={vi.fn()} />,
    );
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "newer taskDone",
      "older taskDone",
    ]);
  });

  it.each([
    ["running", { running: true }, "Running", "history-dot-running"],
    ["queued", { queued: true }, "Queued", "history-dot-queued"],
    [
      "errored",
      { events: [{ type: "error", text: "boom" }] },
      "Error",
      "history-dot-error",
    ],
    [
      "stopped",
      { events: [{ type: "stopped", text: "Stopped by user." }] },
      "Stopped",
      "history-dot-stopped",
    ],
    [
      "completed",
      { events: [{ type: "done", text: "all good" }] },
      "Done",
      "history-dot-done",
    ],
  ])("labels a %s run", (_name, extra, label, dotClass) => {
    const { container } = render(
      <HistorySidebar runs={[run(1, "a task", extra)]} onSelect={vi.fn()} />,
    );
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container.querySelector(`.${dotClass}`)).toBeTruthy();
  });

  it("prefers the running state over the last event", () => {
    render(
      <HistorySidebar
        runs={[run(1, "a task", { running: true, events: [{ type: "error" }] })]}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("selects the run that was clicked", async () => {
    const onSelect = vi.fn();
    render(<HistorySidebar runs={[run(1, "first"), run(2, "second")]} onSelect={onSelect} />);

    await userEvent.click(screen.getByText("first"));
    expect(onSelect).toHaveBeenCalledWith(1);
  });
});
