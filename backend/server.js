import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PORT = process.env.PORT || 3000;
const MODEL = process.env.CEREBRAS_MODEL || "gpt-oss-120b";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const MAX_STEPS = 25;

if (!process.env.CEREBRAS_API_KEY) {
  console.error("Missing CEREBRAS_API_KEY. Copy .env.example to .env and add your key from https://cloud.cerebras.ai/");
  process.exit(1);
}

// Cerebras exposes an OpenAI-compatible API, so the standard `openai` SDK
// works as-is -- just point baseURL at Cerebras and use their key.
const cerebras = new OpenAI({
  apiKey: process.env.CEREBRAS_API_KEY,
  baseURL: "https://api.cerebras.ai/v1",
});

// Unlike Groq (which embeds a "try again in Xm Ys" string in the error
// message), Cerebras reports rate-limit resets via response headers, e.g.
// x-ratelimit-reset-tokens-minute: 11.38, x-ratelimit-reset-requests-day: 33011.4
// (seconds until that particular window resets). A 429 means at least one
// window was exceeded, so we take the largest reset value present to be safe.
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
// Playwright MCP session
// ---------------------------------------------------------------------------

let mcpClient = null;
let mcpTools = null;
let busy = false;
let currentAbort = null;

async function getMcpClient() {
  if (mcpClient) return mcpClient;

  const args = ["@playwright/mcp@latest"];
  if (process.env.PLAYWRIGHT_HEADED !== "true") args.push("--headless");

  const transport = new StdioClientTransport({
    command: "npx",
    args,
  });

  const client = new Client({ name: "playwright-llm-agent", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  mcpClient = client;
  return client;
}

// Cerebras's API follows the OpenAI tool-calling shape, which takes plain JSON
// schema directly -- no reshaping needed like some other providers require.
async function getTools() {
  if (mcpTools) return mcpTools;
  const client = await getMcpClient();
  const { tools } = await client.listTools();
  mcpTools = tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || t.name,
      parameters: t.inputSchema || { type: "object", properties: {} },
    },
  }));
  return mcpTools;
}

// Pull a plain-text + optional screenshot summary out of an MCP tool result.
// GPT-OSS on Cerebras is text-only, so screenshots are shown to the user in the
// UI but not sent back into the model as image data -- only their text
// content (e.g. accessibility snapshots) goes back into the conversation.
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
complete the user's task.

Guidelines:
- Break the task into small steps. Use the browser tools to navigate, click, type, and read pages.
- You cannot see screenshots yourself -- use the accessibility snapshot / page content tools to read what's on the
  page and find elements. Only take a screenshot when the user would benefit from seeing one; it will be shown to
  them, not to you.
- If a page requires login credentials you don't have, stop and explain that to the user instead of guessing.
- When the task is complete, reply with a concise final summary of what you did and any relevant result (e.g. the
  information found, or confirmation of the action taken). Do not call any more tools once you give the final summary.
- If you get stuck after several attempts, explain what's blocking you instead of repeating the same failing action.`;

async function* runAgent(task, signal) {
  const tools = await getTools();
  const client = await getMcpClient();

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: task },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) {
      yield { type: "stopped", text: "Stopped by user." };
      return;
    }

    let completion;
    try {
      completion = await cerebras.chat.completions.create(
        {
          model: MODEL,
          messages,
          tools,
          tool_choice: "auto",
          max_tokens: 2048,
        },
        { signal }
      );
    } catch (err) {
      if (signal.aborted) {
        yield { type: "stopped", text: "Stopped by user." };
        return;
      }

      const retryAfterSeconds = parseRetrySeconds(err);
      if (retryAfterSeconds !== null) {
        yield {
          type: "rate_limited",
          text: err?.error?.message || err?.message || "Rate limit reached on Cerebras.",
          retryAfterSeconds,
        };
        return;
      }

      throw err;
    }

    const msg = completion.choices[0].message;
    messages.push(msg);

    if (msg.content && msg.content.trim()) {
      yield { type: "thought", text: msg.content.trim() };
    }

    const toolCalls = msg.tool_calls || [];

    if (toolCalls.length === 0) {
      yield { type: "done", text: msg.content || "Task complete." };
      return;
    }

    for (const call of toolCalls) {
      if (signal.aborted) {
        yield { type: "stopped", text: "Stopped by user." };
        return;
      }

      let args = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = {};
      }

      yield { type: "action", tool: call.function.name, input: args };

      let mcpResult;
      try {
        mcpResult = await client.callTool({ name: call.function.name, arguments: args });
      } catch (err) {
        mcpResult = { isError: true, content: [{ type: "text", text: `Tool error: ${err.message}` }] };
      }

      if (signal.aborted) {
        yield { type: "stopped", text: "Stopped by user." };
        return;
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

  yield { type: "done", text: "Stopped after reaching the step limit. The task may be incomplete." };
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

const app = express();
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({ ok: true, busy });
});

app.post("/api/task", async (req, res) => {
  const task = (req.body?.task || "").trim();
  if (!task) {
    res.status(400).json({ error: "Missing task" });
    return;
  }
  if (busy) {
    res.status(409).json({ error: "The agent is already running a task. Wait for it to finish." });
    return;
  }

  busy = true;
  const abortController = new AbortController();
  currentAbort = abortController;

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (event) => res.write(JSON.stringify(event) + "\n");

  try {
    send({ type: "start", task });
    for await (const event of runAgent(task, abortController.signal)) {
      send(event);
    }
  } catch (err) {
    if (!abortController.signal.aborted) {
      console.error(err);
      send({ type: "error", text: err.message || String(err) });
    }
  } finally {
    busy = false;
    currentAbort = null;
    res.end();
  }
});

app.post("/api/stop", (req, res) => {
  if (currentAbort) {
    currentAbort.abort();
    res.json({ stopped: true });
  } else {
    res.json({ stopped: false, message: "No task is currently running." });
  }
});

app.listen(PORT, () => {
  console.log(`Wayfinder API running at http://localhost:${PORT}`);
  console.log(`Accepting requests from ${FRONTEND_ORIGIN}`);
});