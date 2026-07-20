import { useEffect, useRef, useState } from "react";

const LABELS = {
  thought: "Thought",
  action: "Action",
  observation: "Observation",
  done: "Done",
  error: "Error",
  stopped: "Stopped",
  rate_limited: "Rate limited",
};

function RateLimitedEntry({ event, isLatest, onRetry }) {
  const [secondsLeft, setSecondsLeft] = useState(event.retryAfterSeconds ?? 30);
  const firedRef = useRef(false);

  useEffect(() => {
    if (!isLatest || secondsLeft <= 0) return;
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft, isLatest]);

  useEffect(() => {
    if (isLatest && secondsLeft <= 0 && !firedRef.current) {
      firedRef.current = true;
      onRetry();
    }
  }, [secondsLeft, isLatest, onRetry]);

  const handleManualRetry = () => {
    firedRef.current = true;
    onRetry();
  };

  return (
    <div className="entry rate_limited">
      <div className="entry-card">
        <div className="entry-label">{LABELS.rate_limited}</div>
        <div className="entry-body">{event.text}</div>
        {isLatest ? (
          secondsLeft > 0 ? (
            <div className="entry-retry-row">
              <span className="entry-retry-status">Resuming in {secondsLeft}s…</span>
              <button type="button" className="entry-retry-btn" onClick={handleManualRetry}>
                Resume now
              </button>
            </div>
          ) : (
            <div className="entry-retry-status">Resuming…</div>
          )
        ) : (
          <div className="entry-retry-status">Resolved</div>
        )}
      </div>
    </div>
  );
}

export default function Entry({ event, onImageClick, onRetry, isLatest }) {
  const { type } = event;

  if (type === "rate_limited") {
    return <RateLimitedEntry event={event} isLatest={isLatest} onRetry={onRetry} />;
  }

  if (type === "plan") {
    return (
      <div className="entry plan">
        <div className="entry-card">
          <div className="entry-label">Plan</div>
          <ol className="entry-plan-list">
            {event.subGoals.map((g) => (
              <li key={g.id}>{g.goal}</li>
            ))}
          </ol>
        </div>
      </div>
    );
  }

  if (type === "subgoal_start") {
    return (
      <div className="entry subgoal">
        <div className="entry-card">
          <div className="entry-label">Sub-goal {event.id}</div>
          <div className="entry-body">{event.goal}</div>
        </div>
      </div>
    );
  }

  if (type === "subgoal_done") {
    return (
      <div className="entry subgoal-done">
        <div className="entry-card">
          <div className="entry-label">✓ Sub-goal {event.id} done</div>
          <div className="entry-body">{event.summary}</div>
        </div>
      </div>
    );
  }

  if (type === "subgoal_failed") {
    return (
      <div className="entry subgoal-failed">
        <div className="entry-card">
          <div className="entry-label">✗ Sub-goal {event.id} failed</div>
          <div className="entry-body">{event.text}</div>
        </div>
      </div>
    );
  }

  if (type === "thought" || type === "done" || type === "error" || type === "stopped") {
    return (
      <div className={`entry ${type}`}>
        <div className="entry-card">
          <div className="entry-label">{LABELS[type]}</div>
          <div className="entry-body">{event.text}</div>
        </div>
      </div>
    );
  }

  if (type === "action") {
    const hasInput = event.input && Object.keys(event.input).length > 0;
    return (
      <div className="entry action">
        <div className="entry-card">
          <div className="entry-label">{LABELS.action}</div>
          <div className="entry-tool">{event.tool}(...)</div>
          {hasInput && <div className="entry-input">{JSON.stringify(event.input)}</div>}
        </div>
      </div>
    );
  }

  if (type === "provider_switch") {
    return (
      <div className="entry provider-switch">
        <div className="entry-card provider-switch-card">
          <span className="provider-chip">{event.from}</span>
          <span className="provider-arrow">⇄</span>
          <span className="provider-chip provider-chip-active">{event.to}</span>
        </div>
      </div>
    );
  }

  if (type === "recording") {
    return (
      <div className="entry recording">
        <div className="entry-card">
          <div className="entry-label">Recording</div>
          <video controls src={`${import.meta.env.VITE_API_BASE || "http://localhost:3000"}${event.url}`} style={{ maxWidth: "100%", borderRadius: "6px" }} />
        </div>
      </div>
    );
  }

  if (type === "observation") {
    const entryType = event.isError ? "error" : "observation";
    return (
      <div className={`entry ${entryType}`}>
        <div className="entry-card">
          <div className="entry-label">{LABELS.observation}</div>
          <div className="entry-tool">← {event.tool}</div>
          <div className="entry-obs-text">{event.text}</div>
          {event.screenshot && (
            <img
              className="thumb"
              src={`data:${event.screenshot.mimeType};base64,${event.screenshot.data}`}
              alt="Screenshot"
              onClick={() =>
                onImageClick(`data:${event.screenshot.mimeType};base64,${event.screenshot.data}`)
              }
            />
          )}
        </div>
      </div>
    );
  }

  return null;
}