import "dotenv/config";
import crypto from "crypto";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "path";
import fs from "fs/promises";
import { exec, execSync } from "child_process";
import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
import * as cheerio from "cheerio";
import fsSync from "fs";

// 1. Initialize the core stealth framework to strip obvious automation flags
const stealth = stealthPlugin({
  enabledEvasions: new Set([
    'navigator.webdriver',   // Keep this essential automation flag removal tool active
    'iframe.contentWindow',
    'media.codecs'
  ])
});

// Explicitly scrap specific leaks that standard stealth drivers occasionally miss
stealth.enabledEvasions.add("user-agent-override");
chromium.use(stealth);

function dropTokenWaste(rawHtml) {
  if (!rawHtml) return "";
  const $ = cheerio.load(rawHtml);

  // 1. Instantly shred layout weight that doesn't contain user text or data
  $(
    "script, style, svg, path, link, noscript, iframe, head, footer, header, nav",
  ).remove();

  // 2. Erase non-essential tracker attributes but keep data identifiers intact
  $("*").each((_, element) => {
    const keep = [
      "id",
      "href",
      "placeholder",
      "value",
      "name",
      "aria-label",
      "role",
      "class",
    ];
    const attribs = element.attribs || {};
    Object.keys(attribs).forEach((attr) => {
      if (!keep.includes(attr)) {
        $(element).removeAttr(attr);
      }
    });
  });

  // 3. Compress multiple line spaces into a single space
  return $.html().replace(/\s+/g, " ").trim();
}


// Cleans up the leftover C:\ChromeProfile_* directories created by the
// Windows launch path in autoLaunchStealthChrome(). Only meaningful on
// Windows: other platforms launch a Playwright-managed browser that owns its
// own profile, and killing every "chrome" process there would take down
// browsers belonging to other in-flight tasks.
function purgeOldProfiles() {
  if (process.platform !== "win32") return;

  console.log("[Auto-Purge] Cleaning up stale Chrome profile directories...");

  // 1. Force kill any hidden background Chrome processes to unlock the folders
  try {
    execSync("taskkill /F /IM chrome.exe /T", { stdio: "ignore" });
    console.log("[Auto-Purge] Hanging background Chrome processes closed.");
  } catch (err) {
    // taskkill exits non-zero when no matching process exists (128), which is
    // the normal case -- anything else is worth surfacing.
    if (err?.status !== 128) {
      console.warn("[Auto-Purge] Could not kill background Chrome:", err.message);
    }
  }

  // 2. Read the root drive directory to find any C:\ChromeProfile_* folders
  try {
    const rootDrive = "C:\\";
    if (fsSync.existsSync(rootDrive)) {
      const items = fsSync.readdirSync(rootDrive);

      items.forEach((item) => {
        if (item.startsWith("ChromeProfile_")) {
          const targetFolderPath = path.join(rootDrive, item);
          try {
            fsSync.rmSync(targetFolderPath, { recursive: true, force: true });
            console.log(`[Auto-Purge] Removed old cache folder: ${item}`);
          } catch (folderErr) {
            console.warn(`[Auto-Purge] Could not clear folder ${item}:`, folderErr.message);
          }
        }
      });
    }
  } catch (dirErr) {
    console.error("[Auto-Purge] Directory traversal failed:", dirErr.message);
  }
}

// Tools whose MCP output is actual raw HTML markup. dropTokenWaste() is an
// HTML-oriented compressor (built on Cheerio) -- running it on non-HTML
// output like the Playwright accessibility-tree snapshot format
// (browser_snapshot / browser_find, which return YAML-ish "ref=" trees, not
// markup) corrupts the structure the model relies on to find elements. Only
// tools actually listed here will have their output compressed. Empty by
// default since none of the current Playwright MCP tools return raw HTML;
// add a tool name here only if you add one that genuinely returns markup.
const HTML_RETURNING_TOOLS = new Set([]);

