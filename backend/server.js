import "dotenv/config";
import crypto from "crypto";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PORT = process.env.PORT || 3000;
const MODEL = process.env.CEREBRAS_MODEL || "gpt-oss-120b";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const MAX_CONCURRENT_TASKS = 3;
const POOL_SIZE = 2;
const RESULT_CACHE_TTL_MS = 10 * 60 * 1000;
const RESULT_CACHE_MAX = 50;
const SUBGOAL_MAX_STEPS = 15;

if (!process.env.CEREBRAS_API_KEY) {
  console.error("Missing CEREBRAS_API_KEY. Copy .env.example to .env and add your key from https://cloud.cerebras.ai/");
  process.exit(1);
}

const cerebras = new OpenAI({
  apiKey: process.env.CEREBRAS_API_KEY,
  baseURL: "https://api.cerebras.ai/v1",
});

const FALLBACK_TIMEOUT_MS = 10000; // if Cerebras hasn't responded in 10s, try Groq instead
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const groqEnabled = !!process.env.GROQ_API_KEY;

const groq = groqEnabled
  ? new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" })
  : null;

if (!groqEnabled) {
  console.log("[fallback] GROQ_API_KEY not set -- Groq fallback disabled, Cerebras-only mode.");
}

// ---------------------------------------------------------------------------
// Timing helpers -- lightweight, console-only instrumentation. No new
// dependencies; just labeled start/end timestamps so Railway logs show
// exactly where time goes on each task.
// ---------------------------------------------------------------------------

function timer(label) {
  const start = Date.now();
  return {
    end(extra = "") {
      const ms = Date.now() - start;
      console.log(`[timing] ${label}: ${ms}ms${extra ? ` (${extra})` : ""}`);
      return ms;
    },
  };
}

// Races a Cerebras call against a timeout. If Cerebras is too slow, or
// errors (including 429), retries the SAME request against Groq instead of
// waiting it out or failing outright. Returns { completion, provider }.
// Throws only if both providers fail (or Groq is unavailable and Cerebras
// itself failed).
async function createCompletionWithFallback(label, params, signal) {
  const cerebrasTimer = timer(`${label}: cerebras call`);
  const cerebrasAttempt = cerebras.chat.completions.create({ model: MODEL, ...params }, { signal })
    .then((result) => ({ ok: true, result }))
    .catch((err) => ({ ok: false, err }));

  if (!groqEnabled) {
    const outcome = await cerebrasAttempt;
    if (outcome.ok) {
      cerebrasTimer.end();
      return { completion: outcome.result, provider: "cerebras" };
    }
    cerebrasTimer.end("errored");
    throw outcome.err;
  }

  const timeoutMarker = Symbol("timeout");
  const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(timeoutMarker), FALLBACK_TIMEOUT_MS));

  const race = await Promise.race([cerebrasAttempt, timeoutPromise]);

  if (race !== timeoutMarker && race.ok) {
    cerebrasTimer.end();
    return { completion: race.result, provider: "cerebras" };
  }

  const reason =
    race === timeoutMarker
      ? `slow (>${FALLBACK_TIMEOUT_MS}ms), falling back to Groq`
      : race.err?.status === 429
      ? "rate-limited, falling back to Groq"
      : "errored, falling back to Groq";
  cerebrasTimer.end(reason);

  const groqTimer = timer(`${label}: groq fallback call`);
  try {
    const groqResult = await groq.chat.completions.create({ model: GROQ_MODEL, ...params }, { signal });
    groqTimer.end();
    return { completion: groqResult, provider: "groq" };
  } catch (groqErr) {
    groqTimer.end("errored, bouncing back to Cerebras");

    // Groq has its own quirks (e.g. Llama sometimes emits malformed raw
    // function-call text that Groq's own validator then rejects as "not in
    // request.tools" even though it is). Rather than dying here, give
    // Cerebras one more real attempt -- if the first Cerebras call only
    // failed because it was SLOW, a fresh attempt now may well succeed.
    const bounceTimer = timer(`${label}: cerebras bounce-back call`);
    try {
      const bounceResult = await cerebras.chat.completions.create({ model: MODEL, ...params }, { signal });
      bounceTimer.end();
      return { completion: bounceResult, provider: "cerebras" };
    } catch (bounceErr) {
      bounceTimer.end("errored");
      // Both providers genuinely failed twice over -- surface the most
      // recent, most relevant error (the bounce-back attempt) rather than
      // the original timeout, since it's the freshest signal of what's
      // actually wrong right now.
      throw bounceErr;
    }
  }
}

