# Moodle Report — AI-Powered LMS Analytics

> **Ask your Moodle instance anything. Get structured answers in seconds.**

Moodle Report is the customer-facing brand for an open-source MCP (Model Context Protocol) server that connects AI agents directly to Moodle's Web Services API. The technical platform and OSS package are named `moodle-mcp-server`.

Instead of learning report builders, writing SQL, or exporting CSVs, you ask questions in plain English — the AI agent queries your LMS and returns structured data.

---

## Features

- **14 core query tools** — course catalog, completion reports, user enrollment, assignments, activity feeds, category navigation, and more
- **LLM-agnostic** — works with Claude, GPT, Gemini, Ollama, or any MCP-compatible AI client
- **Zero LMS modification** — uses Moodle's existing Web Services API, no plugin installation required
- **Smart caching** — course catalog loaded into memory at startup, subsequent queries nearly instant
- **Read-only** — never modifies Moodle data, safe for production
- **Plugin-extensible** — drop new tool modules into a directory, they auto-register

---

## Quick Start

### Prerequisites

- Node.js 20+
- A Moodle instance with Web Services enabled
- A Moodle API token (Site administration → Plugins → Web services → Manage tokens)

### Setup

```bash
# Clone the repo
git clone https://github.com/csmediapro/moodle-mcp-server
cd moodle-mcp-server

# Install dependencies
npm install

# Configure
cp packages/server/.env.example packages/server/.env
# Edit .env: add your MOODLE_URL and MOODLE_TOKEN

# Run (stdio mode)
npm run server:build
node packages/server/dist/index.js
```

### Config identity

The core owns two different server identity fields:

- `server.id` — stable machine identity, for example `mcp_8f3k2q9x`
- `server.name` — human-facing display label

If `server.id` is missing, the core generates one once and persists it to the resolved config file before startup continues.

Environment overrides:

- `MOODLE_MCP_CONFIG` or `MOODLE_MCP_SERVER_CONFIG` — choose the config file path
- `SERVER_ID` — explicit `server.id` override
- `SERVER_NAME` — explicit `server.name` override
- `SERVER_VERSION` — explicit `server.version` override

If `server.id` is missing and the resolved config path is not writable, startup fails deliberately.

### Using the reference client

```bash
# From the project root
cp packages/client/.env.example packages/client/.env
npm run client:dev
# Open http://localhost:3000
```

The client will auto-detect your Moodle instance and present a chat interface where you can ask questions in plain English.

---

## Connecting an LLM

Moodle Report needs an AI model to power the natural-language interface. You bring the model — the `moodle-mcp-server` core and reference client support any MCP-compatible provider.

### Option 1: Run Locally (Recommended for Speed & Privacy)

Running a local model keeps all data on your own hardware — nothing leaves your network. Modern quantized models run well on consumer GPUs and even CPU-only setups.

**Performance:** A quantized 24B model on a single RTX 3090 delivers ~1.5-second responses after the first query — faster than most cloud APIs once the cache is warm.

#### Via Ollama (easiest)

```bash
# Install Ollama: https://ollama.com
ollama pull gemma3:12b      # Fast, reliable tool use (~200ms TTFT)
ollama pull qwen3:14b       # Strong reasoning, good for complex queries
ollama pull deepseek-r1:14b # Excellent at multi-step chains
```

