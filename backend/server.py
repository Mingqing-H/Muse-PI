"""Local HTTP server and SQLite persistence for LLM Studio."""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import argparse
import json
import mimetypes
import os
import re
import shlex
import shutil
import sqlite3
import subprocess
import time
from urllib.parse import parse_qs, urlparse
import webbrowser
import uuid


ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "llm_studio.sqlite"

HOST = "127.0.0.1"
PORT = 8765

SCHEMA_VERSION = 6
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}

PRESET_URLS = {
    "MiMo": "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
    "OpenAI": "https://api.openai.com/v1/chat/completions",
    "DeepSeek": "https://api.deepseek.com/v1/chat/completions",
    "Qwen": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    "GLM": "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    "Kimi": "https://api.moonshot.cn/v1/chat/completions",
    "SiliconFlow": "https://api.siliconflow.cn/v1/chat/completions",
    "Pi CLI": "",
}


def now_ms():
    return int(time.time() * 1000)


def normalize_url(url):
    return (url or "").strip().rstrip("/")


def infer_provider(config):
    provider = (config or {}).get("provider")
    if provider:
        return provider

    api_url = normalize_url((config or {}).get("apiUrl"))
    for name, preset_url in PRESET_URLS.items():
        if normalize_url(preset_url) == api_url:
            return name
    return "custom"


def connect_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def db_connection():
    conn = connect_db()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def table_exists(conn, table_name):
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone()
    return bool(row)


def table_columns(conn, table_name):
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()}


def ensure_column(conn, table_name, column_name, definition):
    if column_name not in table_columns(conn, table_name):
        conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}")


def read_legacy_state(conn, key, default=None):
    if not table_exists(conn, "app_state"):
        return default
    row = conn.execute("SELECT value FROM app_state WHERE key = ?", (key,)).fetchone()
    if not row:
        return default
    try:
        return json.loads(row["value"])
    except json.JSONDecodeError:
        return default