// Cerebras's gpt-oss model attaches extra non-standard fields (like
// `reasoning`) to assistant messages. Groq's API rejects those fields
// outright, so any message pushed into the shared conversation history
// must be stripped down to the standard OpenAI shape first -- otherwise a
// mid-task fallback to Groq fails with a 400 on the very next call.
function sanitizeAssistantMessage(msg) {
  const clean = { role: msg.role, content: msg.content ?? null };
  if (msg.tool_calls) clean.tool_calls = msg.tool_calls;
  return clean;
}

function parseRetrySeconds(err) {
  const headers = err?.headers || err?.response?.headers;
  if (!headers) return null;

  const getHeader = (name) =>
    typeof headers.get === "function" ? headers.get(name) : headers[name];

  const resetKeys = [
    "x-ratelimit-reset-tokens-minute",
    "x-ratelimit-reset-requests-minute",
    "x-ratelimit-reset-tokens-hour",
    "x-ratelimit-reset-requests-hour",
    "x-ratelimit-reset-tokens-day",
    "x-ratelimit-reset-requests-day",
    "retry-after",
  ];

  let maxSeconds = null;
  for (const key of resetKeys) {
    const value = getHeader(key);
    if (value === undefined || value === null) continue;
    const num = parseFloat(value);
    if (!Number.isNaN(num) && (maxSeconds === null || num > maxSeconds)) {
      maxSeconds = num;
    }
  }

  return maxSeconds !== null ? Math.ceil(maxSeconds) : null;
}

// ---------------------------------------------------------------------------
// Result cache
// ---------------------------------------------------------------------------

const resultCache = new Map();

// Tasks that ask for "current" information shouldn't be cached at all --
// serving a 5-minute-old cached answer to "what's the top story right now"
// could be silently wrong.
const TIME_SENSITIVE_PATTERN = /\b(right now|today|current(ly)?|latest|live|this (week|month|hour)|now\b)/i;

function isTimeSensitive(task) {
  return TIME_SENSITIVE_PATTERN.test(task);
}

function cacheKey(task) {
  return task.trim().toLowerCase();
}

function getCached(task) {
  const key = cacheKey(task);
  const entry = resultCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    resultCache.delete(key);
    return null;
  }
  return entry.events;
}

