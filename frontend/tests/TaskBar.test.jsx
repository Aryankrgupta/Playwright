import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import TaskBar from "../src/components/TaskBar.jsx";

function renderTaskBar(props = {}) {
  const handlers = {
    setTask: vi.fn(),
    onRun: vi.fn(),
    setTurbo: vi.fn(),
    setRecord: vi.fn(),
    ...props,
  };
  const view = render(
    <TaskBar
      task={props.task ?? ""}
      setTask={handlers.setTask}
      onRun={handlers.onRun}
      turbo={props.turbo ?? true}
      setTurbo={handlers.setTurbo}
      record={props.record ?? false}
      setRecord={handlers.setRecord}
    />,
  );
  return { ...view, ...handlers };
}

const textarea = () => screen.getByPlaceholderText(/Go to news.ycombinator.com/);

describe("TaskBar", () => {
  it("disables Run until the task has non-whitespace text", () => {
    renderTaskBar({ task: "   " });
    expect(screen.getByRole("button", { name: "Run task" })).toBeDisabled();
  });

  it("reports every keystroke to the parent", async () => {
    const { setTask } = renderTaskBar();
    await userEvent.type(textarea(), "hi");
    expect(setTask).toHaveBeenNthCalledWith(1, "h");
    expect(setTask).toHaveBeenNthCalledWith(2, "i");
  });

  it("runs the task on submit", async () => {
    const { onRun } = renderTaskBar({ task: "open example.com" });
    await userEvent.click(screen.getByRole("button", { name: "Run task" }));
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("runs the task on Enter", async () => {
    const { onRun } = renderTaskBar({ task: "open example.com" });
    await userEvent.type(textarea(), "{Enter}");
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("does not run on Shift+Enter", async () => {
    const { onRun } = renderTaskBar({ task: "open example.com" });
    await userEvent.type(textarea(), "{Shift>}{Enter}{/Shift}");
    expect(onRun).not.toHaveBeenCalled();
  });

  it("does not run an empty task on Enter", async () => {
    const { onRun } = renderTaskBar({ task: "  " });
    await userEvent.type(textarea(), "{Enter}");
    expect(onRun).not.toHaveBeenCalled();
  });

  it("toggles turbo and recording through the parent's setters", async () => {
    const { setTurbo, setRecord } = renderTaskBar({ turbo: true, record: false });

    expect(screen.getByRole("button", { name: /⚡ Turbo On/ })).toHaveClass("on");
    expect(screen.getByRole("button", { name: /Record Off/ })).not.toHaveClass("on");

    await userEvent.click(screen.getByRole("button", { name: /⚡ Turbo On/ }));
    await userEvent.click(screen.getByRole("button", { name: /Record Off/ }));

    expect(setTurbo.mock.calls[0][0](true)).toBe(false);
    expect(setRecord.mock.calls[0][0](false)).toBe(true);
  });

  it("fills the textarea from a suggestion chip", async () => {
    const { setTask } = renderTaskBar();
    const chip = document.querySelector(".suggestion-chip");
    await userEvent.click(chip);
    expect(setTask).toHaveBeenCalledWith(chip.textContent);
  });

  it("shows four suggestions and re-picks them when shuffled", async () => {
    // A constant Math.random makes the shuffle comparator constant, so each
    // pick is deterministic: 1 reverses the pool, 0 leaves it in order.
    const random = vi.spyOn(Math, "random").mockReturnValue(1);
    const shown = () =>
      [...document.querySelectorAll(".suggestion-chip")].map((c) => c.textContent);

    renderTaskBar();
    const before = shown();
    expect(before).toHaveLength(4);

    random.mockReturnValue(0);
    await userEvent.click(document.querySelector(".suggestion-shuffle"));

    expect(shown()).toHaveLength(4);
    expect(shown()).not.toEqual(before);
    random.mockRestore();
  });
});