def init_db():
    DATA_DIR.mkdir(exist_ok=True)
    with db_connection() as conn:
        create_schema(conn)
        migrate_legacy_app_state(conn)
        conn.execute(
            """
            INSERT INTO app_meta (key, value)
            VALUES ('schema_version', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (json.dumps(SCHEMA_VERSION),),
        )


def create_schema(conn):
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS model_provider_configs (
            provider TEXT PRIMARY KEY,
            api_url TEXT NOT NULL,
            api_key TEXT NOT NULL,
            model_name TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chat_sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'chat',
            project_id TEXT,
            mode TEXT NOT NULL DEFAULT 'chat',
            status TEXT NOT NULL DEFAULT 'idle',
            pi_session_path TEXT,
            pi_session_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            thinking_ms INTEGER,
            FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
            UNIQUE (session_id, position)
        );

        CREATE INDEX IF NOT EXISTS idx_chat_messages_session_position
            ON chat_messages(session_id, position);

        """
    )
    ensure_column(conn, "chat_sessions", "project_id", "TEXT")
    ensure_column(conn, "chat_sessions", "kind", "TEXT NOT NULL DEFAULT 'chat'")
    ensure_column(conn, "chat_sessions", "mode", "TEXT NOT NULL DEFAULT 'chat'")
    ensure_column(conn, "chat_sessions", "status", "TEXT NOT NULL DEFAULT 'idle'")
    ensure_column(conn, "chat_sessions", "pi_session_path", "TEXT")
    ensure_column(conn, "chat_sessions", "pi_session_id", "TEXT")
    ensure_column(conn, "chat_messages", "thinking_ms", "INTEGER")
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_project_updated
            ON chat_sessions(project_id, updated_at)
        """
    )


def migrate_legacy_app_state(conn):
    if not table_exists(conn, "app_state"):
        return

    already_migrated = conn.execute(
        "SELECT value FROM app_meta WHERE key = 'legacy_app_state_migrated'"
    ).fetchone()
    if already_migrated:
        conn.execute("DROP TABLE IF EXISTS app_state")
        return

    legacy_config = read_legacy_state(conn, "config")
    legacy_sessions = read_legacy_state(conn, "sessions", {})
    legacy_active_id = read_legacy_state(conn, "activeId")

    if legacy_config:
        save_config(conn, legacy_config)
    if legacy_sessions:
        save_sessions(conn, legacy_sessions)
    if legacy_active_id:
        set_meta(conn, "active_session_id", legacy_active_id)

    set_meta(conn, "legacy_app_state_migrated", True)
    conn.execute("DROP TABLE IF EXISTS app_state")


def set_meta(conn, key, value):
    conn.execute(
        """
        INSERT INTO app_meta (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """,
        (key, json.dumps(value, ensure_ascii=False)),
    )


def get_meta(conn, key, default=None):
    row = conn.execute("SELECT value FROM app_meta WHERE key = ?", (key,)).fetchone()
    if not row:
        return default
    try:
        return json.loads(row["value"])
    except json.JSONDecodeError:
        return default


def delete_meta(conn, *keys):
    conn.executemany("DELETE FROM app_meta WHERE key = ?", [(key,) for key in keys])


def normalize_config_store(config):
    if not config:
        return {"activeChatProvider": None, "activeAgentProvider": None, "providers": {}}

    if isinstance(config, dict) and isinstance(config.get("providers"), dict):
        providers = config.get("providers") or {}
        active_provider = config.get("activeProvider")
        active_chat_provider = config.get("activeChatProvider")
        active_agent_provider = config.get("activeAgentProvider")
        if not active_chat_provider and active_provider and active_provider != "Pi CLI":
            active_chat_provider = active_provider
        if not active_agent_provider and active_provider == "Pi CLI":
            active_agent_provider = active_provider
        if not active_chat_provider:
            active_chat_provider = next((name for name in providers if name != "Pi CLI"), None)
        if not active_agent_provider:
            active_agent_provider = "Pi CLI" if "Pi CLI" in providers else None
        return {
            "activeChatProvider": active_chat_provider,
            "activeAgentProvider": active_agent_provider,
            "providers": providers,
        }

    if isinstance(config, dict) and any(config.get(k) for k in ("apiUrl", "apiKey", "modelName")):
        provider = infer_provider(config)
        is_agent_provider = provider == "Pi CLI"
        return {
            "activeChatProvider": None if is_agent_provider else provider,
            "activeAgentProvider": provider if is_agent_provider else None,
            "providers": {
                provider: {
                    "provider": provider,
                    "apiUrl": config.get("apiUrl", ""),
                    "apiKey": config.get("apiKey", ""),
                    "modelName": config.get("modelName", ""),
                }
            },
        }

    return {"activeChatProvider": None, "activeAgentProvider": None, "providers": {}}


def save_config(conn, config):
    store = normalize_config_store(config)
    timestamp = now_ms()

    set_meta(conn, "active_chat_provider", store.get("activeChatProvider"))
    set_meta(conn, "active_agent_provider", store.get("activeAgentProvider"))
    set_meta(conn, "active_provider", store.get("activeChatProvider") or store.get("activeAgentProvider"))

    if isinstance(config, dict) and isinstance(config.get("providers"), dict):
        incoming_providers = set(store["providers"].keys())
        if incoming_providers:
            placeholders = ",".join("?" for _ in incoming_providers)
            conn.execute(
                f"DELETE FROM model_provider_configs WHERE provider NOT IN ({placeholders})",
                tuple(incoming_providers),
            )
        else:
            conn.execute("DELETE FROM model_provider_configs")

    for provider, provider_config in store["providers"].items():
        if not provider_config:
            continue
        conn.execute(
            """
            INSERT INTO model_provider_configs
                (provider, api_url, api_key, model_name, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(provider) DO UPDATE SET
                api_url = excluded.api_url,
                api_key = excluded.api_key,
                model_name = excluded.model_name,
                updated_at = excluded.updated_at
            """,
            (
                provider_config.get("provider") or provider,
                provider_config.get("apiUrl", ""),
                provider_config.get("apiKey", ""),
                provider_config.get("modelName", ""),
                timestamp,
            ),
        )


def load_config(conn):
    rows = conn.execute(
        """
        SELECT provider, api_url, api_key, model_name
        FROM model_provider_configs
        ORDER BY provider
        """
    ).fetchall()
    providers = {
        row["provider"]: {
            "provider": row["provider"],
            "apiUrl": row["api_url"],
            "apiKey": row["api_key"],
            "modelName": row["model_name"],
        }
        for row in rows
    }
    active_chat_provider = get_meta(conn, "active_chat_provider")
    active_agent_provider = get_meta(conn, "active_agent_provider")
    legacy_active_provider = get_meta(conn, "active_provider")
    if not active_chat_provider and legacy_active_provider and legacy_active_provider != "Pi CLI":
        active_chat_provider = legacy_active_provider
    if not active_agent_provider and legacy_active_provider == "Pi CLI":
        active_agent_provider = legacy_active_provider
    if active_chat_provider not in providers:
        active_chat_provider = next((name for name in providers if name != "Pi CLI"), None)
    if active_agent_provider not in providers:
        active_agent_provider = "Pi CLI" if "Pi CLI" in providers else None
    return {
        "activeChatProvider": active_chat_provider,
        "activeAgentProvider": active_agent_provider,
        "providers": providers,
    } if providers else None


def clear_config(conn):
    conn.execute("DELETE FROM model_provider_configs")
    delete_meta(conn, "active_provider", "active_chat_provider", "active_agent_provider")


def default_project():
    timestamp = now_ms()
    return {
        "id": "default",
        "name": "本地工作区",
        "path": str(ROOT),
        "description": "默认项目",
        "created": timestamp,
        "updated": timestamp,
    }


def save_projects(conn, projects):
    projects = projects or {}
    timestamp = now_ms()
    conn.execute("DELETE FROM projects")
    for project_id, project in projects.items():
        pid = project.get("id") or project_id or f"p_{uuid.uuid4().hex[:10]}"
        conn.execute(
            """
            INSERT INTO projects (id, name, path, description, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                pid,
                project.get("name") or "未命名项目",
                project.get("path") or str(ROOT),
                project.get("description") or "",
                int(project.get("created") or timestamp),
                int(project.get("updated") or timestamp),
            ),
        )


def load_projects(conn):
    rows = conn.execute(
        """
        SELECT id, name, path, description, created_at, updated_at
        FROM projects
        ORDER BY updated_at DESC, created_at DESC
        """
    ).fetchall()
    projects = {
        row["id"]: {
            "id": row["id"],
            "name": row["name"],
            "path": row["path"],
            "description": row["description"],
            "created": row["created_at"],
            "updated": row["updated_at"],
        }
        for row in rows
    }
    if projects:
        return merge_pi_projects(projects)

    project = default_project()
    save_projects(conn, {project["id"]: project})
    set_meta(conn, "active_project_id", project["id"])
    return merge_pi_projects({project["id"]: project})


def active_project(conn):
    projects = load_projects(conn)
    active_id = get_meta(conn, "active_project_id")
    if active_id not in projects:
        active_id = next(iter(projects), None)
        if active_id:
            set_meta(conn, "active_project_id", active_id)
    return projects.get(active_id)


def save_sessions(conn, sessions):
    sessions = sessions or {}
    timestamp = now_ms()

    conn.execute("DELETE FROM chat_messages")
    conn.execute("DELETE FROM chat_sessions")

    for session_id, session in sessions.items():
        created_at = int(session.get("created") or timestamp)
        messages = session.get("messages") or []
        conn.execute(
            """
            INSERT INTO chat_sessions
                (id, title, kind, project_id, mode, status, pi_session_path, pi_session_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session.get("id") or session_id,
                session.get("title") or "New chat",
                session.get("kind") or ("agent" if session.get("projectId") else "chat"),
                session.get("projectId"),
                session.get("mode") or "chat",
                session.get("status") or "idle",
                session.get("piSessionPath"),
                session.get("piSessionId"),
                created_at,
                timestamp,
            ),
        )
        for position, message in enumerate(messages):
            role = message.get("role") or "assistant"
            if role not in {"user", "assistant", "system"}:
                role = "assistant"
            conn.execute(
                """
                INSERT INTO chat_messages
                    (session_id, position, role, content, created_at, thinking_ms)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    session.get("id") or session_id,
                    position,
                    role,
                    message.get("content") or "",
                    int(message.get("created") or created_at + position),
                    message.get("thinkingMs") if message.get("thinkingMs") is not None else None,
                ),
            )