function setCached(task, events) {
  const key = cacheKey(task);
  if (resultCache.size >= RESULT_CACHE_MAX && !resultCache.has(key)) {
    const oldestKey = resultCache.keys().next().value;
    resultCache.delete(oldestKey);
  }
  resultCache.set(key, { events, expiresAt: Date.now() + RESULT_CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Playwright MCP sessions, queue, pool, and paused (rate-limited) tasks
// ---------------------------------------------------------------------------

let activeCount = 0;
const activeTasks = new Map();  // taskId -> { abortController, client }
const queue = [];               // { taskId, task, send, res, abortController, cancelled, skipCache }
const pool = [];                // pre-warmed idle MCP clients
const pausedTasks = new Map();  // taskId -> { task, client, state, send, res, abortController, skipCache }

let cachedTools = null;

async function spawnMcpClient() {
  const args = [
    "@playwright/mcp",
    "--browser", "chrome",
    "--isolated",
    "--timeout-navigation", "15000",
  ];
  if (process.env.PLAYWRIGHT_HEADED !== "true") args.push("--headless");
  const transport = new StdioClientTransport({
    command: "npx",
    args,
  });

  const client = new Client({ name: "playwright-llm-agent", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function fillPool() {
  while (pool.length < POOL_SIZE) {
    try {
      const client = await spawnMcpClient();
      pool.push(client);
    } catch (err) {
      console.error("Failed to pre-warm MCP client for pool", err);
      break;
    }
  }
}

async function getClientFast() {
  const t = timer("browser acquisition");
  let client;
  const fromPool = pool.length > 0;
  if (fromPool) {
    client = pool.shift();
  } else {
    client = await spawnMcpClient();
  }
  t.end(fromPool ? "from pool" : "cold spawn");
  fillPool();
  return client;
}

async function getTools(client) {
  if (cachedTools) return cachedTools;
  const { tools } = await client.listTools();
  cachedTools = tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || t.name,
      parameters: t.inputSchema || { type: "object", properties: {} },
    },
  }));
  return cachedTools;
}

function broadcastQueuePositions() {
  queue.forEach((item, i) => {
    item.send({ type: "queued", taskId: item.taskId, position: i + 1, queueLength: queue.length });
  });
}

function summarizeMcpResult(result) {
  const items = result?.content || [];
  const text = items
    .filter((i) => i.type === "text")
    .map((i) => i.text)
    .join("\n")
    .slice(0, 4000);
  const screenshot = items.find((i) => i.type === "image");
  return {
    text: text || (screenshot ? "(screenshot captured -- shown to the user, not visible to you)" : "(no text output)"),
    screenshot: screenshot ? { data: screenshot.data, mimeType: screenshot.mimeType || "image/png" } : null,
    isError: !!result?.isError,
  };
}

const SYSTEM_PROMPT = `You are a browser automation agent. You control a real web browser through Playwright tools to
complete one specific sub-goal at a time, as part of a larger task.

Guidelines:
- You are only responsible for the CURRENT sub-goal given to you, not the whole task. Focus only on it.
- Use the browser tools to navigate, click, type, and read pages.
- A sub-goal that only asks you to navigate to a URL is complete as soon as browser_navigate succeeds and the page
  has loaded -- do not take extra verification steps (snapshots, screenshots, re-checks) unless the sub-goal
  explicitly asks you to read or extract something from the page.
- You cannot see screenshots yourself -- use the accessibility snapshot / page content tools to read what's on the
  page and find elements. Only take a screenshot when the user would benefit from seeing one; it will be shown to
  them, not to you.
- Before dismissing or closing any dialog, popup, or overlay, check whether it's actually relevant to your current
  sub-goal (e.g. a "location search" dialog when your task involves finding a location) -- it may BE the tool you
  need, not an obstacle. Only dismiss things that are clearly unrelated (ads, cookie banners, unrelated promos).
- browser_find only matches EXACT text or regex that is already visible in the page's accessibility snapshot. It is
  not a semantic search -- if you guess a word without having seen it appear on the page, it will likely return "No
  matches found." Before calling browser_find, prefer to have already taken a snapshot (or navigated) so you know
  what text is actually present. If you don't know the exact label of an input (e.g. a search box), consider using
  a snapshot to find its accessible name/role instead of guessing a generic word like "Search".
- If repeated browser_find calls with different guessed words all return no matches, stop guessing text and instead
  take a full-page snapshot (avoid limiting depth) to see interactive elements like icon-only buttons that have no
  visible text -- then click the relevant one directly by its ref, rather than continuing to guess words.
- browser_find's regex mode does not support inline flags like (?i) -- use plain patterns or explicit character
  classes instead (e.g. "[Ss]earch" rather than "(?i)search").
- When using browser_find, you must always provide either "text" or "regex" -- never call it with neither.
- If a page requires login credentials you don't have, stop and explain that instead of guessing.
- When the current sub-goal is complete, reply with a concise summary of what you found or did for THIS sub-goal
  only. Do not call any more tools once you give that summary.
- If you get stuck after several attempts on this sub-goal, explain what's blocking you instead of repeating the
  same failing action.`;

const PLAN_SYSTEM_PROMPT = `You are a task planner for a browser automation agent. Given a user's task, break it
into 2-5 concrete, sequential sub-goals that together accomplish it. Each sub-goal should be a single, well-scoped
piece of work (e.g. "Navigate to X", "Find Y on the page", "Extract Z").

Respond with ONLY a JSON array, no other text, no markdown fences. Format:
[{"goal": "short imperative description of sub-goal 1"}, {"goal": "short imperative description of sub-goal 2"}]`;

function tryParsePlan(text) {
  try {
    const cleaned = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((p) => p && typeof p.goal === "string")) {
      return parsed.map((p, i) => ({ id: i + 1, goal: p.goal, status: "pending" }));
    }
  } catch {
    // fall through
  }
  return null;
}

// `state` shape:
// {
//   task,
//   subGoals: null | [{ id, goal, status: pending|in-progress|done|failed, summary? }],
//   currentIndex: number,
//   currentMessages: [] | null,   -- conversation for the sub-goal in progress
//   currentStep: number,
//   currentProvider: null | "cerebras" | "groq",
// }
async function* runAgent(state, client, tools, signal) {
  if (!state.subGoals) {
    if (signal.aborted) {
      yield { type: "stopped", text: "Stopped by user." };
      return;
    }

    try {
      const { completion: planCompletion, provider } = await createCompletionWithFallback(
        "planning",
        {
          messages: [
            { role: "system", content: PLAN_SYSTEM_PROMPT },
            { role: "user", content: state.task },
          ],
          tool_choice: "none",
          max_tokens: 500,
        },
        signal
      );

      if (state.currentProvider && state.currentProvider !== provider) {
        yield { type: "provider_switch", from: state.currentProvider, to: provider };
      }
      state.currentProvider = provider;

      const raw = planCompletion.choices[0]?.message?.content || "";
      const parsed = tryParsePlan(raw);
      state.subGoals = parsed || [{ id: 1, goal: state.task, status: "pending" }];
    } catch (err) {
      if (signal.aborted) {
        yield { type: "stopped", text: "Stopped by user." };
        return;
      }
      const status = err?.status || err?.response?.status;
      const retryAfterSeconds = parseRetrySeconds(err);
      if (status === 429 || retryAfterSeconds !== null) {
        yield {
          type: "rate_limited",
          text: err?.error?.message || err?.message || "Rate limit reached on both providers.",
          retryAfterSeconds: retryAfterSeconds ?? 30,
        };
        return;
      }
      state.subGoals = [{ id: 1, goal: state.task, status: "pending" }];
    }

    yield { type: "plan", subGoals: state.subGoals.map((g) => ({ id: g.id, goal: g.goal })) };
    state.currentIndex = 0;
  }

  for (let i = state.currentIndex; i < state.subGoals.length; i++) {
    state.currentIndex = i;
    const subGoal = state.subGoals[i];

    if (subGoal.status === "done") continue;

    if (!state.currentMessages) {
      const priorSummaries = state.subGoals
        .slice(0, i)
        .filter((g) => g.status === "done" && g.summary)
        .map((g) => `- ${g.goal}: ${g.summary}`)
        .join("\n");

      state.currentMessages = [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: priorSummaries
            ? `Overall task: ${state.task}\n\nProgress so far:\n${priorSummaries}\n\nYour current sub-goal: ${subGoal.goal}`
            : `Overall task: ${state.task}\n\nYour current sub-goal: ${subGoal.goal}`,
        },
      ];
      state.currentStep = 0;
    }

    subGoal.status = "in-progress";
    yield { type: "subgoal_start", id: subGoal.id, goal: subGoal.goal };

    const subGoalTimer = timer(`sub-goal ${subGoal.id} ("${subGoal.goal}")`);
    const stepsBefore = state.currentStep;
    const result = yield* runSubGoal(state, client, tools, signal);
    const stepsUsed = state.currentStep - stepsBefore + 1;

    if (result === "rate_limited") {
      subGoalTimer.end(`paused on rate limit after ${stepsUsed} steps`);
      return;
    }
    if (result === "stopped") {
      subGoalTimer.end(`stopped after ${stepsUsed} steps`);
      return;
    }

    if (result.ok) {
      subGoalTimer.end(`done, ${stepsUsed} steps used`);
      subGoal.status = "done";
      subGoal.summary = result.summary;
      yield { type: "subgoal_done", id: subGoal.id, goal: subGoal.goal, summary: result.summary };
      state.currentMessages = null;
    } else {
      subGoalTimer.end(`failed, ${stepsUsed} steps used`);
      subGoal.status = "failed";
      yield { type: "subgoal_failed", id: subGoal.id, goal: subGoal.goal, text: result.summary };
      yield { type: "done", text: `Stopped: sub-goal "${subGoal.goal}" could not be completed. ${result.summary}` };
      return;
    }
  }

  const finalSummary = state.subGoals
    .filter((g) => g.summary)
    .map((g) => g.summary)
    .join(" ");
  yield { type: "done", text: finalSummary || "Task complete." };
}