async function autoLaunchStealthChrome() {
  console.log("[Universal Anti-Detect] Initializing system process...");
  
  // 1. If running locally on Windows, keep using your persistent profile process setup
  if (process.platform === "win32") {
    const chromeExecutable = `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"`;
    const randomSessionId = crypto.randomUUID().substring(0, 8);
    const dynamicProfileDir = `C:\\ChromeProfile_${randomSessionId}`;
    
    const parameters = `--remote-debugging-port=9222 --user-data-dir="${dynamicProfileDir}" --disable-blink-features=AutomationControlled --remote-allow-origins="*" --no-first-run --no-default-browser-check --disable-infobars --password-store=basic --use-mock-keychain --disable-features=IsolateOrigins,site-per-process --blink-settings=primaryHoverType=2,primaryPointerType=4`;

    // Chrome stays alive for the whole session, so we can't await the exec
    // callback -- but a launch that dies immediately (missing binary, bad
    // profile dir) must not be reported as a success: record it and fail the
    // spawn instead of letting it resurface later as an opaque CDP timeout.
    let launchError = null;
    exec(`${chromeExecutable} ${parameters}`, (error) => {
      if (error && !error.killed) {
        launchError = error;
        console.error("[Universal Anti-Detect] Chrome launch failed:", error.message);
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 3500));
    if (launchError) {
      throw new Error(`Failed to launch Chrome: ${launchError.message}`);
    }

  } else {
    // 2. PRODUCTION PRODUCTION: If running on Railway Linux, bypass external exec calls entirely!
    // We launch a native headless instance using Playwright's core binaries
    console.log("[Stealth Engine] Production container detected. Launching native headless chromium...");
    
    global.productionBrowser = await chromium.launch({
      headless: true,
      args: [
        '--remote-debugging-port=9222', // Binds the CDP channel to port 9222 inside the cloud kernel
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--remote-allow-origins=*'
      ]
    });
    
    // Give the container port 1.5 seconds to settle down internally
    await new Promise((resolve) => setTimeout(resolve, 1500));
    console.log("[Universal Anti-Detect] Production browser socket bound internally to port 9222.");
  }
}

const RECORDINGS_DIR = path.join(process.cwd(), "recordings");
const PORT = process.env.PORT || 3000;
const MODEL = process.env.CEREBRAS_MODEL || "gpt-oss-120b";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const MAX_CONCURRENT_TASKS = 3;
const POOL_SIZE = 2;
const RESULT_CACHE_TTL_MS = 10 * 60 * 1000;
const RESULT_CACHE_MAX = 50;
const SUBGOAL_MAX_STEPS = 25;

if (!process.env.CEREBRAS_API_KEY) {
  console.error(
    "Missing CEREBRAS_API_KEY. Copy .env.example to .env and add your key from https://cloud.cerebras.ai/",
  );
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

const FALLBACK_TIMEOUT_MS = 4000;

const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const groqEnabled = !!process.env.GROQ_API_KEY;
const groq = groqEnabled
  ? new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    })
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

const NVIDIA_NIM_MODEL =
  process.env.NVIDIA_NIM_MODEL || "meta/llama-3.3-70b-instruct";
const nvidiaNimEnabled = !!process.env.NVIDIA_NIM_API_KEY;

const nvidiaNim = nvidiaNimEnabled
  ? new OpenAI({
      apiKey: process.env.NVIDIA_NIM_API_KEY,
      // 1. Updated Base URL to the modern, unified routing catalog path
      baseURL: "https://api.nvidia.com/v1", 
      // 2. Injects standard environment headers to authenticate the backend network socket
      defaultHeaders: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) OpenAI-Node-SDK/Wayfinder",
        "Accept": "application/json",
        "X-NVAPI-Client": "NodeJS-SDK"
      }
    })
  : null;

const SAMBANOVA_MODEL = process.env.SAMBANOVA_MODEL || "gpt-oss-120b";
const sambanovaEnabled = !!process.env.SAMBANOVA_API_KEY;
const sambanova = sambanovaEnabled
  ? new OpenAI({
      apiKey: process.env.SAMBANOVA_API_KEY,
      baseURL: "https://api.sambanova.ai/v1",
    })
  : null;

if (!groqEnabled)
  console.log("[fallback] GROQ_API_KEY not set -- Groq disabled.");
if (!openrouterEnabled)
  console.log("[fallback] OPENROUTER_API_KEY not set -- OpenRouter disabled.");
if (!nvidiaNimEnabled)
  console.log("[fallback] NVIDIA_NIM_API_KEY not set -- NVIDIA NIM disabled.");
if (!sambanovaEnabled)
  console.log("[fallback] SAMBANOVA_API_KEY not set -- SambaNova disabled.");

if (!groqEnabled)
  console.log("[fallback] GROQ_API_KEY not set -- Groq disabled.");
if (!openrouterEnabled)
  console.log("[fallback] OPENROUTER_API_KEY not set -- OpenRouter disabled.");

const fallbackChain = [
  groqEnabled
    ? { name: "groq", client: groq, model: GROQ_MODEL, disabledUntil: 0 }
    : null,
  openrouterEnabled
    ? {
        name: "openrouter",
        client: openrouter,
        model: OPENROUTER_MODEL,
        disabledUntil: 0,
      }
    : null,
    sambanovaEnabled
    ? {
        name: "sambanova",
        client: sambanova,
        model: SAMBANOVA_MODEL,
        disabledUntil: 0,
      }
    : null,
  nvidiaNimEnabled
    ? {
        name: "nvidia_nim",
        client: nvidiaNim,
        model: NVIDIA_NIM_MODEL,
        disabledUntil: 0,
      }
    : null,
].filter(Boolean);
function parseCooldownMs(message, fallbackMs = 15 * 60 * 1000) {
  const match =
    /try again in\s*(?:([\d.]+)h)?\s*(?:([\d.]+)m)?\s*(?:([\d.]+)s)?/i.exec(
      message || "",
    );
  if (!match) return fallbackMs;
  const [, h, m, s] = match;
  const ms =
    ((parseFloat(h) || 0) * 3600 +
      (parseFloat(m) || 0) * 60 +
      (parseFloat(s) || 0)) *
    1000;
  return ms > 0 ? ms : fallbackMs;
}