Then point the reference client at `http://localhost:11434` (Ollama's default).

#### Via llama.cpp (maximum control)

```bash
# Download a GGUF model (example: Devstral 24B Q4)
# Run the llama.cpp server:
llama-server -m devstral-24b-Q4_K_M.gguf --ctx-size 60000 --port 8080
```

Point the reference client at `http://localhost:8080/v1`.

#### Recommended local models

| Model | Size | Best For | Hardware |
|---|---|---|---|
| Gemma 3 12B | ~7 GB VRAM | Fast tool calls, straightforward queries | Single consumer GPU |
| Qwen 3 14B | ~8.5 GB VRAM | Complex reasoning, multi-tool chains | Single consumer GPU |
| Devstral 24B Q4 | ~14.5 GB VRAM | Maximum capability, 60K context | RTX 3090 / 4090 |

### Option 2: Cloud Providers

**Anthropic (Claude):**
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```
Select "Anthropic" in the reference client's provider dropdown. Claude Sonnet offers the most reliable tool-calling behavior.

**OpenAI (GPT):**
```bash
export OPENAI_API_KEY=sk-...
```
Select "OpenAI" in the provider dropdown. GPT-4o performs well on structured queries.

**Ollama Cloud:**
Uses the same API as local Ollama, hosted at `https://ollama.com/v1`. Good middle ground — faster than local cold starts, more private than big cloud providers.

### Option 3: Claude Desktop (Direct MCP)

Claude Desktop connects to the `moodle-mcp-server` core directly over stdio — no reference client needed.

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "moodle-mcp-server": {
      "command": "node",
      "args": ["/path/to/moodle-mcp-server/packages/server/dist/index.js"],
      "env": {
        "MOODLE_URL": "https://your-moodle-instance.com",
        "MOODLE_TOKEN": "your-api-token"
      }
    }
  }
}
```

Restart Claude Desktop. The server's tools will appear in Claude's tool list — ask questions directly.

---

## Tools

### Core Tools (free, open source — AGPL)

| Tool | Description |
|---|---|
| `list_courses` | Full course catalog with category drill-down |
| `get_course` | Detail view for any course |
| `list_course_users` | Enrolled users with roles and access data (now supports course name search with interactive selection) |
| `list_assignments` | All assignments with due dates |
| `get_recent_activity` | Activity feed for any course |
| `get_course_completion_report` | Server-side join: users × completion status |
| `get_user_progress_report` | User progress report showing courses, grades, and completion status (now supports course name search) |
| `list_categories` | Full hierarchy with exact parent resolution |
| `get_site_info` | Instance overview — site name, version, course count |
| `get_user` | Detail view for a Moodle user |
| `list_user_courses` | Courses for a specific user |
| `search_users` | User search by exact profile fields |
| `search_courses_by_name` | Search for courses by name with partial matching and interactive selection |

### Premium Plugins (available separately)

- **Advanced Reporting** — gradebooks, cross-course comparison, custom report builder
- **User Analytics** — progress tracking, engagement scoring, risk flags
- **Compliance Pack** — certification tracking, expiration alerts, audit exports

Learn more at [csmediapro.com/moodlereport](https://csmediapro.com/moodlereport).

---

## Architecture

```
User (plain English question)
    │
    ▼
AI Agent (Claude / GPT / Gemini / Ollama / local)
    │
    ▼  MCP Protocol
`moodle-mcp-server`
    ├── Tool Registry (core + plugins)
    ├── Cache Layer (in-memory course catalog)
    └── Moodle Client (REST API calls)
    │
    ▼
Moodle Web Services API
```

### Transport modes

- **Stdio** — `dist/index.js` — runs as a subprocess, used by Claude Desktop and similar clients

The OSS core intentionally ships with `stdio` only. Any network-facing wrapper, remote supervision, or premium plugin attachment belongs in a separate commercial node agent or wrapper.

### Plugin docs

- [Plugin Contract](./docs/plugins/CONTRACT.md)
- [Creating Plugins](./docs/plugins/CREATING-PLUGINS.md)
- [Hello Plugin Example](./examples/plugins/hello-plugin)

---

## License

AGPL v3 — see [LICENSE](LICENSE).

This means you can:
- ✅ Use the `moodle-mcp-server` core for free, in any environment
- ✅ Modify the source code for your needs
- ✅ Build and distribute derivative works

You cannot:
- ❌ Repackage the `moodle-mcp-server` core as a closed-source competing commercial product
- ❌ Offer it as a network service without sharing your modifications

---

## Built by CSMediaPro

Moodle Report is built and maintained by [CSMediaPro](https://csmediapro.com), a software development company specializing in AI integration, systems engineering, and workflow automation.

- **Product page:** [csmediapro.com/moodlereport](https://csmediapro.com/moodlereport)
- **Contact:** contact@csmediapro.com