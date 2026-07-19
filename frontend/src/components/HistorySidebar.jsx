const STATUS_LABEL = {
  running: "Running",
  queued: "Queued",
  done: "Done",
  error: "Error",
  stopped: "Stopped",
};

function getStatus(run) {
  if (run.running) return "running";
  if (run.queued) return "queued";
  const last = run.events[run.events.length - 1];
  if (last?.type === "error") return "error";
  if (last?.type === "stopped") return "stopped";
  return "done";
}

export default function HistorySidebar({ runs, onSelect }) {
  const ordered = [...runs].reverse();

  return (
    <aside className="history-sidebar">
      <div className="history-title">History</div>
      {ordered.length === 0 && <div className="history-empty">No tasks yet</div>}
      <ul className="history-list">
        {ordered.map((run) => {
          const status = getStatus(run);
          return (
            <li key={run.id}>
              <button type="button" className="history-item" onClick={() => onSelect(run.id)}>
                <span className={`history-dot history-dot-${status}`} />
                <span className="history-item-text">{run.task}</span>
                <span className="history-item-status">{STATUS_LABEL[status]}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}