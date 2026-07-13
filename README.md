# Wayfinder — an LLM that drives a browser via Playwright MCP

A task console: you give it a task in plain English, and an LLM on Groq drives
a real browser (through the official [Playwright MCP server](https://github.com/microsoft/playwright-mcp))
to complete it — while you watch every thought, tool call, and result live in
a "flight recorder" style console. Now split into a **React frontend** and a
standalone **Express API backend**.

```
wayfinder/
├── backend/     Express API -- runs the agent loop, talks to Groq + Playwright MCP
└── frontend/    React (Vite) app -- the console UI
```

## How it works

```
React app (5173)  --POST /api/task-->  Express API (3000)  --stdio-->  Playwright MCP --> real browser
                    <--ndjson stream--        |
                                        Groq API (tool calling)
```

1. The backend spawns `npx @playwright/mcp@latest` as a child process and
   talks to it over MCP (Model Context Protocol) via stdio.
2. It asks the MCP server for its tool list and hands it straight to Groq in
   the standard OpenAI `tools` format.
3. It loops: the model picks a tool, the backend calls it through MCP, the
   result goes back into the conversation, and this repeats until the model
   reports the task done, a step limit is hit, or you hit Stop.
4. Every thought / action / observation streams to the frontend as
   newline-delimited JSON (ndjson) over a single HTTP response, and React
   renders it live as it arrives.

## Setup

Requirements: Node.js 18+, a free Groq API key.

### 1. Backend

```bash
cd backend
npm install
npx playwright install chromium   # one-time browser download for Playwright MCP
cp .env.example .env
# edit .env and paste your GROQ_API_KEY
npm start
```

Get a free key at **https://console.groq.com/keys**. The API runs on
**http://localhost:3000**.

### 2. Frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**. During development, Vite proxies `/api/*`
requests straight to the backend on port 3000 (see `vite.config.js`), so
there's nothing to configure for CORS locally.

Try a task like:

> Go to news.ycombinator.com and tell me the top 3 story titles right now

## Configuration

**`backend/.env`**

| Variable | Purpose |
|---|---|
| `GROQ_API_KEY` | required, from https://console.groq.com/keys |
| `GROQ_MODEL` | defaults to `openai/gpt-oss-120b` |
| `PORT` | backend port, default `3000` |
| `FRONTEND_ORIGIN` | allowed CORS origin, default `http://localhost:5173` -- update if you deploy the frontend elsewhere |
| `PLAYWRIGHT_HEADED` | set `true` to see the actual browser window (needs a display) instead of running headless |

**Frontend** (optional): if you deploy the frontend separately from the
backend (i.e. not using the Vite dev proxy), set `VITE_API_URL` in a
`frontend/.env` file to the backend's full origin, e.g.:
```
VITE_API_URL=https://your-backend.example.com
```

## Building for production

```bash
cd frontend
npm run build
```
This outputs static files to `frontend/dist/` that you can serve from any
static host (Vercel, Netlify, nginx, etc.) or from the Express backend itself
if you'd rather serve both from one process (add `express.static` for
`frontend/dist` in `server.js` and drop the CORS/proxy setup).

## Notes & limits

- One task runs at a time (the backend rejects a new request with 409 while
  busy) since a single browser/MCP session is shared.
- The agent stops itself after 25 tool-call rounds to avoid runaway loops, or
  earlier if you click **Stop**.
- Groq's free tier is rate-limited -- if a task errors out mid-run, it's
  likely hit that limit; wait and retry.
- Nothing here handles login walls or CAPTCHAs -- the agent is told to stop
  and explain rather than guess if it hits one.
- This is a local dev tool, not hardened for the open internet: don't expose
  the backend publicly without adding auth, since anyone who can reach it can
  make your server browse the web on your behalf.

## Extending it

- Swap the `groq.chat.completions.create` calls in `backend/server.js` for
  any other OpenAI-compatible provider by pointing the SDK at a different
  base URL and key.
- Add more MCP servers alongside Playwright MCP by spawning additional
  `Client` instances in the backend and merging their tool lists.
- The browser/MCP session persists across requests already (via the shared
  `mcpClient` in the backend), so a user could issue a follow-up task against
  the same page with a small frontend addition (e.g. a running task history).
