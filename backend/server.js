import "dotenv/config";
import crypto from "crypto";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "path";
import fs from "fs/promises";

const RECORDINGS_DIR = path.join(process.cwd(), "recordings");
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

// ---------------------------------------------------------------------------
// Timing helpers -- lightweight, console-only instrumentation.
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

// ---------------------------------------------------------------------------
// Multi-provider fallback chain: Cerebras (primary) -> Groq -> OpenRouter ->
// Cerebras (final bounce-back). Each fallback provider tracks its own
// cooldown independently. A "turbo" flag (per-task) can disable the whole
// chain and force Cerebras-only.
// ---------------------------------------------------------------------------

const FALLBACK_TIMEOUT_MS = 10000;

const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const groqEnabled = !!process.env.GROQ_API_KEY;
const groq = groqEnabled
  ? new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" })
  : null;

const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";
const openrouterEnabled = !!process.env.OPENROUTER_API_KEY;
const openrouter = openrouterEnabled
  ? new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": process.env.FRONTEND_ORIGIN || "http://localhost:5173",
        "X-Title": "Wayfinder",
      },
    })
  : null;

if (!groqEnabled) console.log("[fallback] GROQ_API_KEY not set -- Groq disabled.");
if (!openrouterEnabled) console.log("[fallback] OPENROUTER_API_KEY not set -- OpenRouter disabled.");

const fallbackChain = [
  groqEnabled ? { name: "groq", client: groq, model: GROQ_MODEL, disabledUntil: 0 } : null,
  openrouterEnabled ? { name: "openrouter", client: openrouter, model: OPENROUTER_MODEL, disabledUntil: 0 } : null,
].filter(Boolean);

function parseCooldownMs(message, fallbackMs = 15 * 60 * 1000) {
  const match = /try again in\s*(?:([\d.]+)h)?\s*(?:([\d.]+)m)?\s*(?:([\d.]+)s)?/i.exec(message || "");
  if (!match) return fallbackMs;
  const [, h, m, s] = match;
  const ms = ((parseFloat(h) || 0) * 3600 + (parseFloat(m) || 0) * 60 + (parseFloat(s) || 0)) * 1000;
  return ms > 0 ? ms : fallbackMs;
}

// Cerebras's gpt-oss model attaches extra non-standard fields (like
// `reasoning`) to assistant messages. Other providers reject those fields
// outright, so any message pushed into the shared conversation history
// must be stripped down to the standard OpenAI shape first.
function sanitizeAssistantMessage(msg) {
  const clean = { role: msg.role, content: msg.content ?? null };
  if (msg.tool_calls) clean.tool_calls = msg.tool_calls;
  return clean;
}