// Runs the ReAct loop for ONE sub-goal only, bounded by SUBGOAL_MAX_STEPS.
// Returns "rate_limited" | "stopped" | { ok: bool, summary: string }.
async function* runSubGoal(state, client, tools, signal) {
  const messages = state.currentMessages;

  for (let step = state.currentStep; step < SUBGOAL_MAX_STEPS; step++) {
    state.currentStep = step;

    if (signal.aborted) {
      yield { type: "stopped", text: "Stopped by user." };
      return "stopped";
    }

    let completion;
    try {
      const result = await createCompletionWithFallback(
        `step ${step}`,
        { messages, tools, tool_choice: "auto", max_tokens: 2048 },
        signal
      );
      completion = result.completion;

      if (state.currentProvider && state.currentProvider !== result.provider) {
        yield { type: "provider_switch", from: state.currentProvider, to: result.provider };
      }
      state.currentProvider = result.provider;
    } catch (err) {
      if (signal.aborted) {
        yield { type: "stopped", text: "Stopped by user." };
        return "stopped";
      }
      const status = err?.status || err?.response?.status;
      const retryAfterSeconds = parseRetrySeconds(err);
      if (status === 429 || retryAfterSeconds !== null) {
        yield {
          type: "rate_limited",
          text: err?.error?.message || err?.message || "Rate limit reached on both providers.",
          retryAfterSeconds: retryAfterSeconds ?? 30,
        };
        return "rate_limited";
      }
      throw err;
    }

    const msg = completion.choices[0].message;
    messages.push(sanitizeAssistantMessage(msg));

    if (msg.content && msg.content.trim()) {
      yield { type: "thought", text: msg.content.trim() };
    }

    const toolCalls = msg.tool_calls || [];

    if (toolCalls.length === 0) {
      return { ok: true, summary: msg.content || "Done." };
    }

    for (const call of toolCalls) {
      if (signal.aborted) {
        yield { type: "stopped", text: "Stopped by user." };
        return "stopped";
      }

      let args = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = {};
      }

      yield { type: "action", tool: call.function.name, input: args };

      let mcpResult;
      const toolTimer = timer(`tool: ${call.function.name}`);
      try {
        if (call.function.name === "browser_find" && !args.text && !args.regex) {
          mcpResult = {
            isError: true,
            content: [{ type: "text", text: 'Invalid call: browser_find requires either "text" or "regex".' }],
          };
        } else {
          mcpResult = await client.callTool({ name: call.function.name, arguments: args });
        }
      } catch (err) {
        mcpResult = { isError: true, content: [{ type: "text", text: `Tool error: ${err.message}` }] };
      }
      toolTimer.end();

      if (signal.aborted) {
        yield { type: "stopped", text: "Stopped by user." };
        return "stopped";
      }

      const summary = summarizeMcpResult(mcpResult);
      yield { type: "observation", tool: call.function.name, ...summary };

      messages.push({ role: "tool", tool_call_id: call.id, content: summary.text });
    }
  }

  return { ok: false, summary: "Reached step limit for this sub-goal without finishing." };
}

