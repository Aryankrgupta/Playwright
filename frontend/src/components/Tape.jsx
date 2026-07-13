import { useEffect, useRef } from "react";
import Entry from "./Entry.jsx";

export default function Tape({ events, onImageClick }) {
  const bottomRef = useRef(null);

  useEffect(() => {
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
          <Entry key={i} event={evt} onImageClick={onImageClick} />
        ))}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}