def load_sessions(conn):
    sessions = {}
    session_rows = conn.execute(
        """
        SELECT id, title, kind, project_id, mode, status, pi_session_path, pi_session_id, created_at
        FROM chat_sessions
        ORDER BY created_at DESC
        """
    ).fetchall()
    for row in session_rows:
        messages = conn.execute(
            """
            SELECT role, content, created_at, thinking_ms
            FROM chat_messages
            WHERE session_id = ?
            ORDER BY position
            """,
            (row["id"],),
        ).fetchall()
        sessions[row["id"]] = {
            "id": row["id"],
            "title": row["title"],
            "kind": "agent" if row["project_id"] else (row["kind"] or "chat"),
            "projectId": row["project_id"],
            "mode": row["mode"] or "chat",
            "status": row["status"] or "idle",
            "piSessionPath": row["pi_session_path"],
            "piSessionId": row["pi_session_id"],
            "created": row["created_at"],
            "messages": [
                {
                    "role": message["role"],
                    "content": message["content"],
                    "created": message["created_at"],
                    "thinkingMs": message["thinking_ms"],
                }
                for message in messages
            ],
        }
    return sessions


def clear_sessions(conn):
    conn.execute("DELETE FROM chat_messages")
    conn.execute("DELETE FROM chat_sessions")
    delete_meta(conn, "active_session_id")


def delete_pi_session_file(session_path):
    resolved = resolve_pi_session_path(session_path)
    if not resolved:
        raise FileNotFoundError("Pi Agent 会话不存在或路径无效。")
    Path(resolved).unlink()


def latest_user_prompt(messages):
    for message in reversed(messages or []):
        if message.get("role") == "user":
            return message.get("content") or ""
    return ""


def split_command(command):
    command = (command or "").strip()
    if not command:
        return []
    return shlex.split(command, posix=False)


def resolve_command_args(args):
    if not args:
        return args
    resolved = shutil.which(args[0])
    if resolved:
        return [resolved, *args[1:]]
    return args


def normalize_pi_command(command):
    command = (command or "").strip()
    if not command:
        return "pi -p {prompt}"

    lowered = command.lower()
    if "{prompt}" in command or " --print" in lowered or " -p" in lowered:
        return command
    return f"{command} -p {{prompt}}"


def inspect_pi_cli(command=""):
    normalized = normalize_pi_command(command)
    args = resolve_command_args(split_command(normalized))
    detected_path = shutil.which("pi") or shutil.which("pi.cmd")
    return {
        "detectedPath": detected_path or "",
        "configuredPath": (command or "").strip(),
        "command": normalized,
        "executable": args[0] if args else "",
        "args": args,
    }


ANSI_PATTERN = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


def pi_command_base_args(command=""):
    args = split_command((command or "").strip() or "pi")
    if not args:
        args = ["pi"]

    cleaned = []
    skip_next = False
    value_flags = {
        "--model",
        "--provider",
        "--api-key",
        "--system-prompt",
        "--append-system-prompt",
        "--mode",
        "--session",
        "--fork",
        "--session-dir",
        "--models",
        "--tools",
        "-t",
        "--thinking",
    }
    drop_flags = {
        "--print",
        "-p",
        "--continue",
        "-c",
        "--resume",
        "-r",
        "--no-session",
    }
    for index, arg in enumerate(args):
        if skip_next:
            skip_next = False
            continue
        if index > 0 and arg in value_flags:
            skip_next = True
            continue
        if index > 0 and any(arg.startswith(f"{flag}=") for flag in value_flags):
            continue
        if index > 0 and arg in drop_flags:
            if arg in {"--print", "-p"} and index + 1 < len(args) and args[index + 1] == "{prompt}":
                skip_next = True
            continue
        if arg == "{prompt}":
            continue
        cleaned.append(arg)
    return resolve_command_args(cleaned or ["pi"])


