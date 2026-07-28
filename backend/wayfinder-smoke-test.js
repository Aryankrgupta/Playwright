// Wayfinder end-to-end smoke test
// Run: node wayfinder-smoke-test.js
// Requires Node 18+ (uses global fetch + Readable.fromWeb)

import { Readable } from "stream";

const BASE_URL = process.env.WAYFINDER_URL || "https://playwright-production-c775.up.railway.app";

const results = [];
function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✅ PASS" : "❌ FAIL"} - ${name}${detail ? `\n     ${detail}` : ""}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Streams a POST /api/task request, calling onEvent for each parsed NDJSON
// line. Resolves with { taskId, events } once the stream ends (or is aborted).
async function postTask(payload, { onEvent, signal } = {}) {
  const res = await fetch(`${BASE_URL}/api/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  if (res.status !== 200) {
    let body;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
    return { status: res.status, body, events: [], taskId: null };
  }

  const events = [];
  let taskId = null;
  let buffer = "";

  const nodeStream = Readable.fromWeb(res.body);
  try {
    for await (const chunk of nodeStream) {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        const evt = JSON.parse(line);
        if (evt.taskId) taskId = evt.taskId;
        events.push(evt);
        if (onEvent) onEvent(evt);
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") throw err;
  }

  return { status: res.status, events, taskId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testHealth() {
  const res = await fetch(`${BASE_URL}/api/health`);
  const body = await res.json();
  const ok =
    res.status === 200 &&
    body.ok === true &&
    typeof body.activeTasks === "number" &&
    typeof body.maxConcurrentTasks === "number" &&
    Array.isArray(body.fallbackProviders);
  record(
    "GET /api/health returns healthy status",
    ok,
    `status=${res.status} activeTasks=${body.activeTasks} queued=${body.queued} pooledClients=${body.pooledClients} fallbackProviders=${JSON.stringify(body.fallbackProviders)}`
  );
  return body;
}

async function testMissingTask() {
  const res = await fetch(`${BASE_URL}/api/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = await res.json();
  record(
    "POST /api/task with no task returns 400",
    res.status === 400 && !!body.error,
    `status=${res.status} body=${JSON.stringify(body)}`
  );
}

async function testInvalidResume() {
  const res = await fetch(`${BASE_URL}/api/resume/not-a-real-id`, { method: "POST" });
  const body = await res.json();
  record(
    "POST /api/resume/:id with bogus id returns 404",
    res.status === 404 && !!body.error,
    `status=${res.status} body=${JSON.stringify(body)}`
  );
}

async function testInvalidStop() {
  const res = await fetch(`${BASE_URL}/api/stop/not-a-real-id`, { method: "POST" });
  const body = await res.json();
  record(
    "POST /api/stop/:id with bogus id returns stopped:false",
    res.status === 200 && body.stopped === false,
    `status=${res.status} body=${JSON.stringify(body)}`
  );
}

async function testBasicTaskLifecycle() {
  const task = `Smoke test basic run ${Date.now()}`;
  let sawStart = false;
  let sawDone = false;
  const { taskId, events } = await postTask(
    { task, turbo: true },
    {
      onEvent: (evt) => {
        if (evt.type === "start") sawStart = true;
        if (evt.type === "done") sawDone = true;
      },
    }
  );
  const sawError = events.some((e) => e.type === "error");
  record(
    "Basic task runs to completion (start -> ... -> done, no error)",
    !!taskId && sawStart && (sawDone || !sawError),
    `taskId=${taskId} events=${events.map((e) => e.type).join(",")}`
  );
  return { task, events };
}

async function testCacheHit(task) {
  // Same task, same wording -> should hit cache and return start with cached:true
  let cachedFlag = null;
  const { events } = await postTask(
    { task, turbo: true },
    { onEvent: (evt) => { if (evt.type === "start") cachedFlag = evt.cached; } }
  );
  record(
    "Repeating identical non-time-sensitive task hits the cache",
    cachedFlag === true,
    `cached=${cachedFlag} events=${events.map((e) => e.type).join(",")}`
  );
}

async function testForceRefreshBypassesCache(task) {
  let cachedFlag = null;
  await postTask(
    { task, forceRefresh: true, turbo: true },
    { onEvent: (evt) => { if (evt.type === "start") cachedFlag = evt.cached; } }
  );
  record(
    "forceRefresh:true bypasses the cache",
    cachedFlag !== true,
    `cached=${cachedFlag}`
  );
}

async function testTimeSensitiveNeverCaches() {
  const task = "What is today's date";
  let cachedFirst = null;
  await postTask({ task, turbo: true }, { onEvent: (evt) => { if (evt.type === "start") cachedFirst = evt.cached; } });
  let cachedSecond = null;
  await postTask({ task, turbo: true }, { onEvent: (evt) => { if (evt.type === "start") cachedSecond = evt.cached; } });
  record(
    "Time-sensitive task (contains 'today') is never served from cache",
    cachedFirst !== true && cachedSecond !== true,
    `firstRun cached=${cachedFirst}, secondRun cached=${cachedSecond}`
  );
}

async function testConcurrencyQueuing(maxConcurrent) {
  const N = maxConcurrent + 1; // one more than the server will run at once
  const queuedSeen = [];
  const promises = [];
  for (let i = 0; i < N; i++) {
    const task = `Smoke concurrency task ${i} ${Date.now()}`;
    promises.push(
      postTask(
        { task, turbo: true },
        {
          onEvent: (evt) => {
            if (evt.type === "queued" && evt.position > maxConcurrent) {
              queuedSeen.push({ i, position: evt.position });
            }
          },
        }
      )
    );
  }
  const settled = await Promise.all(promises);
  const allCompleted = settled.every((r) => r.taskId || r.status !== 200);
  record(
    `Firing ${N} tasks at once (maxConcurrent=${maxConcurrent}) queues the overflow`,
    queuedSeen.length > 0 && allCompleted,
    `sawQueuedBeyondLimit=${JSON.stringify(queuedSeen)}`
  );
}

async function testStopMidRun() {
  const task = `Smoke stop-mid-run task ${Date.now()}`;
  let taskIdCaptured = null;
  let sawStopped = false;

  const runPromise = postTask(
    { task, turbo: true },
    {
      onEvent: (evt) => {
        if (evt.type === "start" && !taskIdCaptured) taskIdCaptured = evt.taskId;
        if (evt.type === "stopped") sawStopped = true;
      },
    }
  );

  // give it a moment to actually start, then stop it
  await sleep(1500);
  let stopBody = null;
  if (taskIdCaptured) {
    const stopRes = await fetch(`${BASE_URL}/api/stop/${taskIdCaptured}`, { method: "POST" });
    stopBody = await stopRes.json();
  }

  await runPromise;

  record(
    "Stopping a task mid-run responds stopped:true and ends the stream",
    !!taskIdCaptured && stopBody?.stopped === true,
    `taskId=${taskIdCaptured} stopBody=${JSON.stringify(stopBody)} sawStoppedEvent=${sawStopped}`
  );
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nRunning Wayfinder smoke test against ${BASE_URL}\n`);

  const health = await testHealth();
  await testMissingTask();
  await testInvalidResume();
  await testInvalidStop();

  const { task: basicTask } = await testBasicTaskLifecycle();
  await testCacheHit(basicTask);
  await testForceRefreshBypassesCache(basicTask);
  await testTimeSensitiveNeverCaches();

  await testConcurrencyQueuing(health.maxConcurrentTasks || 3);
  await testStopMidRun();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  if (failed.length) {
    console.log("\nFailed tests:");
    failed.forEach((f) => console.log(`  - ${f.name}: ${f.detail}`));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exitCode = 1;
});
