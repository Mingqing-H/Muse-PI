# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: MUSE PI

A local web-based chat interface for LLM APIs and Pi CLI (a local coding agent). Chinese UI throughout. Zero-build-step project — no package managers, no bundler, no external Python dependencies.

## Commands

```bash
# Start server (serves frontend on http://127.0.0.1:9000)
python backend/server.py
python backend/server.py --no-open --port 9000

# Run tests
python -m unittest tests.test_pi_projects

# Windows shortcut
start_server.bat
```

No build step. Frontend is served as static files directly.

## Architecture

### Backend (`backend/server.py`) — Single-file monolith (~2160 lines)

- `MusePiHandler` extends `SimpleHTTPRequestHandler`, serves `frontend/` as static files
- REST API under `/api/` (GET/POST/DELETE) — see endpoint summary below
- SQLite database at `~/.musepi/musepi.sqlite` (schema version 7), tables: `app_meta`, `model_provider_configs`, `chat_sessions`, `chat_messages`
- Pi CLI integration: spawns `pi --print` subprocess, streams stdout as NDJSON
- Provider presets: MiMo, OpenAI, DeepSeek, Qwen, GLM, Kimi, SiliconFlow, Pi CLI
- Tab lifecycle: `/api/hello` + `/api/bye` heartbeat — server exits when all tabs close
- Port management: auto-cleans old processes on same port, auto-finds next available port

### Frontend (`frontend/`) — Vanilla SPA (no framework)

- `index.html` → `scripts/app.js` (~4230 lines) → `styles/main.css` (~4330 lines)
- CDN libraries: `marked`, `DOMPurify`, `MathJax 3`
- 4 tab views: Projects, Chat, Agent (Pi CLI), Config
- Dual-mode chat: "Chat" (direct API SSE) and "Agent" (Pi CLI NDJSON via `/api/cli/chat`)
- State: global cache vars synced to SQLite via API, localStorage fallback for `file://` mode
- CSS: two themes in one file — MUSE dark theme + anime-light/glass override
- Features: session model switching, @file references, background customization

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/state` | Full app state (config, projects, sessions, piCli info) |
| GET/POST/DELETE | `/api/config` | Provider configuration CRUD |
| GET/POST/DELETE | `/api/sessions` | Chat sessions read/write/delete |
| POST | `/api/active-session` | Set active session |
| POST | `/api/active-project` | Set active project |
| GET | `/api/pi-projects` | List Pi projects |
| GET | `/api/pi-sessions?projectId=X` | List sessions for a project |
| POST | `/api/pi-project` | Create Pi project |
| DELETE | `/api/pi-session` | Delete Pi session file |
| DELETE | `/api/pi-project` | Delete Pi project directory |
| POST | `/api/cli/chat` | Streaming CLI chat (NDJSON) |
| GET | `/api/pi-cli-info` | Get Pi CLI installation info |
| GET | `/api/pi-skills` | List project available Skills |
| GET | `/api/project-files` | Search project files by keyword |
| GET | `/api/project-image` | Serve images from project folders |
| GET | `/api/pi-models` | List Pi CLI available models |
| POST | `/api/hello` | Tab comes online (heartbeat) |
| POST | `/api/bye` | Tab goes offline; server exits when all tabs close |

## Key Patterns

- **Streaming:** `readOpenAIStream()` for SSE from OpenAI-compatible APIs; `readCliStream()` for NDJSON from Pi CLI
- **Markdown:** `renderMarkdown()` uses marked + DOMPurify, extracts LaTeX for MathJax
- **CSS cache busting:** query-string versioning (`?v=20260605-...`)
- **Dual storage:** SQLite when served via HTTP, localStorage when opened as `file://`
- **Design system:** defined in `MUSE DESIGN.md` — dark luxury gallery aesthetic, gold accents, glass morphism