def parse_pi_list_models_output(output):
    models = []
    seen = set()
    for raw_line in (output or "").splitlines():
        line = ANSI_PATTERN.sub("", raw_line).strip()
        if not line:
            continue
        lowered = line.lower()
        if (
            lowered.startswith("warning:")
            or lowered.startswith("no models")
            or lowered.startswith("use /login")
            or lowered.endswith("providers.md")
            or lowered.endswith("models.md")
        ):
            continue

        parts = line.split()
        if len(parts) >= 2 and parts[0].lower() == "provider" and parts[1].lower() == "model":
            continue
        if len(parts) >= 2:
            provider, model = parts[0], parts[1]
            if provider and model and provider.lower() not in {"provider", "warning:"}:
                value = f"{provider}/{model}"
                if value not in seen:
                    seen.add(value)
                    models.append({"value": value, "provider": provider, "id": model, "source": "pi"})
    return models


def load_custom_pi_models():
    models_path = Path(os.environ.get("PI_CODING_AGENT_DIR", Path.home() / ".pi" / "agent")) / "models.json"
    try:
        config = json.loads(models_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []

    models = []
    seen = set()
    providers = config.get("providers") if isinstance(config, dict) else None
    if not isinstance(providers, dict):
        return []
    for provider, provider_config in providers.items():
        provider_models = provider_config.get("models") if isinstance(provider_config, dict) else None
        if not isinstance(provider_models, list):
            continue
        for model_config in provider_models:
            if not isinstance(model_config, dict):
                continue
            model_id = str(model_config.get("id") or "").strip()
            if not model_id:
                continue
            value = f"{provider}/{model_id}"
            if value in seen:
                continue
            seen.add(value)
            models.append(
                {
                    "value": value,
                    "provider": provider,
                    "id": model_id,
                    "name": model_config.get("name") or model_id,
                    "source": "models.json",
                }
            )
    return models


def load_enabled_pi_models():
    settings_path = Path(os.environ.get("PI_CODING_AGENT_DIR", Path.home() / ".pi" / "agent")) / "settings.json"
    try:
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []

    enabled_models = settings.get("enabledModels") if isinstance(settings, dict) else None
    if not isinstance(enabled_models, list):
        return []

    models = []
    seen = set()
    for item in enabled_models:
        value = str(item or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        models.append({"value": value, "id": value, "source": "settings.json"})
    return models


def list_pi_models(command=""):
    args = [*pi_command_base_args(command), "--list-models"]
    raw_output = ""
    error = ""
    try:
        proc = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=12,
        )
        raw_output = proc.stdout or ""
        if proc.returncode != 0:
            error = f"Pi CLI exited with code {proc.returncode}."
    except (OSError, subprocess.TimeoutExpired) as exc:
        error = str(exc)

    merged = []
    seen = set()
    for model in [*parse_pi_list_models_output(raw_output), *load_custom_pi_models(), *load_enabled_pi_models()]:
        value = model.get("value")
        if not value or value in seen:
            continue
        seen.add(value)
        merged.append(model)

    return {
        "models": merged,
        "error": error,
        "raw": raw_output,
        "args": args,
    }


def pi_session_root():
    configured = os.environ.get("PI_CODING_AGENT_SESSION_DIR")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".pi" / "agent" / "sessions"


def pi_session_dir_for_cwd(cwd):
    safe_name = str(Path(cwd).resolve()).replace(":", "-").replace("\\", "-").replace("/", "-")
    return pi_session_root() / f"--{safe_name}--"


def pi_project_id_for_dir(session_dir):
    return f"pi_{Path(session_dir).name}"


def infer_cwd_from_pi_session_dir_name(name):
    if name.startswith("--") and name.endswith("--") and len(name) > 4:
      safe_name = name[2:-2]
    else:
      safe_name = name

    match = re.match(r"^([A-Za-z])--(.+)$", safe_name)
    if match and os.name == "nt":
        return f"{match.group(1)}:\\" + match.group(2).replace("-", "\\")
    return safe_name.replace("-", os.sep)


def read_pi_session_header(path):
    try:
        with Path(path).open("r", encoding="utf-8", errors="replace") as handle:
            first_line = handle.readline().strip()
        if first_line:
            record = json.loads(first_line)
            if record.get("type") == "session":
                return record
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def pi_project_cwd_from_dir(session_dir):
    try:
        files = sorted(Path(session_dir).glob("*.jsonl"), key=lambda item: item.stat().st_mtime, reverse=True)
    except OSError:
        files = []
    for path in files:
        cwd = read_pi_session_header(path).get("cwd")
        if cwd:
            return cwd
    return infer_cwd_from_pi_session_dir_name(Path(session_dir).name)


def list_pi_session_projects():
    root = pi_session_root()
    if not root.is_dir():
        return {}

    projects = {}
    try:
        dirs = [path for path in root.iterdir() if path.is_dir()]
    except OSError:
        return projects

    for session_dir in dirs:
        try:
            jsonl_files = list(session_dir.glob("*.jsonl"))
            stats = [path.stat() for path in jsonl_files]
            dir_stat = session_dir.stat()
        except OSError:
            continue

        cwd = pi_project_cwd_from_dir(session_dir)
        name = Path(cwd).name or cwd or session_dir.name
        updated_source = max((stat.st_mtime for stat in stats), default=dir_stat.st_mtime)
        created_source = min((stat.st_mtime for stat in stats), default=dir_stat.st_ctime)
        updated = int(updated_source * 1000)
        created = int(created_source * 1000)
        project_id = pi_project_id_for_dir(session_dir)
        projects[project_id] = {
            "id": project_id,
            "name": name,
            "path": cwd,
            "description": str(session_dir),
            "created": created,
            "updated": updated,
            "source": "pi",
            "sessionDir": str(session_dir),
            "sessionCount": len(jsonl_files),
        }
    return projects


def merge_pi_projects(projects):
    merged = dict(projects or {})
    existing_by_path = {}
    for project_id, project in merged.items():
        try:
            existing_by_path[str(Path(project.get("path") or "").expanduser().resolve()).lower()] = project_id
        except OSError:
            continue

    for pi_id, pi_project in list_pi_session_projects().items():
        try:
            path_key = str(Path(pi_project.get("path") or "").expanduser().resolve()).lower()
        except OSError:
            path_key = ""
        existing_id = existing_by_path.get(path_key)
        if existing_id:
            merged[existing_id] = {**merged[existing_id], **pi_project, "id": existing_id}
        else:
            merged[pi_id] = pi_project
    return merged


def resolve_pi_project_dir(project_id=None, session_dir=None):
    root = pi_session_root().resolve()
    raw_dir = (session_dir or "").strip().strip("\"'`")
    candidate = None
    if raw_dir:
        candidate = Path(raw_dir).expanduser()
    elif project_id:
        projects = list_pi_session_projects()
        project = projects.get(project_id)
        if project:
            candidate = Path(project["sessionDir"])
    if not candidate:
        return None
    try:
        resolved = candidate.resolve()
        resolved.relative_to(root)
    except (OSError, ValueError):
        return None
    if not resolved.is_dir():
        return None
    return resolved


def delete_pi_project_dir(project_id=None, session_dir=None):
    resolved = resolve_pi_project_dir(project_id, session_dir)
    if not resolved:
        raise FileNotFoundError("Pi Agent 项目文件夹不存在或路径无效。")
    shutil.rmtree(resolved)


def pi_session_info(session_path):
    path = Path(session_path)
    session_id = ""
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            first_line = handle.readline().strip()
        if first_line:
            record = json.loads(first_line)
            if record.get("type") == "session":
                session_id = record.get("id") or ""
    except (OSError, json.JSONDecodeError):
        pass
    if not session_id and "_" in path.stem:
        session_id = path.stem.rsplit("_", 1)[-1]
    return {"id": session_id, "path": str(path)}


def parse_iso_ms(value, default_ms=None):
    if not value:
        return default_ms if default_ms is not None else now_ms()
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp() * 1000)
    except (TypeError, ValueError):
        return default_ms if default_ms is not None else now_ms()


