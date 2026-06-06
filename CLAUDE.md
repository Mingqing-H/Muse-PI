# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: LLM Studio

A local web-based chat interface for LLM APIs and Pi CLI (a local coding agent). Chinese UI throughout. Zero-build-step project — no package managers, no bundler, no external Python dependencies.

## Commands

```bash
# Start server (serves frontend on http://127.0.0.1:8765)
python backend/server.py
python backend/server.py --no-open --port 9000

# Run tests
python -m unittest tests.test_pi_projects

# Windows shortcut
start_server.bat
```

No build step. Frontend is served as static files directly.

## Architecture

### Backend (`backend/server.py`) — Single-file monolith (~1670 lines)

- `LLMStudioHandler` extends `SimpleHTTPRequestHandler`, serves `frontend/` as static files
- REST API under `/api/` (GET/POST/DELETE) — see endpoint summary below
- SQLite database at `data/llm_studio.sqlite` (schema version 6), tables: `app_meta`, `model_provider_configs`, `chat_sessions`, `chat_messages`
- Pi CLI integration: spawns `pi --print` subprocess, streams stdout as NDJSON
- Provider presets: MiMo, OpenAI, DeepSeek, Qwen, GLM, Kimi, SiliconFlow, Pi CLI

### Frontend (`frontend/`) — Vanilla SPA (no framework)

- `index.html` → `scripts/app.js` (~2585 lines) → `styles/main.css` (~2875 lines)
- CDN libraries: `marked`, `DOMPurify`, `MathJax 3`
- 4 tab views: Projects, Chat, Agent (Pi CLI), Config
- Dual-mode chat: "Chat" (direct API SSE) and "Agent" (Pi CLI NDJSON via `/api/cli/chat`)
- State: global cache vars synced to SQLite via API, localStorage fallback for `file://` mode
- CSS: two themes in one file — MUSE dark theme + anime-light/glass override (applied at ~line 1861)

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/state` | Full app state (config, projects, sessions, piCli info) |
| GET/POST/DELETE | `/api/config` | Provider configuration CRUD |
| GET/POST | `/api/sessions` | Chat sessions read/write |
| POST | `/api/active-session` | Set active session |
| POST | `/api/active-project` | Set active project |
| GET | `/api/pi-projects` | List Pi projects |
| GET | `/api/pi-sessions?projectId=X` | List sessions for a project |
| POST | `/api/pi-project` | Create Pi project |
| DELETE | `/api/pi-session` | Delete Pi session file |
| DELETE | `/api/pi-project` | Delete Pi project directory |
| POST | `/api/cli/chat` | Streaming CLI chat (NDJSON) |
| GET | `/api/project-image` | Serve images from project folders |

## Key Patterns

- **Streaming:** `readOpenAIStream()` for SSE from OpenAI-compatible APIs; `readCliStream()` for NDJSON from Pi CLI
- **Markdown:** `renderMarkdown()` uses marked + DOMPurify, extracts LaTeX for MathJax
- **CSS cache busting:** query-string versioning (`?v=20260605-...`)
- **Dual storage:** SQLite when served via HTTP, localStorage when opened as `file://`
- **Design system:** defined in `MUSE DESIGN.md` — dark luxury gallery aesthetic, gold accents, glass morphism