// Cerebras's gpt-oss model attaches extra non-standard fields (like
// `reasoning`) to assistant messages. Other providers reject those fields
// outright, so any message pushed into the shared conversation history
// must be stripped down to the standard OpenAI shape first.
function sanitizeAssistantMessage(msg) {
  if (!msg) return msg;

  const clean = { 
    role: msg.role, 
    content: msg.content ?? null 
  };

  // 1. If it's a tool-use message, normalize the call structures cleanly
  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    clean.tool_calls = msg.tool_calls.map(call => ({
      id: call.id || `call_${Math.random().toString(36).substr(2, 9)}`, // Fallback safe ID generator
      type: "function",
      function: {
        name: call.function?.name || call.name,
        arguments: typeof call.function?.arguments === "string" 
          ? call.function.arguments 
          : JSON.stringify(call.function?.arguments || call.arguments || {})
      }
    }));
  }

  // 2. If it's a structural tool response message, enforce strict tool_call_id parameter mapping
  if (msg.role === "tool") {
    clean.tool_call_id = msg.tool_call_id || msg.id || "";
  }

  return clean;
}

// Tries Cerebras first (racing it against a timeout, unless useFallback is
// false -- then Cerebras alone, no timeout race, no chain). If Cerebras is
// slow/errors and useFallback is true, walks the fallback chain in order,
// skipping any provider on cooldown. If every fallback fails, makes one
// final fresh attempt back on Cerebras. Returns { completion, provider }.
async function createCompletionWithFallback(
  label,
  params,
  signal,
  useFallback = true,
) {
  const cerebrasController = new AbortController();
  const forwardAbort = () => cerebrasController.abort();
  if (signal) signal.addEventListener("abort", forwardAbort, { once: true });
  const cleanupPrimary = () =>
    signal?.removeEventListener("abort", forwardAbort);

  // 1. Build the primary Cerebras request payload object
  const cerebrasRequestParams = {
    model: MODEL,
    ...params,
  };

  // 2. ZERO FRONTEND CHANGES CACHING HOOK:
  // We extract the taskId directly from your existing params object or global context
  // so you don't have to rewrite your frontend fetch calls.
  const currentTaskId = params.taskId || params.messages?.[0]?.taskId || null;
  if (currentTaskId) {
    console.log(
      `[Cache Optimizer] Pinning Cerebras prompt_cache_key to: ${currentTaskId}`,
    );
    cerebrasRequestParams.prompt_cache_key = currentTaskId;
  }

  const cerebrasTimer = timer(`${label}: cerebras call`);
  const cerebrasAttempt = cerebras.chat.completions
    .create(cerebrasRequestParams, { signal: cerebrasController.signal })
    .then((result) => ({ ok: true, result }))
    .catch((err) => ({ ok: false, err }));

  // =========================================================================
  // TURBO OFF VALUE MATCH: Locks strictly to single-model Cerebras Only
  // =========================================================================
  if (!useFallback) {
    console.log(
      "[Turbo Engine] 🧊 OFF: Locking execution to single-model Cerebras cache line...",
    );
    const outcome = await cerebrasAttempt;
    cleanupPrimary();
    if (outcome.ok) {
      cerebrasTimer.end();
      return { completion: outcome.result, provider: "cerebras" };
    }
    cerebrasTimer.end("errored (fallback disabled)");
    throw outcome.err;
  }

  // =========================================================================
  // TURBO ON VALUE MATCH: Fallback cluster active (Cerebras -> Groq -> OpenRouter)
  // =========================================================================
  console.log(
    "[Turbo Engine] 🔥 ON: Fallback chain active. Racing primary model thresholds...",
  );
  const availableFallbacks = fallbackChain.filter(
    (p) => Date.now() > p.disabledUntil,
  );

  if (availableFallbacks.length === 0) {
    const outcome = await cerebrasAttempt;
    cleanupPrimary();
    if (outcome.ok) {
      cerebrasTimer.end();
      return { completion: outcome.result, provider: "cerebras" };
    }
    cerebrasTimer.end(
      fallbackChain.length ? "errored (all fallbacks on cooldown)" : "errored",
    );
    throw outcome.err;
  }

  const timeoutMarker = Symbol("timeout");
  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve(timeoutMarker), FALLBACK_TIMEOUT_MS),
  );

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
        { signal },
      );
      fbTimer.end();
      return { completion: result, provider: providerEntry.name };
    } catch (err) {
      console.error(
        `[fallback] ${providerEntry.name} rejected ${label}: status=${err?.status} message=${err?.error?.message || err?.message}`,
      );

      if (err?.status === 429) {
        const cooldownMs = parseCooldownMs(err?.error?.message);
        providerEntry.disabledUntil = Date.now() + cooldownMs;
        console.log(
          `[fallback] ${providerEntry.name} disabled for ${Math.round(cooldownMs / 60000)} min due to rate limit/quota.`,
        );
      }

      fbTimer.end(`errored (${err?.status || "?"}), trying next`);
    }
  }

  const bounceController = new AbortController();
  const forwardBounceAbort = () => bounceController.abort();
  if (signal)
    signal.addEventListener("abort", forwardBounceAbort, { once: true });

  const bounceTimer = timer(`${label}: cerebras bounce-back call`);
  try {
    const bounceParams = { model: MODEL, ...params };
    if (currentTaskId) bounceParams.prompt_cache_key = currentTaskId;

    const bounceResult = await cerebras.chat.completions.create(bounceParams, {
      signal: bounceController.signal,
    });
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

const TIME_SENSITIVE_PATTERN =
  /\b(right now|today|current(ly)?|latest|live|this (week|month|hour)|now\b)/i;

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
  try {

    purgeOldProfiles();

    await autoLaunchStealthChrome();

    console.log(
      "[Universal Anti-Detect] Establishing secure CDP channel wrapper...",
    );
    const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");

    // Inject structural modifications across all background frames dynamically
    for (const context of browser.contexts()) {
      await hardenContextAgainstDetection(context);
    }
    // Event handlers run outside the spawn promise: an unhandled rejection
    // here would crash the process instead of failing this one context.
    browser.on("context", (context) => {
      hardenContextAgainstDetection(context).catch((err) =>
        console.warn("[Stealth Engine] Failed to harden new context:", err.message),
      );
    });

    const args = [
      "@playwright/mcp",
      // =========================================================================
      // ✅ ENGINE BOUNDARY REPAIR: Forces the child node to strictly lock onto Chromium
      // =========================================================================
      "--engine", "chromium",
      // =========================================================================
      "--cdp-endpoint", "http://127.0.0.1:9222",
      "--isolated",
      "--timeout-navigation", "30000", 
    ];
    if (process.env.PLAYWRIGHT_HEADED !== "true") args.push("--headless");

    // Keep your standard recording block configuration active below
    let configPath = null;
    if (record && taskId) {
      const dir = path.join(RECORDINGS_DIR, taskId);
      await fs.mkdir(dir, { recursive: true });
      const config = {
        outputDir: dir,
        browser: {
          contextOptions: {
            recordVideo: { dir, size: { width: 800, height: 600 } },
          },
        },
      };
      configPath = path.join(dir, "mcp-config.json");
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));
      args.push("--config", configPath);
    }

    const transport = new StdioClientTransport({ command: "npx", args });
    const client = new Client(
      { name: "playwright-llm-agent", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    return client;
  } catch (error) {
    console.error(
      "[Universal Anti-Detect] Pipeline initialization failure:",
      error.message,
    );
    throw error;
  }
}

