const LABELS = {
  thought: "Thought",
  action: "Action",
  observation: "Observation",
  done: "Done",
  error: "Error",
  stopped: "Stopped",
};

export default function Entry({ event, onImageClick }) {
  const { type } = event;

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