// Tries Cerebras first (racing it against a timeout, unless useFallback is
// false -- then Cerebras alone, no timeout race, no chain). If Cerebras is
// slow/errors and useFallback is true, walks the fallback chain in order,
// skipping any provider on cooldown. If every fallback fails, makes one
// final fresh attempt back on Cerebras. Returns { completion, provider }.
async function createCompletionWithFallback(label, params, signal, useFallback = true) {
  const cerebrasController = new AbortController();
  const forwardAbort = () => cerebrasController.abort();
  if (signal) signal.addEventListener("abort", forwardAbort, { once: true });
  const cleanupPrimary = () => signal?.removeEventListener("abort", forwardAbort);

  const cerebrasTimer = timer(`${label}: cerebras call`);
  const cerebrasAttempt = cerebras.chat.completions.create({ model: MODEL, ...params }, { signal: cerebrasController.signal })
    .then((result) => ({ ok: true, result }))
    .catch((err) => ({ ok: false, err }));

  // Turbo off -- ignore the fallback chain entirely, Cerebras only.
  if (!useFallback) {
    const outcome = await cerebrasAttempt;
    cleanupPrimary();
    if (outcome.ok) {
      cerebrasTimer.end();
      return { completion: outcome.result, provider: "cerebras" };
    }
    cerebrasTimer.end("errored (fallback disabled)");
    throw outcome.err;
  }

  const availableFallbacks = fallbackChain.filter((p) => Date.now() > p.disabledUntil);

  if (availableFallbacks.length === 0) {
    const outcome = await cerebrasAttempt;
    cleanupPrimary();
    if (outcome.ok) {
      cerebrasTimer.end();
      return { completion: outcome.result, provider: "cerebras" };
    }
    cerebrasTimer.end(fallbackChain.length ? "errored (all fallbacks on cooldown)" : "errored");
    throw outcome.err;
  }

  const timeoutMarker = Symbol("timeout");
  const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(timeoutMarker), FALLBACK_TIMEOUT_MS));

  const race = await Promise.race([cerebrasAttempt, timeoutPromise]);

  if (race !== timeoutMarker && race.ok) {
    cleanupPrimary();
    cerebrasTimer.end();
    return { completion: race.result, provider: "cerebras" };
  }

  if (race === timeoutMarker) {
    cerebrasController.abort();
  }
  cleanupPrimary();

  const primaryReason =
    race === timeoutMarker
      ? `slow (>${FALLBACK_TIMEOUT_MS}ms)`
      : race.err?.status === 429
      ? "rate-limited"
      : "errored";
  cerebrasTimer.end(`${primaryReason}, trying fallback chain`);

  for (const providerEntry of availableFallbacks) {
    const fbTimer = timer(`${label}: ${providerEntry.name} fallback call`);
    try {
      const result = await providerEntry.client.chat.completions.create(
        { model: providerEntry.model, ...params },
        { signal }
      );
      fbTimer.end();
      return { completion: result, provider: providerEntry.name };
    } catch (err) {
      console.error(
        `[fallback] ${providerEntry.name} rejected ${label}: status=${err?.status} message=${err?.error?.message || err?.message}`
      );

      if (err?.status === 429) {
        const cooldownMs = parseCooldownMs(err?.error?.message);
        providerEntry.disabledUntil = Date.now() + cooldownMs;
        console.log(`[fallback] ${providerEntry.name} disabled for ${Math.round(cooldownMs / 60000)} min due to rate limit/quota.`);
      }

      fbTimer.end(`errored (${err?.status || "?"}), trying next`);
    }
  }

  const bounceController = new AbortController();
  const forwardBounceAbort = () => bounceController.abort();
  if (signal) signal.addEventListener("abort", forwardBounceAbort, { once: true });

  const bounceTimer = timer(`${label}: cerebras bounce-back call`);
  try {
    const bounceResult = await cerebras.chat.completions.create({ model: MODEL, ...params }, { signal: bounceController.signal });
    bounceTimer.end();
    return { completion: bounceResult, provider: "cerebras" };
  } catch (bounceErr) {
    bounceTimer.end("errored");
    throw bounceErr;
  } finally {
    signal?.removeEventListener("abort", forwardBounceAbort);
  }
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
const activeTasks = new Map();
const queue = [];
const pool = [];
const pausedTasks = new Map();

let cachedTools = null;