async function hardenContextAgainstDetection(context) {
  // 1. Pristine Native Object Spoofing (Wipes out deep property leaks)
  await context.addInitScript(() => {
    // Delete the property from the prototype chain and rebuild it cleanly
    const newPrototype = Object.getPrototypeOf(navigator);
    delete newPrototype.webdriver;
    Object.defineProperty(newPrototype, "webdriver", {
      get: () => undefined,
      enumerable: true,
      configurable: true,
    });

    // Disguise the string function representation to mimic native desktop code
    const originalToString = Function.prototype.toString;
    Function.prototype.toString = function () {
      if (
        this ===
        Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(navigator),
          "webdriver",
        )?.get
      ) {
        return "function get webdriver() { [native code] }";
      }
      return originalToString.apply(this, arguments);
    };

    // Mask system language and runtime profiles globally
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });
    window.chrome = { runtime: {}, loadTimes: Date.now, csi: () => {} };
    if (!window.Notification) {
      window.Notification = {
        permission: "default",
        requestPermission: async () => "default"
      };
    }

    // Pass WebGL vendor validation scripts
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
      if (parameter === 37445) return "Intel Inc.";
      if (parameter === 37446) return "Intel(R) Iris(R) Xe Graphics Direct3D11";
      return getParameter.apply(this, arguments);
    };
  });

  // 2. Behavioral Interaction Humanization (Keystrokes and mouse drag timing)
  context.on("page", (page) => {
    // 🔍 ADD THIS NAVIGATION INTERCEPTOR HOOK:
    const originalGoto = page.goto.bind(page);
    page.goto = async (url, options = {}) => {
      console.log(`[Stealth Engine] Humanizing navigation route to: ${url}`);
      const response = await originalGoto(url, { waitUntil: "load", timeout: 30000, ...options });
      
      // Inject a realistic 2.5 to 4.5-second human pause to let passive tracking scripts settle naturally
      const humanPacingDelay = Math.floor(Math.random() * 2000) + 2500;
      await page.waitForTimeout(humanPacingDelay);
      return response;
    };
    let lastMouseX = 100;
    let lastMouseY = 100;

    // Override page filling to force realistic keyboard intervals
    const originalFill = page.fill.bind(page);
    page.fill = async (selector, value, options = {}) => {
      await page.focus(selector);
      const dynamicKeystrokeDelay = Math.floor(Math.random() * 60) + 50;
      return await page.type(selector, value, {
        delay: dynamicKeystrokeDelay,
        ...options,
      });
    };

    // Override page clicking to inject non-linear Bezier kinetic paths
    const originalClick = page.click.bind(page);
    page.click = async (selector, options = {}) => {
      try {
        const element = page.locator(selector).first();
        await element.waitFor({ state: "visible", timeout: 3000 });

        const box = await element.boundingBox();
        if (box) {
          const targetX = Math.round(box.x + box.width / 2);
          const targetY = Math.round(box.y + box.height / 2);

          console.log(
            `[Stealth Mouse] Curving path to coordinates: [${targetX}, ${targetY}]`,
          );
          await humanMouseMove(page, lastMouseX, lastMouseY, targetX, targetY);

          lastMouseX = targetX;
          lastMouseY = targetY;
          await page.waitForTimeout(Math.floor(Math.random() * 250) + 150);
        }
      } catch (e) {
        // Kinetic path is best-effort: fall back to a plain hover, then let
        // the real click below surface any genuine failure to the caller.
        console.warn(
          `[Stealth Mouse] Could not curve path to ${selector}: ${e.message}`,
        );
        try {
          await page.hover(selector);
        } catch (hoverErr) {
          console.warn(`[Stealth Mouse] Hover fallback failed: ${hoverErr.message}`);
        }
      }
      return await originalClick(selector, options);
    };

    // Auto-sweep modal frames on document load updates
    page.on("load", () => {
      dismissModals(page).catch((err) =>
        console.warn("[Stealth Engine] Modal sweep failed:", err.message),
      );
    });
  });
}

