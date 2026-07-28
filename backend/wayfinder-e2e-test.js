#!/usr/bin/env node
/**
 * Wayfinder end-to-end test script.
 *
 * Exercises the live backend (/api/task, /api/stop, /api/resume, /api/health)
 * to sanity-check the core behaviors: basic run, queueing/concurrency,
 * caching, recording, and stop/cancel.
 *
 * Usage:
 *   node wayfinder-e2e-test.js                 # runs all scenarios
 *   node wayfinder-e2e-test.js basic            # just one scenario
 *   node wayfinder-e2e-test.js concurrency
 *   node wayfinder-e2e-test.js cache
 *   node wayfinder-e2e-test.js record
 *   node wayfinder-e2e-test.js stop
 *
 * Env:
 *   API_BASE (default http://localhost:3000)
 *
 * Requires Node 18+ (built-in fetch).
 */

const API_BASE = process.env.API_BASE || "http://localhost:3000";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(label, ...args) {
  const ts = new Date().toISOString().split("T")[1].replace("Z", "");
  console.log(`[${ts}] ${label}`, ...args);
}

function pass(msg) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

function fail(msg) {
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
}

function section(title) {
  console.log(`\n\x1b[1m=== ${title} ===\x1b[0m`);
}

/**
 * POSTs a task and streams NDJSON events, calling onEvent for each one.
 * Resolves with { events, elapsedMs, taskId } once the stream ends.
 */