def pi_content_to_text(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for item in content:
        if not isinstance(item, dict):
            continue
        item_type = item.get("type")
        if item_type == "text" and item.get("text"):
            parts.append(str(item["text"]))
    return "\n".join(part for part in parts if part).strip()


def pi_content_tool_calls(content):
    if not isinstance(content, list):
        return []
    calls = []
    for item in content:
        if not isinstance(item, dict) or item.get("type") != "toolCall":
            continue
        args = item.get("arguments") if isinstance(item.get("arguments"), dict) else {}
        calls.append(
            {
                "id": item.get("id") or "",
                "name": item.get("name") or "tool",
                "command": args.get("command") or "",
            }
        )
    return calls


def parse_pi_session_file(path, project_id):
    fallback_created = int(path.stat().st_mtime * 1000)
    session_meta = {}
    messages = []
    tool_events = []

    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue

                if record.get("type") == "session":
                    session_meta = record
                    continue

                if record.get("type") != "message":
                    continue
                message = record.get("message") or {}
                role = message.get("role") or "assistant"
                created = parse_iso_ms(record.get("timestamp"), fallback_created)

                if role == "toolResult":
                    tool_events.append(
                        {
                            "type": "result",
                            "toolCallId": message.get("toolCallId") or "",
                            "name": message.get("toolName") or "tool",
                            "isError": bool(message.get("isError")),
                            "created": created,
                        }
                    )
                    continue

                tool_calls = pi_content_tool_calls(message.get("content"))
                if tool_calls:
                    for call in tool_calls:
                        tool_events.append({**call, "type": "call", "created": created})
                    continue

                if role not in {"user", "assistant", "system"}:
                    role = "assistant"
                content = pi_content_to_text(message.get("content"))
                if not content:
                    continue
                messages.append({"role": role, "content": content, "created": created})
    except OSError:
        return None

    info = pi_session_info(path)
    session_id = info["id"] or path.stem
    created = parse_iso_ms(session_meta.get("timestamp"), fallback_created)
    title = next((m["content"].splitlines()[0] for m in messages if m["role"] == "user"), "Pi Agent 会话")
    if len(title) > 30:
        title = title[:30] + "..."

    return {
        "id": f"pi_{session_id}",
        "title": title,
        "kind": "agent",
        "projectId": project_id,
        "mode": "task",
        "status": "idle",
        "created": created,
        "messages": messages,
        "toolEvents": tool_events,
        "piSessionPath": info["path"],
        "piSessionId": info["id"],
        "source": "pi",
    }


def list_project_pi_sessions(project_id, project):
    session_dir = Path(project.get("sessionDir")) if (project or {}).get("sessionDir") else pi_session_dir_for_cwd(resolve_project_cwd(project))
    if not session_dir.is_dir():
        return []
    sessions = []
    try:
        paths = sorted(session_dir.glob("*.jsonl"), key=lambda item: item.stat().st_mtime, reverse=True)
    except OSError:
        return []
    for path in paths:
        parsed = parse_pi_session_file(path, project_id)
        if parsed:
            sessions.append(parsed)
    return sessions


def resolve_pi_session_path(session_path):
    raw_path = (session_path or "").strip().strip("\"'`")
    if not raw_path:
        return None
    try:
        root = pi_session_root().resolve()
        candidate = Path(raw_path).expanduser().resolve()
        candidate.relative_to(root)
    except (OSError, ValueError):
        return None
    if candidate.suffix.lower() != ".jsonl" or not candidate.is_file():
        return None
    return str(candidate)


def latest_pi_session_file(cwd, started_at):
    session_dir = pi_session_dir_for_cwd(cwd)
    if not session_dir.is_dir():
        return None
    candidates = []
    try:
        for path in session_dir.glob("*.jsonl"):
            try:
                stat = path.stat()
            except OSError:
                continue
            if stat.st_mtime >= started_at - 2:
                candidates.append((stat.st_mtime, path))
    except OSError:
        return None
    if not candidates:
        return None
    return max(candidates, key=lambda item: item[0])[1]


def resolve_project_cwd(project):
    project_path = (project or {}).get("path") or str(ROOT)
    try:
        path = Path(project_path).expanduser()
        if path.exists() and path.is_dir():
            return str(path)
    except OSError:
        pass
    return str(ROOT)


def resolve_project_image_path(project, image_path):
    raw_path = (image_path or "").strip().strip("\"'`")
    if not raw_path:
        raise ValueError("图片路径为空。")

    root = Path(resolve_project_cwd(project)).resolve()
    candidate_input = Path(raw_path.replace("\\", "/"))

    if candidate_input.suffix.lower() not in IMAGE_EXTENSIONS:
        raise ValueError("仅支持图片文件。")

    candidate = candidate_input.resolve() if (candidate_input.is_absolute() or candidate_input.drive) else (root / candidate_input).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("图片路径不能超出项目文件夹。") from exc

    if not candidate.exists() or not candidate.is_file():
        raise FileNotFoundError("图片不存在。")

    return candidate


def has_explicit_pi_session_args(args):
    session_flags = {"--session", "--continue", "-c", "--resume", "-r", "--fork", "--no-session"}
    for arg in args[1:]:
        if arg in session_flags or arg.startswith("--session=") or arg.startswith("--fork="):
            return True
    return False


def add_pi_session_args(args, session_path):
    if not session_path or not args or has_explicit_pi_session_args(args):
        return args
    return [args[0], "--session", session_path, *args[1:]]


def has_explicit_pi_model_args(args):
    for arg in args[1:]:
        if arg == "--model" or arg.startswith("--model="):
            return True
    return False


def add_pi_model_args(args, model_name):
    model = (model_name or "").strip()
    if not model or model == "default" or not args or has_explicit_pi_model_args(args):
        return args
    return [args[0], "--model", model, *args[1:]]


def stream_local_cli(command, prompt, cwd, session_path=None, model_name=None):
    if "{prompt}" in command:
        args = add_pi_session_args(split_command(command), session_path)
        args = add_pi_model_args(args, model_name)
        args = [arg.replace("{prompt}", prompt) for arg in args]
        stdin_payload = None
    else:
        args = add_pi_session_args(split_command(command), session_path)
        args = add_pi_model_args(args, model_name)
        stdin_payload = prompt

    args = resolve_command_args(args)

    if not args:
        yield {"error": "Pi CLI 命令为空，请先在配置里填写命令。"}
        return

    try:
        proc = subprocess.Popen(
            args,
            cwd=cwd,
            stdin=subprocess.PIPE if stdin_payload is not None else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except FileNotFoundError:
        yield {"error": f"找不到命令：{args[0]}。请确认 Pi CLI 已安装并在 PATH 中，或填写完整路径。"}
        return
    except OSError as exc:
        yield {"error": f"启动 Pi CLI 失败：{exc}"}
        return

    if stdin_payload is not None and proc.stdin:
        try:
            proc.stdin.write(stdin_payload)
            proc.stdin.close()
        except OSError:
            pass

    assert proc.stdout is not None
    for line in proc.stdout:
        yield {"delta": line}

    code = proc.wait()
    if code != 0:
        yield {"error": f"Pi CLI 已退出，退出码 {code}。"}


def stream_pi_cli(command, prompt, cwd, session_path=None, model_name=None):
    started_at = time.time()
    for event in stream_local_cli(command, prompt, cwd, session_path, model_name):
        yield event

    final_session = Path(session_path) if session_path else latest_pi_session_file(cwd, started_at)
    if final_session and final_session.is_file():
        yield {"session": pi_session_info(final_session)}


class LLMStudioHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "frontend"), **kwargs)

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def stream_ndjson(self, events, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        for event in events:
            body = (json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8")
            self.wfile.write(body)
            self.wfile.flush()

    def stream_cli_chat(self, payload):
        with db_connection() as conn:
            config = load_config(conn) or {}
            provider = config.get("activeAgentProvider")
            provider_config = (config.get("providers") or {}).get(provider) or {}
            project = load_projects(conn).get(payload.get("projectId")) or active_project(conn)

        if not provider:
            provider = "Pi CLI"
            provider_config = {"apiUrl": "pi", "modelName": "default"}

        if provider != "Pi CLI":
            self.stream_ndjson([{"error": "当前 Provider 不是 Pi CLI，请先在配置里选择 Pi CLI。"}], status=400)
            return

        command = normalize_pi_command(provider_config.get("apiUrl"))
        model_name = (payload.get("modelName") or provider_config.get("modelName") or "").strip()
        prompt = payload.get("prompt")
        if prompt is None:
            prompt = latest_user_prompt(payload.get("messages") or [])
        cwd = resolve_project_cwd(project)
        session_path = resolve_pi_session_path(payload.get("piSessionPath"))
        self.stream_ndjson(stream_pi_cli(command, prompt, cwd, session_path, model_name))

    def handle_pick_folder(self):
        """打开 Windows 原生文件夹选择对话框（IFileDialog），返回选中的路径。"""
        try:
            result = self._pick_folder_win32()
            if result:
                self.send_json({"ok": True, "path": result})
            else:
                self.send_json({"ok": False, "path": ""})
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, status=500)

    @staticmethod
    def _pick_folder_win32():
        """使用 ctypes 调用 Windows IFileDialog COM 接口打开现代文件夹选择器。"""
        import ctypes
        import ctypes.wintypes as wt

        ole32 = ctypes.windll.ole32
        ole32.CoInitializeEx(None, 0)  # COINIT_APARTMENTTHREADED

        try:
            CLSID_FileOpenDialog = (
                0xDC1C5A9C, 0xE88A, 0x4DDE,
                (0xA5, 0xA1, 0x60, 0xF8, 0x2A, 0x20, 0xAE, 0xF7)
            )
            IID_IFileDialog = (
                0x42F85136, 0xDB7E, 0x439C,
                (0x85, 0xF1, 0xE4, 0x07, 0x5D, 0x13, 0x5F, 0xC8)
            )

            # FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST
            FOS_PICKFOLDERS = 0x00000020
            FOS_FORCEFILESYSTEM = 0x00000040
            FOS_PATHMUSTEXIST = 0x00000800

            class GUID(ctypes.Structure):
                _fields_ = [
                    ("Data1", ctypes.c_ulong),
                    ("Data2", ctypes.c_ushort),
                    ("Data3", ctypes.c_ushort),
                    ("Data4", ctypes.c_ubyte * 8),
                ]

            def make_guid(data):
                g = GUID()
                g.Data1, g.Data2, g.Data3 = data[0], data[1], data[2]
                for i, v in enumerate(data[3]):
                    g.Data4[i] = v
                return g

            pfd = ctypes.c_void_p()
            guid_fod = make_guid(CLSID_FileOpenDialog)
            guid_ifd = make_guid(IID_IFileDialog)
            hr = ole32.CoCreateInstance(
                ctypes.byref(guid_fod), None, 1,  # CLSCTX_INPROC_SERVER
                ctypes.byref(guid_ifd), ctypes.byref(pfd)
            )
            if hr < 0:
                raise ctypes.COMError(hr, None, None)

            # IFileDialog vtable layout (inherits IModalWindow -> IUnknown):
            # IUnknown: 0=QueryInterface, 1=AddRef, 2=Release
            # IModalWindow: 3=Show
            # IFileDialog: 4=SetFileTypes, ..., 9=SetOptions, ..., 16=SetTitle, ..., 19=GetResult
            vtable = ctypes.cast(
                ctypes.cast(pfd, ctypes.POINTER(ctypes.c_void_p)).contents.value,
                ctypes.POINTER(ctypes.c_void_p)
            )

            # SetOptions (index 9)
            set_options = ctypes.WINFUNCTYPE(
                ctypes.c_long, ctypes.c_void_p, ctypes.c_ulong
            )(vtable[9])
            opts = FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST
            hr = set_options(pfd, opts)
            if hr < 0:
                raise ctypes.COMError(hr, None, None)

            # SetTitle (index 16)
            set_title = ctypes.WINFUNCTYPE(
                ctypes.c_long, ctypes.c_void_p, ctypes.c_wchar_p
            )(vtable[16])
            set_title(pfd, "选择项目文件夹")

            # Show(NULL) (index 3)
            show = ctypes.WINFUNCTYPE(
                ctypes.c_long, ctypes.c_void_p, wt.HWND
            )(vtable[3])
            hr = show(pfd, None)
            if hr != 0:  # S_OK == 0; user cancelled
                return None

            # GetResult (index 19) -> IShellItem
            get_result = ctypes.WINFUNCTYPE(
                ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)
            )(vtable[19])
            psi = ctypes.c_void_p()
            hr = get_result(pfd, ctypes.byref(psi))
            if hr < 0:
                raise ctypes.COMError(hr, None, None)

            # IShellItem vtable: GetDisplayName=5
            si_vtable = ctypes.cast(
                ctypes.cast(psi, ctypes.POINTER(ctypes.c_void_p)).contents.value,
                ctypes.POINTER(ctypes.c_void_p)
            )
            SIGDN_FILESYSPATH = 0x80058000
            get_name = ctypes.WINFUNCTYPE(
                ctypes.c_long, ctypes.c_void_p, ctypes.c_ulong,
                ctypes.POINTER(ctypes.c_wchar_p)
            )(si_vtable[5])
            name_ptr = ctypes.c_wchar_p()
            hr = get_name(psi, SIGDN_FILESYSPATH, ctypes.byref(name_ptr))
            if hr < 0:
                raise ctypes.COMError(hr, None, None)

            folder = name_ptr.value
            ole32.CoTaskMemFree(name_ptr)
            return folder

        finally:
            ole32.CoUninitialize()

    def send_project_image(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        project_id = (params.get("projectId") or [""])[0]
        image_path = (params.get("path") or [""])[0]

        try:
            with db_connection() as conn:
                project = load_projects(conn).get(project_id) or active_project(conn)
            resolved = resolve_project_image_path(project, image_path)
            body = resolved.read_bytes()
        except FileNotFoundError as exc:
            self.send_json({"ok": False, "error": str(exc)}, status=404)
            return
        except (OSError, ValueError) as exc:
            self.send_json({"ok": False, "error": str(exc)}, status=400)
            return

        content_type = mimetypes.guess_type(str(resolved))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed_path = urlparse(self.path).path
        if parsed_path == "/api/project-image":
            self.send_project_image()
            return

        if parsed_path == "/api/pi-sessions":
            params = parse_qs(urlparse(self.path).query)
            project_id = (params.get("projectId") or [""])[0]
            with db_connection() as conn:
                project = load_projects(conn).get(project_id) or active_project(conn)
                resolved_project_id = (project or {}).get("id") or project_id or "default"
            self.send_json({"sessions": list_project_pi_sessions(resolved_project_id, project)})
            return

        if parsed_path == "/api/pi-projects":
            self.send_json({"projects": list_pi_session_projects()})
            return

        if self.path == "/api/state":
            with db_connection() as conn:
                config = load_config(conn)
                provider = (config or {}).get("activeAgentProvider")
                provider_config = ((config or {}).get("providers") or {}).get(provider) or {}
                projects = load_projects(conn)
                active_project_id = get_meta(conn, "active_project_id")
                if active_project_id not in projects:
                    active_project_id = next(iter(projects), None)
                self.send_json(
                    {
                        "config": config,
                        "piCli": inspect_pi_cli(provider_config.get("apiUrl") if provider == "Pi CLI" else ""),
                        "projects": projects,
                        "activeProjectId": active_project_id,
                        "sessions": load_sessions(conn),
                        "activeId": get_meta(conn, "active_session_id"),
                    }
                )
            return

        if self.path == "/api/pi-cli-info":
            with db_connection() as conn:
                config = load_config(conn)
                provider = (config or {}).get("activeAgentProvider")
                provider_config = ((config or {}).get("providers") or {}).get(provider) or {}
                self.send_json(inspect_pi_cli(provider_config.get("apiUrl") if provider == "Pi CLI" else ""))
            return

        if self.path == "/api/pi-models":
            with db_connection() as conn:
                config = load_config(conn)
                provider = (config or {}).get("activeAgentProvider")
                provider_config = ((config or {}).get("providers") or {}).get(provider) or {}
                self.send_json(list_pi_models(provider_config.get("apiUrl") if provider == "Pi CLI" else ""))
            return

        if self.path == "/api/pick-folder":
            self.handle_pick_folder()
            return

        super().do_GET()

    def do_POST(self):
        try:
            payload = self.read_json()
            if self.path == "/api/cli/chat":
                self.stream_cli_chat(payload)
                return

            with db_connection() as conn:
                if self.path == "/api/config":
                    save_config(conn, payload.get("config"))
                    self.send_json({"ok": True})
                    return

                if self.path == "/api/projects":
                    save_projects(conn, payload.get("projects", {}))
                    self.send_json({"ok": True})
                    return

                if self.path == "/api/active-project":
                    set_meta(conn, "active_project_id", payload.get("activeProjectId"))
                    self.send_json({"ok": True})
                    return

                if self.path == "/api/sessions":
                    save_sessions(conn, payload.get("sessions", {}))
                    self.send_json({"ok": True})
                    return

                if self.path == "/api/active-session":
                    set_meta(conn, "active_session_id", payload.get("activeId"))
                    self.send_json({"ok": True})
                    return

        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, status=500)
            return

        self.send_json({"ok": False, "error": "Unknown endpoint"}, status=404)

    def do_DELETE(self):
        parsed_path = urlparse(self.path).path
        if parsed_path == "/api/pi-session":
            try:
                payload = self.read_json()
                delete_pi_session_file(payload.get("piSessionPath"))
                self.send_json({"ok": True})
            except FileNotFoundError as exc:
                self.send_json({"ok": False, "error": str(exc)}, status=404)
            except (OSError, ValueError) as exc:
                self.send_json({"ok": False, "error": str(exc)}, status=400)
            return

        if parsed_path == "/api/pi-project":
            try:
                payload = self.read_json()
                delete_pi_project_dir(payload.get("projectId"), payload.get("sessionDir"))
                self.send_json({"ok": True})
            except FileNotFoundError as exc:
                self.send_json({"ok": False, "error": str(exc)}, status=404)
            except (OSError, ValueError) as exc:
                self.send_json({"ok": False, "error": str(exc)}, status=400)
            return

        with db_connection() as conn:
            if self.path == "/api/config":
                clear_config(conn)
                self.send_json({"ok": True})
                return

            if self.path == "/api/sessions":
                clear_sessions(conn)
                self.send_json({"ok": True})
                return

        self.send_json({"ok": False, "error": "Unknown endpoint"}, status=404)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run LLM Studio with a local SQLite database.")
    parser.add_argument("--no-open", action="store_true", help="Do not open the browser automatically.")
    parser.add_argument("--port", type=int, default=PORT, help="Port to bind. Defaults to 8765.")
    args = parser.parse_args()

    init_db()

    server = ThreadingHTTPServer((HOST, args.port), LLMStudioHandler)
    url = f"http://{HOST}:{args.port}/index.html"
    print(f"LLM Studio is running: {url}")
    print(f"SQLite database: {DB_PATH}")

    if not args.no_open:
        webbrowser.open(url)

    server.serve_forever()
