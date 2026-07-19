import { useMemo, useState } from "react";

const SUGGESTION_POOL = [
  "Go to news.ycombinator.com and tell me the top 3 story titles right now",
  "Open wikipedia.org and search for Playwright (software)",
  "Go to google.com and search for latest AI news",
  "Open ycombinator.com and give me the top job listing",
  "Go to github.com/trending and list the top 3 repos today",
  "Open news.ycombinator.com/ask and tell me the top Ask HN post",
  "Go to producthunt.com and tell me today's #1 product",
  "Open amazon.com and search for wireless mouse, tell me the top result's price",
  "Go to weather.com and tell me today's forecast for New York",
  "Open imdb.com and tell me the top rated movie this week",
  "Go to bbc.com/news and summarize the top headline",
  "Open stackoverflow.com and search for 'react useEffect cleanup'",
];

const SUGGESTION_COUNT = 4;

function pickRandom(pool, count) {
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

export default function TaskBar({ task, setTask, onRun }) {
  const [seed, setSeed] = useState(0);
  const suggestions = useMemo(
    () => pickRandom(SUGGESTION_POOL, SUGGESTION_COUNT),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seed]
  );

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!task.trim()) return;
    onRun();
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (task.trim()) onRun();
    }
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
          onKeyDown={handleKeyDown}
        />
        <button type="submit" id="runBtn" disabled={!task.trim()}>
          Run task
        </button>
      </form>
      <div className="suggestions">
        {suggestions.map((s) => (
          <button type="button" key={s} className="suggestion-chip" onClick={() => setTask(s)}>
            {s}
          </button>
        ))}
        <button
          type="button"
          className="suggestion-shuffle"
          onClick={() => setSeed((n) => n + 1)}
          title="Show different suggestions"
        >
          ⟳
        </button>
      </div>
      <p className="hint">
        The agent narrates its thinking, shows every tool call it makes, and reports back what the browser returned. Tasks queue automatically if 3 are already running. Press Enter to run, Shift+Enter for a new line.
      </p>
    </section>
  );
}