async function runAndHandle(taskId, task, client, state, send, res, abortController, { sendStart, skipCache = false }) {
  activeTasks.set(taskId, { abortController, client });

  const taskTimer = timer(`TASK ${taskId} ("${task}")`);
  const recordedEvents = [];
  let completedNormally = false;
  let rateLimitedNow = false;

  const sendAndRecord = (event) => {
    recordedEvents.push(event);
    send(event);
    if (event.type === "done") completedNormally = true;
    if (event.type === "rate_limited") rateLimitedNow = true;
  };

  try {
    if (sendStart) {
      sendAndRecord({ type: "start", taskId, task });
    }
    const tools = await getTools(client);
    for await (const event of runAgent(state, client, tools, abortController.signal)) {
      sendAndRecord(event);
    }
  } catch (err) {
    if (!abortController.signal.aborted) {
      console.error(err);
      sendAndRecord({ type: "error", text: err.message || String(err) });
    }
  } finally {
    activeTasks.delete(taskId);
    activeCount--;

    taskTimer.end(rateLimitedNow ? "paused, will resume" : completedNormally ? "completed" : "ended");

    if (rateLimitedNow) {
      pausedTasks.set(taskId, { task, client, state, send, res, abortController, skipCache });
    } else {
      if (client) {
        try {
          await client.close();
        } catch (closeErr) {
          console.error("Error closing MCP client", closeErr);
        }
      }
      if (completedNormally && !skipCache) {
        setCached(task, recordedEvents);
      }
      res.end();
    }

    tryStartNext();
  }
}

