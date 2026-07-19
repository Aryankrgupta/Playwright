import Tape from "./Tape.jsx";

export default function RunPanel({ run, onStop, onRetry, onForceRefresh, onImageClick }) {
  const { task, events, running, queued, queuePosition, stopping, cached } = run;
  const finished = !running && !queued;

  return (
    <section className="run-panel">
      <div className="run-panel-hdr">
        <div className="run-panel-task">
          {task}
          {cached && <span className="run-cached-badge">⚡ cached</span>}
        </div>
        {(running || queued) && (
          <button type="button" className="run-stop-btn" onClick={onStop} disabled={stopping}>
            {stopping ? "Stopping…" : queued ? "Cancel" : "Stop"}
          </button>
        )}
        {finished && cached && (
          <button type="button" className="run-refresh-btn" onClick={onForceRefresh}>
            ⟳ Force refresh
          </button>
        )}
      </div>
      {queued && (
        <div className="run-queued-banner">
          Queued{queuePosition ? ` — position ${queuePosition}` : ""}, waiting for a free slot…
        </div>
      )}
      <Tape events={events} onImageClick={onImageClick} onRetry={onRetry} />
    </section>
  );
}