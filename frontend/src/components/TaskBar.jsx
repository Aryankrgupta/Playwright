export default function TaskBar({ task, setTask, running, onRun, onStop, stopping }) {
  const handleSubmit = (e) => {
    e.preventDefault();
    if (!task.trim() || running) return;
    onRun();
  };

  return (
    <section className="console">
      <form className="task-bar" onSubmit={handleSubmit}>
        <textarea
          id="taskInput"
          rows={2}
          placeholder="e.g. Go to news.ycombinator.com and tell me the top 3 story titles right now"
          value={task}
          onChange={(e) => setTask(e.target.value)}
        />
        {running ? (
          <button type="button" id="stopBtn" onClick={onStop} disabled={stopping}>
            {stopping ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button type="submit" id="runBtn">
            Run task
          </button>
        )}
      </form>
      <p className="hint">
        The agent narrates its thinking, shows every tool call it makes, and reports back what the browser returned.
      </p>
    </section>
  );
}