async function startTask(item) {
  activeCount++;
  const { taskId, task, send, res, abortController, skipCache } = item;

  let client;
  try {
    client = await getClientFast();
  } catch (err) {
    console.error(err);
    send({ type: "error", text: "Failed to start browser session." });
    res.end();
    activeCount--;
    tryStartNext();
    return;
  }

  const state = {
    task,
    subGoals: null,
    currentIndex: 0,
    currentMessages: null,
    currentStep: 0,
    currentProvider: null,
  };

  await runAndHandle(taskId, task, client, state, send, res, abortController, { sendStart: true, skipCache });
}

function resumeTask(taskId) {
  const paused = pausedTasks.get(taskId);
  if (!paused) return false;

  pausedTasks.delete(taskId);
  activeCount++;
  const { task, client, state, send, res, abortController, skipCache } = paused;

  runAndHandle(taskId, task, client, state, send, res, abortController, { sendStart: false, skipCache });
  return true;
}

function tryStartNext() {
  while (activeCount < MAX_CONCURRENT_TASKS && queue.length > 0) {
    const item = queue.shift();
    if (item.cancelled) continue;
    startTask(item);
  }
  broadcastQueuePositions();
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

const app = express();
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    activeTasks: activeCount,
    queued: queue.length,
    paused: pausedTasks.size,
    maxConcurrentTasks: MAX_CONCURRENT_TASKS,
    pooledClients: pool.length,
    cachedResults: resultCache.size,
    groqFallbackEnabled: groqEnabled,
  });
});

app.post("/api/task", (req, res) => {
  const task = (req.body?.task || "").trim();
  const forceRefresh = !!req.body?.forceRefresh;
  if (!task) {
    res.status(400).json({ error: "Missing task" });
    return;
  }

  const taskId = crypto.randomUUID();

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (event) => res.write(JSON.stringify(event) + "\n");

  const skipCache = forceRefresh || isTimeSensitive(task);

  if (!skipCache) {
    const cached = getCached(task);
    if (cached) {
      send({ type: "start", taskId, task, cached: true });
      for (const evt of cached) {
        if (evt.type === "start") continue;
        send(evt);
      }
      res.end();
      return;
    }
  }

  const abortController = new AbortController();
  const item = { taskId, task, send, res, abortController, cancelled: false, skipCache };

  res.on("close", () => {
    if (!res.writableEnded) {
      const active = activeTasks.get(taskId);
      if (active) {
        active.abortController.abort();
        return;
      }
      const idx = queue.findIndex((q) => q.taskId === taskId);
      if (idx !== -1) {
        queue[idx].cancelled = true;
        queue.splice(idx, 1);
        broadcastQueuePositions();
      }
    }
  });

  queue.push(item);
  send({ type: "queued", taskId, position: queue.length, queueLength: queue.length });

  tryStartNext();
});

app.post("/api/resume/:taskId", (req, res) => {
  const ok = resumeTask(req.params.taskId);
  if (ok) {
    res.json({ resumed: true });
  } else {
    res.status(404).json({ error: "No paused task with that ID." });
  }
});

app.post("/api/stop/:taskId", (req, res) => {
  const { taskId } = req.params;

  const active = activeTasks.get(taskId);
  if (active) {
    active.abortController.abort();
    res.json({ stopped: true });
    return;
  }

  const idx = queue.findIndex((item) => item.taskId === taskId);
  if (idx !== -1) {
    const [item] = queue.splice(idx, 1);
    item.cancelled = true;
    item.send({ type: "stopped", text: "Removed from queue." });
    item.res.end();
    broadcastQueuePositions();
    res.json({ stopped: true });
    return;
  }

  const paused = pausedTasks.get(taskId);
  if (paused) {
    pausedTasks.delete(taskId);
    paused.send({ type: "stopped", text: "Stopped while waiting to retry." });
    if (paused.client) {
      paused.client.close().catch((err) => console.error("Error closing MCP client", err));
    }
    paused.res.end();
    res.json({ stopped: true });
    return;
  }

  res.json({ stopped: false, message: "No task with that ID is queued, running, or paused." });
});

app.listen(PORT, () => {
  console.log(`Wayfinder API running at http://localhost:${PORT}`);
  console.log(`Accepting requests from ${FRONTEND_ORIGIN}`);
  console.log(
    `Max concurrent tasks: ${MAX_CONCURRENT_TASKS} (queuing + resume-in-place + sub-goal decomposition + smart caching + timing + Groq fallback [${groqEnabled ? "on" : "off"}] enabled)`
  );
  fillPool();
});