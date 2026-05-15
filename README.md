# MoodleReport — AI-Powered LMS Analytics

> **Ask your Moodle instance anything. Get structured answers in seconds.**

MoodleReport is an open-source MCP (Model Context Protocol) server that connects AI agents directly to Moodle's Web Services API. Instead of learning report builders, writing SQL, or exporting CSVs, you ask questions in plain English — the AI agent queries your LMS and returns structured data.

---

## Features

- **8 core query tools** — course catalog, completion reports, user enrollment, assignments, activity feeds, category navigation, and more
- **LLM-agnostic** — works with Claude, GPT, Gemini, Ollama, or any MCP-compatible AI client
- **Zero LMS modification** — uses Moodle's existing Web Services API, no plugin installation required
- **Smart caching** — course catalog loaded into memory at startup, subsequent queries nearly instant
- **Read-only** — never modifies Moodle data, safe for production
- **Self-hosted** — all data stays on your infrastructure
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

### Using the reference client

```bash
# From the project root
cp packages/client/.env.example packages/client/.env
npm run client:dev
# Open http://localhost:3000
```

The client will auto-detect your Moodle instance and present a chat interface where you can ask questions in plain English.

---

## Tools

### Core Tools (free, open source — AGPL)

| Tool | Description |
|---|---|
| `list_courses` | Full course catalog with category drill-down |
| `get_course` | Detail view for any course |
| `list_course_users` | Enrolled users with roles and access data |
| `list_assignments` | All assignments with due dates |
| `get_recent_activity` | Activity feed for any course |
| `get_course_completion_report` | Server-side join: users × completion status |
| `list_categories` | Full hierarchy with exact parent resolution |
| `get_site_info` | Instance overview — site name, version, course count |

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
AI Agent (Claude / GPT / Gemini / Ollama)
    │
    ▼  MCP Protocol
MoodleReport Server
    ├── Tool Registry (core + plugins)
    ├── Cache Layer (in-memory course catalog)
    └── Moodle Client (REST API calls)
    │
    ▼
Moodle Web Services API
```

### Transport modes

- **Stdio** — `dist/index.js` — runs as a subprocess, used by Claude Desktop and similar clients
- **Streamable HTTP** — `dist/entry/http.js` — exposed over HTTP with API key authentication

---

## License

AGPL v3 — see [LICENSE](LICENSE).

This means you can:
- ✅ Use MoodleReport for free, in any environment
- ✅ Modify the source code for your needs
- ✅ Build and distribute derivative works

You cannot:
- ❌ Repackage MoodleReport as a closed-source competing commercial product
- ❌ Offer it as a network service without sharing your modifications

---

## Built by CSMediaPro

MoodleReport is built and maintained by [CSMediaPro](https://csmediapro.com), a software development company specializing in AI integration, systems engineering, and workflow automation.

- **Product page:** [csmediapro.com/moodlereport](https://csmediapro.com/moodlereport)
- **Contact:** contact@csmediapro.com