async function runTask(task, options = {}, onEvent = () => {}) {
  const start = Date.now();
  const res = await fetch(`${API_BASE}/api/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task,
      forceRefresh: !!options.forceRefresh,
      turbo: options.turbo !== false,
      record: !!options.record,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || `Request failed (${res.status})`);
  }

  const events = [];
  let taskId = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (evt.taskId) taskId = evt.taskId;
      events.push(evt);
      onEvent(evt);
    }
  }

  return { events, elapsedMs: Date.now() - start, taskId };
}

async function stopTask(taskId) {
  const res = await fetch(`${API_BASE}/api/stop/${taskId}`, { method: "POST" });
  return res.json();
}

async function health() {
  const res = await fetch(`${API_BASE}/api/health`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioBasic() {
  section("Basic single task run");
  const task = "Go to wikipedia.org and search for Playwright (software)";
  log("Running:", task);

  const seen = new Set();
  const { events, elapsedMs } = await runTask(task, { turbo: false }, (evt) => {
    seen.add(evt.type);
    log(`  event: ${evt.type}`, evt.type === "action" ? evt.tool : "");
  });

  const done = events.find((e) => e.type === "done");
  const hasPlan = seen.has("plan");
  const hasAction = seen.has("action") || seen.has("observation");

  if (done) pass(`Task completed in ${elapsedMs}ms: "${done.text?.slice(0, 80)}..."`);
  else fail("No 'done' event received");

  if (hasPlan) pass("Received sub-goal plan");
  else fail("No 'plan' event received");

  if (hasAction) pass("Saw at least one browser action/observation");
  else fail("No action/observation events -- agent may not have used the browser");
}

async function scenarioConcurrency() {
  section("Concurrency / queueing (fires 4 tasks against MAX_CONCURRENT_TASKS=3)");

  const tasks = [
    "Go to news.ycombinator.com and tell me the top story title",
    "Go to wikipedia.org and search for Node.js",
    "Go to github.com/trending and list the top repo",
    "Go to bbc.com/news and summarize the top headline",
  ];

  const results = [];
  const runs = tasks.map((task, i) =>
    runTask(task, { turbo: false }, (evt) => {
      if (evt.type === "queued") {
        log(`  task ${i}: queued at position ${evt.position}`);
      }
      if (evt.type === "start") {
        log(`  task ${i}: started${evt.cached ? " (cached)" : ""}`);
      }
    }).then((r) => {
      results[i] = r;
      log(`  task ${i}: finished in ${r.elapsedMs}ms`);
    })
  );

  await Promise.all(runs);

  const sawQueued = results.some((r) => r.events.some((e) => e.type === "queued" && e.position > 1));
  if (sawQueued) pass("At least one task was queued behind others (concurrency limit respected)");
  else fail("No task showed a queue position > 1 -- concurrency limit may not be enforced, or tasks finished too fast to observe queueing");

  const allDone = results.every((r) => r.events.some((e) => e.type === "done" || e.type === "error"));
  if (allDone) pass("All 4 tasks reached a terminal state (done/error)");
  else fail("Some task never reached done/error");
}

async function scenarioCache() {
  section("Result caching");
  const task = "Go to wikipedia.org and search for TypeScript";

  log("First run (cold)...");
  const first = await runTask(task, { turbo: false, forceRefresh: true });
  const firstDone = first.events.find((e) => e.type === "start");
  log(`  first run: ${first.elapsedMs}ms, cached=${!!firstDone?.cached}`);

  log("Second run (should hit cache)...");
  const second = await runTask(task, { turbo: false });
  const secondStart = second.events.find((e) => e.type === "start");
  log(`  second run: ${second.elapsedMs}ms, cached=${!!secondStart?.cached}`);

  if (secondStart?.cached) pass("Second identical run returned cached=true");
  else fail("Second run was not marked cached -- check isTimeSensitive() isn't matching, and TTL hasn't expired");

  if (second.elapsedMs < first.elapsedMs / 2) pass(`Cached run was meaningfully faster (${second.elapsedMs}ms vs ${first.elapsedMs}ms)`);
  else fail(`Cached run wasn't much faster (${second.elapsedMs}ms vs ${first.elapsedMs}ms) -- worth a look`);

  log("Time-sensitive task (should skip cache)...");
  const tsTask = "Go to weather.com and tell me today's forecast for New York right now";
  await runTask(tsTask, { turbo: false, forceRefresh: true });
  const tsSecond = await runTask(tsTask, { turbo: false });
  const tsStart = tsSecond.events.find((e) => e.type === "start");
  if (!tsStart?.cached) pass("Time-sensitive task correctly bypassed cache");
  else fail("Time-sensitive task was cached -- isTimeSensitive() pattern may need adjusting");
}

async function scenarioRecord() {
  section("Recording");
  const task = "Go to wikipedia.org and search for WebM";
  log("Running with record: true ...");

  let recordingEvent = null;
  const { elapsedMs } = await runTask(task, { turbo: false, record: true }, (evt) => {
    if (evt.type === "recording") recordingEvent = evt;
  });

  if (recordingEvent) {
    pass(`Recording event received: ${recordingEvent.url}`);
    try {
      const videoRes = await fetch(`${API_BASE}${recordingEvent.url}`);
      if (videoRes.ok) pass(`Video URL is reachable (status ${videoRes.status})`);
      else fail(`Video URL returned status ${videoRes.status}`);
    } catch (err) {
      fail(`Could not fetch video URL: ${err.message}`);
    }
  } else {
    fail("No 'recording' event received -- check backend console for 'No recording found for task ...'");
  }
  log(`  total time: ${elapsedMs}ms (expect slower than pooled runs -- recording bypasses the browser pool)`);
}

async function scenarioStop() {
  section("Stop / cancel mid-run");
  const task = "Go to news.ycombinator.com and read every comment on the top 5 posts";

  let taskId = null;
  const runPromise = runTask(task, { turbo: false }, (evt) => {
    if (evt.type === "start") taskId = evt.taskId;
  });

  // give it a moment to actually start before stopping
  await sleep(1500);

  if (!taskId) {
    fail("Task never emitted a 'start' event within 1.5s -- can't test stop mid-run");
    return;
  }

  log(`Stopping task ${taskId} mid-run...`);
  const stopResult = await stopTask(taskId);
  if (stopResult.stopped) pass("Stop endpoint acknowledged the stop");
  else fail(`Stop endpoint returned stopped=false: ${stopResult.message}`);

  const { events } = await runPromise;
  const stoppedEvent = events.find((e) => e.type === "stopped");
  if (stoppedEvent) pass("Stream ended with a 'stopped' event");
  else fail("Stream did not end with a 'stopped' event -- task may have kept running server-side");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const scenarios = {
  basic: scenarioBasic,
  concurrency: scenarioConcurrency,
  cache: scenarioCache,
  record: scenarioRecord,
  stop: scenarioStop,
};

async function main() {
  const arg = process.argv[2];

  log("API_BASE =", API_BASE);
  try {
    const h = await health();
    log("Health check OK:", JSON.stringify(h));
  } catch (err) {
    console.error(`\nCould not reach backend at ${API_BASE}. Is it running? (${err.message})`);
    process.exit(1);
  }

  const toRun = arg && scenarios[arg] ? [arg] : Object.keys(scenarios);
  if (arg && !scenarios[arg]) {
    console.error(`Unknown scenario "${arg}". Options: ${Object.keys(scenarios).join(", ")}`);
    process.exit(1);
  }

  for (const name of toRun) {
    try {
      await scenarios[name]();
    } catch (err) {
      fail(`Scenario "${name}" threw: ${err.message}`);
    }
  }

  console.log("\nDone.");
}

main();