// Moves the mouse to the target along a quadratic Bezier curve so the pointer
// path doesn't look machine-straight.
async function humanMouseMove(page, fromX, fromY, toX, toY, steps = 20) {
  const controlX = (fromX + toX) / 2 + (Math.random() - 0.5) * 200;
  const controlY = (fromY + toY) / 2 + (Math.random() - 0.5) * 200;

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const inv = 1 - t;
    const x = inv * inv * fromX + 2 * inv * t * controlX + t * t * toX;
    const y = inv * inv * fromY + 2 * inv * t * controlY + t * t * toY;
    await page.mouse.move(x, y);
  }
}

// Best-effort dismissal of cookie/promo overlays after a page load. Failures
// are expected (no such overlay, page navigated away) but are logged rather
// than dropped so a systematically failing sweep is visible.
async function dismissModals(page) {
  try {
    await page.waitForTimeout(1500);
    const modalDismissSelectors = [
      'input[data-action-type="DISMISS"]',
      ".a-button-close",
      'button:has-text("Dismiss")',
      "#cookie-accept",
      'button:has-text("Accept All")',
    ].join(", ");
    const dismissTarget = page.locator(modalDismissSelectors).first();
    if (await dismissTarget.isVisible()) {
      await dismissTarget.click();
    }
  } catch (err) {
    console.warn(`[Stealth Engine] Modal dismissal skipped: ${err.message}`);
  }
}
async function fillPool() {
  while (pool.length < POOL_SIZE) {
    try {
      const client = await spawnMcpClient();
      pool.push(client);
    } catch (err) {
      console.error("Failed to pre-warm MCP client for pool:", err.message);
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
  // Refilled in the background; fillPool never rejects, but guard anyway so a
  // future change can't turn this into an unhandled rejection.
  fillPool().catch((err) => console.error("Pool refill failed:", err.message));
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
    item.send({
      type: "queued",
      taskId: item.taskId,
      position: i + 1,
      queueLength: queue.length,
    });
  });
}

const SNAPSHOT_NOISE_PATTERNS = [
  /- navigation "Shortcuts menu"[\s\S]*?- generic \[ref=\w+\]: To move between items, use your keyboard's up or down arrows\.\n/,
  /- combobox "Select the department you want to search in"[\s\S]*?(?=\n\s*- searchbox)/,
  /(?:\s*- generic: "Test: [^\n]+"\n)+/g,
];

function stripSnapshotNoise(text) {
  let cleaned = text;
  for (const pattern of SNAPSHOT_NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }
  return cleaned;
}

