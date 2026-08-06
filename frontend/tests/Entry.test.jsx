import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import Entry from "../src/components/Entry.jsx";

const renderEntry = (event, props = {}) =>
  render(
    <Entry
      event={event}
      onImageClick={props.onImageClick ?? vi.fn()}
      onRetry={props.onRetry ?? vi.fn()}
      isLatest={props.isLatest ?? false}
    />,
  );

afterEach(() => {
  vi.useRealTimers();
});

describe("Entry", () => {
  it("renders nothing for an unknown event type", () => {
    const { container } = renderEntry({ type: "queued" });
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ["thought", "Thought"],
    ["done", "Done"],
    ["error", "Error"],
    ["stopped", "Stopped"],
  ])("renders a %s entry with its label and text", (type, label) => {
    const { container } = renderEntry({ type, text: "some text" });
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText("some text")).toBeInTheDocument();
    expect(container.querySelector(`.entry.${type}`)).toBeTruthy();
  });

  it("renders the plan as an ordered list of sub-goals", () => {
    renderEntry({
      type: "plan",
      subGoals: [
        { id: 1, goal: "Navigate to X" },
        { id: 2, goal: "Extract Y" },
      ],
    });
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Navigate to X",
      "Extract Y",
    ]);
  });

  it("renders sub-goal start, done and failed entries", () => {
    renderEntry({ type: "subgoal_start", id: 1, goal: "Navigate to X" });
    expect(screen.getByText("Sub-goal 1")).toBeInTheDocument();
    expect(screen.getByText("Navigate to X")).toBeInTheDocument();

    renderEntry({ type: "subgoal_done", id: 2, goal: "Extract Y", summary: "Found it" });
    expect(screen.getByText("✓ Sub-goal 2 done")).toBeInTheDocument();
    expect(screen.getByText("Found it")).toBeInTheDocument();

    renderEntry({ type: "subgoal_failed", id: 3, goal: "Buy Z", text: "Login wall" });
    expect(screen.getByText("✗ Sub-goal 3 failed")).toBeInTheDocument();
    expect(screen.getByText("Login wall")).toBeInTheDocument();
  });

  it("renders an action with its serialized input", () => {
    renderEntry({ type: "action", tool: "browser_navigate", input: { url: "a.com" } });
    expect(screen.getByText("Action")).toBeInTheDocument();
    expect(screen.getByText("browser_navigate(...)")).toBeInTheDocument();
    expect(screen.getByText('{"url":"a.com"}')).toBeInTheDocument();
  });

  it("omits the input row when the action has no arguments", () => {
    const { container } = renderEntry({ type: "action", tool: "browser_snapshot", input: {} });
    expect(container.querySelector(".entry-input")).toBeNull();
  });

  it("renders a provider switch as from/to chips", () => {
    renderEntry({ type: "provider_switch", from: "cerebras", to: "groq" });
    expect(screen.getByText("cerebras")).toBeInTheDocument();
    expect(screen.getByText("groq")).toHaveClass("provider-chip-active");
  });

  it("renders a recording as a video pointing at the API base", () => {
    const { container } = renderEntry({ type: "recording", url: "/recordings/t-1/v.webm" });
    expect(container.querySelector("video")).toHaveAttribute(
      "src",
      "http://localhost:3000/recordings/t-1/v.webm",
    );
  });

  it("renders an observation with its tool name and text", () => {
    const { container } = renderEntry({ type: "observation", tool: "browser_find", text: "found" });
    expect(screen.getByText("Observation")).toBeInTheDocument();
    expect(screen.getByText("← browser_find")).toBeInTheDocument();
    expect(container.querySelector(".entry.observation")).toBeTruthy();
  });

  it("styles a failed observation as an error", () => {
    const { container } = renderEntry({
      type: "observation",
      tool: "browser_click",
      text: "Tool error",
      isError: true,
    });
    expect(container.querySelector(".entry.error")).toBeTruthy();
  });

  it("passes the screenshot data url up when its thumbnail is clicked", async () => {
    const onImageClick = vi.fn();
    renderEntry(
      {
        type: "observation",
        tool: "browser_take_screenshot",
        text: "shot",
        screenshot: { mimeType: "image/png", data: "AAA" },
      },
      { onImageClick },
    );

    await userEvent.click(screen.getByAltText("Screenshot"));
    expect(onImageClick).toHaveBeenCalledWith("data:image/png;base64,AAA");
  });

  describe("rate_limited", () => {
    const event = { type: "rate_limited", text: "Rate limit reached.", retryAfterSeconds: 2 };

    it("shows a countdown and retries automatically when it hits zero", () => {
      vi.useFakeTimers();
      const onRetry = vi.fn();
      render(<Entry event={event} onImageClick={vi.fn()} onRetry={onRetry} isLatest />);

      expect(screen.getByText("Resuming in 2s…")).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(1000));
      expect(screen.getByText("Resuming in 1s…")).toBeInTheDocument();
      expect(onRetry).not.toHaveBeenCalled();

      act(() => vi.advanceTimersByTime(1000));
      expect(screen.getByText("Resuming…")).toBeInTheDocument();
      expect(onRetry).toHaveBeenCalledTimes(1);

      act(() => vi.advanceTimersByTime(5000));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it("defaults the countdown to 30s when the server sends no delay", () => {
      render(
        <Entry
          event={{ type: "rate_limited", text: "Rate limit reached." }}
          onImageClick={vi.fn()}
          onRetry={vi.fn()}
          isLatest
        />,
      );
      expect(screen.getByText("Resuming in 30s…")).toBeInTheDocument();
    });

    it("retries once on demand via the resume button", async () => {
      const onRetry = vi.fn();
      render(<Entry event={event} onImageClick={vi.fn()} onRetry={onRetry} isLatest />);

      await userEvent.click(screen.getByRole("button", { name: "Resume now" }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it("shows an older rate limit as resolved and never retries it", () => {
      vi.useFakeTimers();
      const onRetry = vi.fn();
      render(
        <Entry event={event} onImageClick={vi.fn()} onRetry={onRetry} isLatest={false} />,
      );

      expect(screen.getByText("Resolved")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(10_000));
      expect(onRetry).not.toHaveBeenCalled();
    });
  });
});
