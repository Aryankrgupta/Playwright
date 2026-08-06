import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import RunPanel from "../src/components/RunPanel.jsx";

const baseRun = {
  task: "open example.com",
  events: [],
  running: false,
  queued: false,
  queuePosition: null,
  stopping: false,
  cached: false,
};

const renderPanel = (run = {}, handlers = {}) =>
  render(
    <RunPanel
      run={{ ...baseRun, ...run }}
      onStop={handlers.onStop ?? vi.fn()}
      onRetry={handlers.onRetry ?? vi.fn()}
      onForceRefresh={handlers.onForceRefresh ?? vi.fn()}
      onImageClick={handlers.onImageClick ?? vi.fn()}
    />,
  );

describe("RunPanel", () => {
  it("shows the task and the tape's empty state for a finished run with no events", () => {
    renderPanel();
    expect(screen.getByText("open example.com")).toBeInTheDocument();
    expect(screen.getByText(/No run yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the run's events", () => {
    renderPanel({ events: [{ type: "thought", text: "thinking" }] });
    expect(screen.getByText("thinking")).toBeInTheDocument();
    expect(screen.queryByText(/No run yet/)).toBeNull();
  });

  it("offers Stop while running", async () => {
    const onStop = vi.fn();
    renderPanel({ running: true }, { onStop });

    const stop = screen.getByRole("button", { name: "Stop" });
    await userEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("offers Cancel and the queue position while queued", () => {
    renderPanel({ queued: true, queuePosition: 3 });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByText(/Queued — position 3/)).toBeInTheDocument();
  });

  it("omits the position when the queue slot is unknown", () => {
    renderPanel({ queued: true });
    expect(screen.getByText(/Queued, waiting for a free slot/)).toBeInTheDocument();
  });

  it("disables the stop button while stopping", () => {
    renderPanel({ running: true, stopping: true });
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
  });

  it("badges a cached run and lets it be re-run", async () => {
    const onForceRefresh = vi.fn();
    renderPanel({ cached: true }, { onForceRefresh });

    expect(screen.getByText("⚡ cached")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "⟳ Force refresh" }));
    expect(onForceRefresh).toHaveBeenCalledTimes(1);
  });

  it("hides force refresh while a cached run is still streaming", () => {
    renderPanel({ cached: true, running: true });
    expect(screen.queryByRole("button", { name: "⟳ Force refresh" })).toBeNull();
  });
});
