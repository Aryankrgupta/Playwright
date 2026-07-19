import { useEffect, useRef, useState } from "react";
import Header from "./components/Header.jsx";
import TaskBar from "./components/TaskBar.jsx";
import RunPanel from "./components/RunPanel.jsx";
import HistorySidebar from "./components/HistorySidebar.jsx";
import Lightbox from "./components/Lightbox.jsx";
import { runTask, stopTask, resumeTask } from "./api.js";

const STORAGE_KEY = "wayfinder_history_v1";

function loadStoredRuns() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return parsed.map((r) =>
      r.running || r.queued
        ? {
            ...r,
            running: false,
            queued: false,
            stopping: false,
            queuePosition: null,
            events: [...r.events, { type: "stopped", text: "Interrupted by page reload." }],
          }
        : r
    );
  } catch {
    return [];
  }
}

export default function App() {
  const [task, setTask] = useState("");
  const [runs, setRuns] = useState(loadStoredRuns);
  const [lightboxSrc, setLightboxSrc] = useState(null);
  const nextId = useRef(runs.reduce((max, r) => Math.max(max, r.id + 1), 0));

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(runs));
    } catch {
      // ignore quota errors
    }
  }, [runs]);

  const updateRun = (id, patch) => {
    setRuns((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const handleRun = async () => {
    const currentTask = task.trim();
    if (!currentTask) return;

    const id = nextId.current++;
    setRuns((prev) => [
      ...prev,
      { id, taskId: null, task: currentTask, events: [], running: false, queued: true, queuePosition: null, stopping: false },
    ]);
    setTask("");

    try {
      await runTask(currentTask, (evt) => {
        if (evt.type === "queued") {
          updateRun(id, { taskId: evt.taskId, queued: true, running: false, queuePosition: evt.position });
          return;
        }
        if (evt.type === "start") {
          updateRun(id, { taskId: evt.taskId, queued: false, running: true, cached: !!evt.cached });
          return;
        }
        setRuns((prev) =>
          prev.map((r) => (r.id === id ? { ...r, events: [...r.events, evt] } : r))
        );
      });
    } catch (err) {
      setRuns((prev) =>
        prev.map((r) =>
          r.id === id
            ? { ...r, events: [...r.events, { type: "error", text: err.message || String(err) }] }
            : r
        )
      );
    } finally {
      updateRun(id, { running: false, queued: false, stopping: false });
    }
  };

  const handleStop = async (id, taskId) => {
    if (!taskId) return;
    updateRun(id, { stopping: true });
    try {
      await stopTask(taskId);
    } catch (err) {
      console.error("Failed to stop", err);
      updateRun(id, { stopping: false });
    }
  };

  const handleResume = async (id, taskId) => {
    if (!taskId) return;
    try {
      await resumeTask(taskId);
    } catch (err) {
      console.error("Failed to resume", err);
    }
  };

  const handleForceRefresh = async (id) => {
    const run = runs.find((r) => r.id === id);
    if (!run || run.running || run.queued) return;

    updateRun(id, { queued: true, running: false, taskId: null, events: [], cached: false });

    try {
      await runTask(
        run.task,
        (evt) => {
          if (evt.type === "queued") {
            updateRun(id, { taskId: evt.taskId, queued: true, running: false, queuePosition: evt.position });
            return;
          }
          if (evt.type === "start") {
            updateRun(id, { taskId: evt.taskId, queued: false, running: true, cached: !!evt.cached });
            return;
          }
          setRuns((prev) =>
            prev.map((r) => (r.id === id ? { ...r, events: [...r.events, evt] } : r))
          );
        },
        { forceRefresh: true }
      );
    } catch (err) {
      setRuns((prev) =>
        prev.map((r) =>
          r.id === id
            ? { ...r, events: [...r.events, { type: "error", text: err.message || String(err) }] }
            : r
        )
      );
    } finally {
      updateRun(id, { running: false, queued: false });
    }
  };

  const handleSelectHistory = (id) => {
    const el = document.getElementById(`run-${id}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("run-panel-flash");
      setTimeout(() => el.classList.remove("run-panel-flash"), 900);
    }
  };

  const handleClearHistory = () => {
    setRuns([]);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  return (
    <div className="page">
      <HistorySidebar runs={runs} onSelect={handleSelectHistory} onClear={handleClearHistory} />
      <div className="wrap">
        <Header running={runs.some((r) => r.running)} />
        <TaskBar task={task} setTask={setTask} onRun={handleRun} />
        {runs.length === 0 && (
          <section className="tape-wrap">
            <div className="tape">
              <div className="tape-empty">
                <div className="tape-empty-glyph">◌</div>
                <div>No run yet. Give the agent a task above and watch the flight recorder fill in.</div>
              </div>
            </div>
          </section>
        )}
        <div className="runs-grid">
          {[...runs].reverse().map((run) => (
            <div id={`run-${run.id}`} key={run.id}>
              <RunPanel
                run={run}
                onStop={() => handleStop(run.id, run.taskId)}
                onRetry={() => handleResume(run.id, run.taskId)}
                onForceRefresh={() => handleForceRefresh(run.id)}
                onImageClick={setLightboxSrc}
              />
            </div>
          ))}
        </div>
        <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      </div>
    </div>
  );
}