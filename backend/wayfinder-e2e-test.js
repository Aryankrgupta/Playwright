// test-fallback-tools.js
//
// Standalone sanity check: confirms a provider's chat completions endpoint
// actually returns proper OpenAI-style tool_calls when given a tool schema,
// before trusting it inside Wayfinder's fallback chain.
//
// Usage:
//   NVIDIA_NIM_API_KEY=nvapi-xxx SAMBANOVA_API_KEY=xxx node test-fallback-tools.js
//
// You can also test just one provider by only setting its key.

import "dotenv/config";
import OpenAI from "openai";

// A minimal fake tool -- similar shape to a Playwright MCP tool, so it
// exercises the same tool-calling path your agent relies on.
const TEST_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a city.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name" },
        },
        required: ["city"],
      },
    },
  },
];

const TEST_MESSAGES = [
  {
    role: "system",
    content:
      "You are a helpful assistant. When asked about weather, you MUST call the get_weather tool -- do not answer from your own knowledge.",
  },
  { role: "user", content: "What's the weather like in Tokyo right now?" },
];

const providers = [
  {
    name: "nvidia_nim",
    apiKey: process.env.NVIDIA_NIM_API_KEY,
    baseURL: "https://integrate.api.nvidia.com/v1",
    model: process.env.NVIDIA_NIM_MODEL || "meta/llama-3.3-70b-instruct",
  },
  {
    name: "sambanova",
    apiKey: process.env.SAMBANOVA_API_KEY,
    baseURL: "https://api.sambanova.ai/v1",
    model: process.env.SAMBANOVA_MODEL || "gpt-oss-120b",
  },
];

function summarizeToolCalls(toolCalls) {
  if (!toolCalls || toolCalls.length === 0) return null;
  return toolCalls.map((c) => ({
    name: c.function?.name,
    arguments: c.function?.arguments,
  }));
}

async function testProvider({ name, apiKey, baseURL, model }) {
  console.log(`\n--- Testing ${name} (model: ${model}) ---`);

  if (!apiKey) {
    console.log(`SKIPPED -- no API key set for ${name}.`);
    return { name, status: "skipped" };
  }

  const client = new OpenAI({ apiKey, baseURL });

  try {
    const start = Date.now();
    const completion = await client.chat.completions.create({
      model,
      messages: TEST_MESSAGES,
      tools: TEST_TOOLS,
    });
    const ms = Date.now() - start;

    const msg = completion.choices?.[0]?.message;
    const toolCalls = summarizeToolCalls(msg?.tool_calls);

    if (toolCalls) {
      console.log(`PASS (${ms}ms) -- got tool_calls:`);
      console.log(JSON.stringify(toolCalls, null, 2));
      return { name, status: "pass", ms };
    } else {
      console.log(`FAIL (${ms}ms) -- no tool_calls returned. Raw message:`);
      console.log(JSON.stringify(msg, null, 2));
      console.log(
        `This model likely does NOT reliably support tool calling -- ` +
          `do not use it as a fallback for the agent loop without further testing.`,
      );
      return { name, status: "fail_no_tool_calls", ms };
    }
  } catch (err) {
    console.log(`ERROR -- request failed for ${name}:`);
    console.log(err?.status, err?.error?.message || err?.message);
    return { name, status: "error", error: err?.message };
  }
}

async function main() {
  const results = [];
  for (const p of providers) {
    results.push(await testProvider(p));
  }

  console.log("\n=== Summary ===");
  for (const r of results) {
    console.log(`${r.name}: ${r.status}`);
  }
}

main();