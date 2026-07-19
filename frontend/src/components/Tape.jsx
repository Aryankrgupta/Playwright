import { useEffect, useRef } from "react";
import Entry from "./Entry.jsx";

export default function Tape({ events, onImageClick, onRetry }) {
  const bottomRef = useRef(null);
  const hasMounted = useRef(false);

  useEffect(() => {
    if (!hasMounted.current) {
      // Skip the auto-scroll on first mount -- this fires right after a
      // page refresh when restored history already has events loaded, and
      // scrolling then drags the whole page down instead of just this tape.
      hasMounted.current = true;
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events.length]);

  return (
    <section className="tape-wrap">
      <div className="tape">
        {events.length === 0 && (
          <div className="tape-empty">
            <div className="tape-empty-glyph">◌</div>
            <div>No run yet. Give the agent a task above and watch the flight recorder fill in.</div>
          </div>
        )}
        {events.map((evt, i) => (
          <Entry
            key={i}
            event={evt}
            onImageClick={onImageClick}
            onRetry={onRetry}
            isLatest={i === events.length - 1}
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}