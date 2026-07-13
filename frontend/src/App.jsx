import { useState } from "react";
import Header from "./components/Header.jsx";
import TaskBar from "./components/TaskBar.jsx";
import Tape from "./components/Tape.jsx";
import Lightbox from "./components/Lightbox.jsx";
import { runTask, stopTask } from "./api.js";

export default function App() {
  const [task, setTask] = useState("");
  const [events, setEvents] = useState([]);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState(null);

  const handleRun = async () => {
    const currentTask = task.trim();
    if (!currentTask || running) return;

    setRunning(true);
    try {
      await runTask(currentTask, (evt) => {
        if (evt.type === "start") return;
        setEvents((prev) => [...prev, evt]);
      });
    } catch (err) {
      setEvents((prev) => [...prev, { type: "error", text: err.message || String(err) }]);
    } finally {
      setRunning(false);
      setStopping(false);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    try {
      await stopTask();
    } catch (err) {
      console.error("Failed to stop", err);
      setStopping(false);
    }
  };

  return (
    <div className="wrap">
      <Header running={running} />
      <TaskBar
        task={task}
        setTask={setTask}
        running={running}
        stopping={stopping}
        onRun={handleRun}
        onStop={handleStop}
      />
      <Tape events={events} onImageClick={setLightboxSrc} />
      <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
    </div>
  );
}