function summarizeMcpResult(result) {
  const items = result?.content || [];
  let text = items
    .filter((i) => i.type === "text")
    .map((i) => i.text)
    .join("\n");

  text = stripSnapshotNoise(text);   // <-- add this line, before the slice
  text = text.slice(0, 4000);

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
          description:
            "true only if you verified the sub-goal was actually accomplished; false if you could not complete it",
        },
        summary: {
          type: "string",
          description:
            "Concise summary of what you found/did, or what specifically blocked you if success is false",
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
  what's blocking you, instead of repeating the same failing action or claiming false progress.
- Prices may appear in any currency/locale format (e.g. "INR 1,234.56", "€99,00"), not just "$X.XX". Don't
  assume USD formatting when searching for price text -- prefer browser_evaluate querying common price CSS
  classes (.a-price, .a-offscreen, etc. on Amazon) over guessing currency symbols with browser_find.`;


const PLAN_SYSTEM_PROMPT = `You are a task planner for a browser automation agent. Given a user's task, break it
into 2-5 concrete, sequential sub-goals that together accomplish it. Each sub-goal should be a single, well-scoped
piece of work (e.g. "Navigate to X", "Find Y on the page", "Extract Z").

Respond with ONLY a JSON array, no other text, no markdown fences. Format:
[{"goal": "short imperative description of sub-goal 1"}, {"goal": "short imperative description of sub-goal 2"}]`;

function tryParsePlan(text) {
  try {
    const cleaned = text
      .trim()
      .replace(/^```(json)?/i, "")
      .replace(/```$/, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((p) => p && typeof p.goal === "string")
    ) {
      return parsed.map((p, i) => ({
        id: i + 1,
        goal: p.goal,
        status: "pending",
      }));
    }
  } catch (err) {
    console.warn("[plan] Model returned unparseable plan JSON:", err.message);
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
      const { completion: planCompletion, provider } =
        await createCompletionWithFallback(
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
          state.turbo,
        );

      if (state.currentProvider && state.currentProvider !== provider) {
        yield {
          type: "provider_switch",
          from: state.currentProvider,
          to: provider,
        };
      }
      state.currentProvider = provider;

      const raw = planCompletion.choices[0]?.message?.content || "";
      const parsed = tryParsePlan(raw);
      if (!parsed) {
        console.warn(
          "[plan] Falling back to a single sub-goal (planner output was not a usable plan).",
        );
      }
      state.subGoals = parsed || [
        { id: 1, goal: state.task, status: "pending" },
      ];
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
      console.error("[plan] Planning request failed:", err?.message || err);
      yield {
        type: "status",
        text: `Planning failed (${err?.message || err}) -- running the task as a single sub-goal.`,
      };
      state.subGoals = [{ id: 1, goal: state.task, status: "pending" }];
    }

    yield {
      type: "plan",
      subGoals: state.subGoals.map((g) => ({ id: g.id, goal: g.goal })),
    };
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
    const result = yield* runSubGoal(state, client, tools, signal, state.turbo);
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
      yield {
        type: "subgoal_done",
        id: subGoal.id,
        goal: subGoal.goal,
        summary: result.summary,
      };
      state.currentMessages = null;
    } else {
      subGoalTimer.end(`failed, ${stepsUsed} steps used`);
      subGoal.status = "failed";
      yield {
        type: "subgoal_failed",
        id: subGoal.id,
        goal: subGoal.goal,
        text: result.summary,
      };
      yield {
        type: "done",
        text: `Stopped: sub-goal "${subGoal.goal}" could not be completed. ${result.summary}`,
      };
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
async function* runSubGoal(state, client, tools, signal, useFallback = true) {
  const messages = state.currentMessages;
  const toolsWithFinish = [...tools, FINISH_SUBGOAL_TOOL];

  // The step loop tracker must govern all operations from the absolute top
  for (let step = state.currentStep; step < SUBGOAL_MAX_STEPS; step++) {
    state.currentStep = step;

    if (signal.aborted) {
      yield { type: "stopped", text: "Stopped by user." };
      return "stopped";
    }

    // 1. Unified Fallback and Caching Generation Hook
    let completionResult;
    try {
      completionResult = await createCompletionWithFallback(
        `step ${step}`,
        { messages: messages.map(sanitizeAssistantMessage), tools: toolsWithFinish },
        signal,
        useFallback
      );
    } catch (err) {
      if (signal.aborted) {
        yield { type: "stopped", text: "Stopped by user." };
        return "stopped";
      }
      console.error(`[agent] Completion failed at step ${step}:`, err?.message || err);
      yield { type: "error", text: `LLM request failed: ${err.message}` };
      return { ok: false, summary: `LLM request failed: ${err.message}` };
    }

    const completion = completionResult.completion;
    const activeProvider = completionResult.provider; // Extracts "cerebras", "groq", or "openrouter"

    // Yield provider switch metrics back to your UI loop to light up frontend badges
    if (state.currentProvider && state.currentProvider !== activeProvider) {
      yield { type: "provider_switch", from: state.currentProvider, to: activeProvider };
    }
    state.currentProvider = activeProvider;

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
      } catch (err) {
        console.warn(
          `[agent] Malformed finish_subgoal arguments (${err.message}); treating the sub-goal as unverified.`,
        );
        finishArgs = {};
      }
      const success = finishArgs.success === true;
      const summary =
        typeof finishArgs.summary === "string" && finishArgs.summary.trim()
          ? finishArgs.summary.trim()
          : success
            ? "Done."
            : "Could not complete this sub-goal.";
      return { ok: success, summary };
    }

    // 2. Active Tool Dispatch and Execution Loop Block
    for (const call of toolCalls) {
      if (signal.aborted) {
        yield { type: "stopped", text: "Stopped by user." };
        return "stopped";
      }

      let args = {};
      let argsError = null;
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch (err) {
        // Don't quietly call the tool with {} -- that produces a confusing
        // downstream failure. Report the parse error back to the model so it
        // can re-issue the call correctly.
        argsError = err.message;
        args = {};
      }

      yield { type: "action", tool: call.function.name, input: args };

      let mcpResult;
      const toolTimer = timer(`tool: ${call.function.name}`);
      try {
        if (argsError) {
          mcpResult = {
            isError: true,
            content: [
              {
                type: "text",
                text: `Invalid call: arguments were not valid JSON (${argsError}). Re-issue the call with a valid JSON arguments object.`,
              },
            ],
          };
        } else if (call.function.name === "browser_find" && !args.text && !args.regex) {
          mcpResult = {
            isError: true,
            content: [{ type: "text", text: 'Invalid call: browser_find requires either "text" or "regex".' }],
          };
        } else {
          // Execute the native Playwright tool call normally over your CDP channel
          mcpResult = await client.callTool({ name: call.function.name, arguments: args });

          // =========================================================================
          // 🛡️ EMERGENCY FIREWALL FAILOVER INTERCEPTOR HOOK: Detects Google Blocks
          // =========================================================================
                    // =========================================================================
          // 🛡️ REBUILT FIREWALL FAILOVER INTERCEPTOR: Complete Parameter Routing
          // =========================================================================
          const rawResponseText =
            typeof mcpResult?.content?.[0]?.text === "string"
              ? mcpResult.content[0].text
              : "";

          const isGoogleCaptcha =
            rawResponseText.includes("sorry/index") || 
            rawResponseText.includes("captcha") || 
            rawResponseText.includes("HTTP status: 429") ||
            rawResponseText.includes("Too Many Requests");

          if (isGoogleCaptcha) {
            console.log("⚠️ [Failover Shield] Hard Google CAPTCHA block detected! Initiating emergency reroute sequence...");
            
            // =========================================================================
            // ✅ THE PERFECT REPAIR: Pulls your live active task query dynamically
            // =========================================================================
            let extractedQuery = args.text || args.value || args.q || state.task || "web search";
            // =========================================================================
            
            const fallbackUrl =
              "https://duckduckgo.com/?q=" + encodeURIComponent(extractedQuery);
            
            yield { 
              type: "status", 
              text: `⚠️ Google CAPTCHA triggered. Auto-rerouting query [${extractedQuery}] to DuckDuckGo...` 
            };

            console.log("[Failover Shield] Navigating to dynamic route: " + fallbackUrl);

            // If the reroute itself fails, say so explicitly -- otherwise the
            // model just sees a bare tool error and never learns that the
            // original page was CAPTCHA-blocked.
            try {
              await client.callTool({
                name: "browser_navigate",
                arguments: { url: fallbackUrl }
              });

              mcpResult = await client.callTool({
                name: "browser_snapshot",
                arguments: { depth: 4 }
              });

              // Append a structural note so the model adapts its parsing instantly
              if (typeof mcpResult?.content?.[0]?.text === "string") {
                mcpResult.content[0].text = `[SYSTEM ARCHITECTURE ADJUSTMENT: The primary Google query encountered a hard network block. The system automatically executed a real-time failover reroute to DuckDuckGo to fetch your results. Please extract your final data directly from this clean DuckDuckGo text array layout]:\n` + mcpResult.content[0].text;
              }
            } catch (failoverErr) {
              console.error("[Failover Shield] Reroute to DuckDuckGo failed:", failoverErr.message);
              mcpResult = {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: `The page was blocked by a CAPTCHA / rate limit, and the automatic reroute to DuckDuckGo also failed: ${failoverErr.message}. Try a different site or approach.`,
                  },
                ],
              };
            }
          }
          // =========================================================================

          // Your existing token compression shims follow down here completely safely
          if (mcpResult && mcpResult.content) {
            mcpResult.content = mcpResult.content.map((item) => {
              if (item.type === "text" && item.text.includes("<")) {
                console.log(`[Token Compressor] Intercepted raw code layout on: ${call.function.name}. Scrubbing bloat...`);
                return { ...item, text: dropTokenWaste(item.text) };
              }
              return item;
            });
          }
        }
      } catch (err) {
        console.error(`[agent] Tool ${call.function.name} failed:`, err.message);
        mcpResult = { isError: true, content: [{ type: "text", text: `Tool error: ${err.message}` }] };
      }
      toolTimer.end();

      if (signal.aborted) {
        yield { type: "stopped", text: "Stopped by user." };
        return "stopped";
      }

      const summary = summarizeMcpResult(mcpResult);
      yield { type: "observation", tool: call.function.name, ...summary };

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: summary.text,
      });
    }
  }

  return {
    ok: false,
    summary: "Reached step limit for this sub-goal without finishing.",
  };
}


async function runAndHandle(
  taskId,
  task,
  client,
  state,
  send,
  res,
  abortController,
  { sendStart, skipCache = false, record = false },
) {
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
    for await (const event of runAgent(
      state,
      client,
      tools,
      abortController.signal,
    )) {
      sendAndRecord(event);
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      console.log(`Task ${taskId} ended after abort: ${err?.message || err}`);
    } else {
      console.error(err);
      sendAndRecord({ type: "error", text: err.message || String(err) });
    }
  } finally {
    activeTasks.delete(taskId);
    activeCount--;

    taskTimer.end(
      rateLimitedNow
        ? "paused, will resume"
        : completedNormally
          ? "completed"
          : "ended",
    );

    if (rateLimitedNow) {
      pausedTasks.set(taskId, {
        task,
        client,
        state,
        send,
        res,
        abortController,
        skipCache,
        record,
      });
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
            sendAndRecord({
              type: "recording",
              url: `/recordings/${taskId}/${video}`,
            });
          }
        } catch (err) {
          if (err.code === "ENOENT") {
            console.warn(`No recording directory for task ${taskId}.`);
          } else {
            console.error(`Failed to read recordings for task ${taskId}:`, err.message);
          }
          sendAndRecord({
            type: "status",
            text: "Recording was requested but no video could be retrieved for this run.",
          });
        }
      }

      if (completedNormally && !skipCache) {
        setCached(task, recordedEvents);
      }
      try {
        res.end();
      } catch (endErr) {
        console.error(`Failed to close stream for task ${taskId}:`, endErr.message);
      }
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
    console.error(`Failed to start browser session for task ${taskId}:`, err?.message || err);
    send({
      type: "error",
      text: `Failed to start browser session: ${err?.message || err}`,
    });
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

  await runAndHandle(taskId, task, client, state, send, res, abortController, {
    sendStart: true,
    skipCache,
    record,
  });
}

// runAndHandle owns its own error reporting, but its finally block still
// touches the socket -- so scheduling callers must not leave a rejection
// floating (an unhandled rejection takes the whole server down on Node 20).
function reportSchedulingFailure(taskId, err) {
  console.error(`Task ${taskId} failed outside the agent loop:`, err?.message || err);
}

function resumeTask(taskId) {
  const paused = pausedTasks.get(taskId);
  if (!paused) return false;

  pausedTasks.delete(taskId);
  activeCount++;
  const { task, client, state, send, res, abortController, skipCache } = paused;

  runAndHandle(taskId, task, client, state, send, res, abortController, {
    sendStart: false,
    skipCache,
  }).catch((err) => reportSchedulingFailure(taskId, err));
  return true;
}

function tryStartNext() {
  while (activeCount < MAX_CONCURRENT_TASKS && queue.length > 0) {
    const item = queue.shift();
    if (item.cancelled) continue;
    startTask(item).catch((err) => reportSchedulingFailure(item.taskId, err));
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
      cooldownEndsIn:
        Date.now() < p.disabledUntil
          ? Math.round((p.disabledUntil - Date.now()) / 1000)
          : 0,
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

  // The client can disappear mid-run (tab closed, network drop). Writing to a
  // finished response throws, which would otherwise escape from deep inside
  // the agent loop and abort cleanup; log and drop the event instead.
  const send = (event) => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(JSON.stringify(event) + "\n");
    } catch (err) {
      console.error(`Failed to stream event to client for task ${taskId}:`, err.message);
    }
  };

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
  const item = {
    taskId,
    task,
    send,
    res,
    abortController,
    cancelled: false,
    skipCache,
    turbo,
    record,
  };

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
  send({
    type: "queued",
    taskId,
    position: queue.length,
    queueLength: queue.length,
  });

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
      paused.client
        .close()
        .catch((err) => console.error("Error closing MCP client", err));
    }
    paused.res.end();
    res.json({ stopped: true });
    return;
  }

  res.json({
    stopped: false,
    message: "No task with that ID is queued, running, or paused.",
  });
});

app.listen(PORT, () => {
  purgeOldProfiles();
  console.log(`Wayfinder API running at http://localhost:${PORT}`);
  console.log(`Accepting requests from ${FRONTEND_ORIGIN}`);
  console.log(
    `Max concurrent tasks: ${MAX_CONCURRENT_TASKS} (queuing + resume-in-place + sub-goal decomposition + finish_subgoal + smart caching + timing + fallback chain [cerebras${groqEnabled ? " -> groq" : ""}${openrouterEnabled ? " -> openrouter" : ""}] + turbo toggle enabled)`,
  );
  fillPool().catch((err) =>
    console.error("Initial pool warm-up failed:", err.message),
  );
});

// Anything that escapes the per-task handlers would otherwise take the whole
// server -- and every in-flight task with it -- down without explanation.
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[fatal] Uncaught exception:", err);
});