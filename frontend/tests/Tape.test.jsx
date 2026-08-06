import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Tape from "../src/components/Tape.jsx";
import Lightbox from "../src/components/Lightbox.jsx";
import Header from "../src/components/Header.jsx";

describe("Tape", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("shows the empty state when there are no events", () => {
    render(<Tape events={[]} onImageClick={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByText(/No run yet/)).toBeInTheDocument();
  });

  it("renders one entry per event in order", () => {
    render(
      <Tape
        events={[
          { type: "thought", text: "first" },
          { type: "action", tool: "browser_navigate", input: {} },
          { type: "done", text: "last" },
        ]}
        onImageClick={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByText("browser_navigate(...)")).toBeInTheDocument();
    expect(screen.getByText("last")).toBeInTheDocument();
    expect(screen.queryByText(/No run yet/)).toBeNull();
  });

  it("does not auto-scroll on first mount, but does when an event arrives", () => {
    const { rerender } = render(
      <Tape events={[{ type: "thought", text: "a" }]} onImageClick={vi.fn()} onRetry={vi.fn()} />,
    );
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

    rerender(
      <Tape
        events={[
          { type: "thought", text: "a" },
          { type: "done", text: "b" },
        ]}
        onImageClick={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "end",
    });
  });

  it("marks only the last entry as latest", () => {
    render(
      <Tape
        events={[
          { type: "rate_limited", text: "older limit", retryAfterSeconds: 5 },
          { type: "rate_limited", text: "current limit", retryAfterSeconds: 5 },
        ]}
        onImageClick={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("Resolved")).toBeInTheDocument();
    expect(screen.getByText("Resuming in 5s…")).toBeInTheDocument();
  });
});

describe("Lightbox", () => {
  it("renders nothing without a source", () => {
    const { container } = render(<Lightbox src={null} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the image and closes on click", async () => {
    const onClose = vi.fn();
    const { container } = render(
      <Lightbox src="data:image/png;base64,AAA" onClose={onClose} />,
    );

    expect(screen.getByAltText("Screenshot")).toHaveAttribute(
      "src",
      "data:image/png;base64,AAA",
    );
    container.querySelector(".lightbox").click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Header", () => {
  it("marks the status dot live only while a run is active", () => {
    const { container, rerender } = render(<Header running={false} />);
    expect(screen.getByText("WAYFINDER")).toBeInTheDocument();
    expect(container.querySelector(".hdr-dot")).not.toHaveClass("live");

    rerender(<Header running />);
    expect(container.querySelector(".hdr-dot")).toHaveClass("live");
  });
});