async function spawnMcpClient({ record = false, taskId = null } = {}) {
  const args = [
    "@playwright/mcp",
    "--browser", "chrome",
    "--isolated",
    "--timeout-navigation", "15000",
  ];
  if (process.env.PLAYWRIGHT_HEADED !== "true") args.push("--headless");

  let configPath = null;
  if (record && taskId) {
    const dir = path.join(RECORDINGS_DIR, taskId);
    await fs.mkdir(dir, { recursive: true });

    const config = {
      outputDir: dir,
      browser: {
        contextOptions: {
          recordVideo: {
            dir,
            size: { width: 800, height: 600 },
          },
        },
      },
    };
    configPath = path.join(dir, "mcp-config.json");
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    args.push("--config", configPath);
  }

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

async function getClientFast({ record = false, taskId = null } = {}) {
  const t = timer("browser acquisition");

  if (record) {
    // Recording needs a dedicated, task-specific output folder set at
    // spawn time -- pooled browsers are generic and can't have that, so
    // skip the pool entirely and spawn fresh for this task.
    const client = await spawnMcpClient({ record: true, taskId });
    t.end("cold spawn (recording)");
    return client;
  }

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

const FINISH_SUBGOAL_TOOL = {
  type: "function",
  function: {
    name: "finish_subgoal",
    description:
      "Call this EXACTLY ONCE when you are done working on the current sub-goal -- whether you succeeded or not. " +
      "Do not simply stop calling tools; you must call this to conclude. Set success to true only if you actually " +
      "verified the sub-goal's outcome (e.g. you saw the text/data you were asked to find). If you searched and " +
      "could not find something after reasonable attempts, set success to false and explain what you tried.",
    parameters: {
      type: "object",
      properties: {
        success: {
          type: "boolean",
          description: "true only if you verified the sub-goal was actually accomplished; false if you could not complete it",
        },
        summary: {
          type: "string",
          description: "Concise summary of what you found/did, or what specifically blocked you if success is false",
        },
      },
      required: ["success", "summary"],
    },
  },
};

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
- When you are done with the current sub-goal -- whether you succeeded or got stuck -- you MUST call the
  finish_subgoal tool exactly once to conclude it. Never just stop calling tools without calling finish_subgoal;
  that leaves your outcome ambiguous. Set success:true only if you actually verified the result (e.g. you saw the
  specific text/data on the page), never optimistically. Set success:false and explain what blocked you if you
  could not verify it, rather than guessing or claiming something you didn't confirm.
- If you get stuck after several attempts on this sub-goal, call finish_subgoal with success:false and explain
  what's blocking you, instead of repeating the same failing action or claiming false progress.`;

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
//   subGoals: null | [{ id, goal, status, summary? }],
//   currentIndex, currentMessages, currentStep,
//   currentProvider: null | "cerebras" | "groq" | "openrouter",
//   turbo: boolean,
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
        signal,
        state.turbo
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
          text: err?.error?.message || err?.message || "Rate limit reached.",
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
// Completion is now driven by an explicit finish_subgoal tool call, not
// inferred from the model simply stopping tool calls (which previously let
// hallucinated/false "done" outcomes slip through uncached... except they
// WERE being cached as if verified).
// Returns "rate_limited" | "stopped" | { ok: bool, summary: string }.
async function* runSubGoal(state, client, tools, signal) {
  const messages = state.currentMessages;
  const toolsWithFinish = [...tools, FINISH_SUBGOAL_TOOL];

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
        { messages, tools: toolsWithFinish, tool_choice: "auto", max_tokens: 2048 },
        signal,
        state.turbo
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
          text: err?.error?.message || err?.message || "Rate limit reached.",
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
      messages.push({
        role: "user",
        content:
          "You didn't call any tool. If you're done with this sub-goal (successfully or not), call finish_subgoal " +
          "now with success and summary. Otherwise continue with the browser tools.",
      });
      continue;
    }

    const finishCall = toolCalls.find((c) => c.function.name === "finish_subgoal");
    if (finishCall) {
      let finishArgs = {};
      try {
        finishArgs = finishCall.function.arguments ? JSON.parse(finishCall.function.arguments) : {};
      } catch {
        finishArgs = {};
      }
      const success = finishArgs.success === true;
      const summary = typeof finishArgs.summary === "string" && finishArgs.summary.trim()
        ? finishArgs.summary.trim()
        : success
        ? "Done."
        : "Could not complete this sub-goal.";
      return { ok: success, summary };
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

async function runAndHandle(taskId, task, client, state, send, res, abortController, { sendStart, skipCache = false, record = false }) {
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
      pausedTasks.set(taskId, { task, client, state, send, res, abortController, skipCache, record });
    } else {
      if (client) {
        try {
          await client.close();
        } catch (closeErr) {
          console.error("Error closing MCP client", closeErr);
        }
      }

      if (record) {
        try {
          const dir = path.join(RECORDINGS_DIR, taskId);
          const files = await fs.readdir(dir);
          const video = files.find((f) => f.endsWith(".webm"));
          if (video) {
            sendAndRecord({ type: "recording", url: `/recordings/${taskId}/${video}` });
          }
        } catch (err) {
          console.error(`No recording found for task ${taskId}:`, err.message);
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
  const { taskId, task, send, res, abortController, skipCache, record } = item;

  let client;
  try {
    client = await getClientFast({ record, taskId });
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
    turbo: item.turbo,
  };

  await runAndHandle(taskId, task, client, state, send, res, abortController, { sendStart: true, skipCache, record });
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
app.use("/recordings", express.static(RECORDINGS_DIR));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    activeTasks: activeCount,
    queued: queue.length,
    paused: pausedTasks.size,
    maxConcurrentTasks: MAX_CONCURRENT_TASKS,
    pooledClients: pool.length,
    cachedResults: resultCache.size,
    fallbackProviders: fallbackChain.map((p) => ({
      name: p.name,
      onCooldown: Date.now() < p.disabledUntil,
      cooldownEndsIn: Date.now() < p.disabledUntil ? Math.round((p.disabledUntil - Date.now()) / 1000) : 0,
    })),
  });
});

app.post("/api/task", (req, res) => {
  const task = (req.body?.task || "").trim();
  const forceRefresh = !!req.body?.forceRefresh;
  const turbo = req.body?.turbo !== false;
  const record = !!req.body?.record;

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

  const skipCache = forceRefresh || isTimeSensitive(task) || record; // don't cache recorded runs -- the video is per-run, a cache replay would show stale text with no matching video

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
  const item = { taskId, task, send, res, abortController, cancelled: false, skipCache, turbo, record };

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
    `Max concurrent tasks: ${MAX_CONCURRENT_TASKS} (queuing + resume-in-place + sub-goal decomposition + finish_subgoal + smart caching + timing + fallback chain [cerebras${groqEnabled ? " -> groq" : ""}${openrouterEnabled ? " -> openrouter" : ""}] + turbo toggle enabled)`
  );
  fillPool();
});