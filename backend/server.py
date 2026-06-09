"""Local HTTP server and SQLite persistence for MUSE PI."""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import argparse
import json
import mimetypes
import os
import sys
import re
import shlex
import shutil
import sqlite3
import subprocess
import time
from urllib.parse import parse_qs, urlparse
import webbrowser


ROOT = Path(sys._MEIPASS) if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent.parent
DATA_DIR = Path.home() / ".musepi"
DB_PATH = DATA_DIR / "musepi.sqlite"

HOST = "127.0.0.1"
PORT = 9000
_active_tabs = set()  # 活跃标签页 ID 集合，全空时退服

SCHEMA_VERSION = 7
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}
PROJECT_FILE_IGNORE_DIRS = {
    ".git",
    ".hg",
    ".svn",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".venv",
    "venv",
    "node_modules",
    "dist",
    "build",
}
PROJECT_FILE_IGNORE_FILES = {".DS_Store", "Thumbs.db"}
DEFAULT_PROJECT_FILE_LIMIT = 400

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
            enabled_models TEXT NOT NULL DEFAULT '[]',
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
            custom_title TEXT,
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
    ensure_column(conn, "chat_sessions", "custom_title", "TEXT")
    ensure_column(conn, "chat_messages", "thinking_ms", "INTEGER")
    ensure_column(conn, "model_provider_configs", "enabled_models", "TEXT NOT NULL DEFAULT '[]'")
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


def normalize_enabled_models(config):
    if not isinstance(config, dict):
        return []
    models = []
    for model in config.get("enabledModels") or []:
        value = str(model or "").strip()
        if value and value not in models:
            models.append(value)
    current = str(config.get("modelName") or "").strip()
    if current and current not in models:
        models.insert(0, current)
    return models


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
                    "enabledModels": normalize_enabled_models(config),
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
                (provider, api_url, api_key, model_name, enabled_models, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider) DO UPDATE SET
                api_url = excluded.api_url,
                api_key = excluded.api_key,
                model_name = excluded.model_name,
                enabled_models = excluded.enabled_models,
                updated_at = excluded.updated_at
            """,
            (
                provider_config.get("provider") or provider,
                provider_config.get("apiUrl", ""),
                provider_config.get("apiKey", ""),
                provider_config.get("modelName", ""),
                json.dumps(normalize_enabled_models(provider_config), ensure_ascii=False),
                timestamp,
            ),
        )


def load_config(conn):
    rows = conn.execute(
        """
        SELECT provider, api_url, api_key, model_name, enabled_models
        FROM model_provider_configs
        ORDER BY provider
        """
    ).fetchall()
    def row_enabled_models(row):
        try:
            models = json.loads(row["enabled_models"] or "[]")
        except json.JSONDecodeError:
            models = []
        return normalize_enabled_models({"modelName": row["model_name"], "enabledModels": models})

    providers = {
        row["provider"]: {
            "provider": row["provider"],
            "apiUrl": row["api_url"],
            "apiKey": row["api_key"],
            "modelName": row["model_name"],
            "enabledModels": row_enabled_models(row),
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


def require_project_folder_path(path):
    raw = os.path.expandvars(str(path or "").strip().strip("\"'"))
    if not raw:
        raise ValueError("请填写本地项目文件夹路径。")
    parsed = urlparse(raw)
    if parsed.scheme and len(parsed.scheme) > 1:
        raise ValueError("项目路径必须是本地文件夹，不能是 URL。")
    folder = Path(raw).expanduser()
    if not folder.is_absolute():
        raise ValueError("项目路径必须是绝对路径，例如 C:\\Users\\you\\project，不能只填 123 或 .\\project。")
    try:
        return folder.resolve(strict=False)
    except (OSError, ValueError) as exc:
        raise ValueError(f"项目路径无效：{raw}") from exc


def project_path_status(path):
    raw = str(path or "").strip()
    if not raw:
        return {
            "available": False,
            "projectPathExists": False,
            "projectPathIsDir": False,
            "unavailableReason": "项目文件夹不存在",
        }
    try:
        folder = Path(raw).expanduser()
        exists = folder.exists()
        is_dir = exists and folder.is_dir()
    except (OSError, ValueError):
        return {
            "available": False,
            "projectPathExists": False,
            "projectPathIsDir": False,
            "unavailableReason": "项目路径无效",
        }

    available = bool(exists and is_dir)
    reason = ""
    if not exists:
        reason = "项目文件夹不存在"
    elif not is_dir:
        reason = "项目路径不是文件夹"
    return {
        "available": available,
        "projectPathExists": bool(exists),
        "projectPathIsDir": bool(is_dir),
        "unavailableReason": reason,
    }


def git_branch_status(path):
    raw = str(path or "").strip()
    if not raw:
        return {"gitBranch": "", "gitBranchDetached": False}

    try:
        folder = Path(raw).expanduser()
        if not folder.is_dir():
            return {"gitBranch": "", "gitBranchDetached": False}
        base_args = ["git", "-C", str(folder)]
        probe = subprocess.run(
            [*base_args, "rev-parse", "--is-inside-work-tree"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=2,
        )
        if probe.returncode != 0 or (probe.stdout or "").strip() != "true":
            return {"gitBranch": "", "gitBranchDetached": False}

        current = subprocess.run(
            [*base_args, "branch", "--show-current"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=2,
        )
        branch = (current.stdout or "").strip()
        if branch:
            return {"gitBranch": branch, "gitBranchDetached": False}

        head = subprocess.run(
            [*base_args, "rev-parse", "--short", "HEAD"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=2,
        )
        sha = (head.stdout or "").strip()
        return {"gitBranch": f"detached@{sha}" if sha else "", "gitBranchDetached": bool(sha)}
    except (OSError, subprocess.SubprocessError, ValueError):
        return {"gitBranch": "", "gitBranchDetached": False}


def load_projects(conn):
    return list_pi_session_projects()


def resolve_active_project_id(conn, projects=None):
    projects = projects if projects is not None else load_projects(conn)
    active_id = get_meta(conn, "active_project_id")
    active_project = projects.get(active_id)
    if not active_project or not active_project.get("available"):
        active_id = next((project_id for project_id, project in projects.items() if project.get("available")), None)
        set_meta(conn, "active_project_id", active_id)
    return active_id


def active_project(conn):
    projects = load_projects(conn)
    active_id = resolve_active_project_id(conn, projects)
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
                (id, title, kind, project_id, mode, status, pi_session_path, pi_session_id, custom_title, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                session.get("customTitle"),
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
        SELECT id, title, kind, project_id, mode, status, pi_session_path, pi_session_id, custom_title, created_at
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
            "customTitle": row["custom_title"],
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


def resolve_at_paths(prompt, cwd):
    """Strip @ from @file reference blocks — only when @ starts a word/tag."""
    if not prompt or not cwd:
        return prompt
    return re.sub(r"(^|\s)@(\S+)", r"\1\2", prompt)


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


def pi_agent_dir():
    return Path(os.environ.get("PI_CODING_AGENT_DIR", Path.home() / ".pi" / "agent")).expanduser()


def load_pi_settings():
    settings_path = pi_agent_dir() / "settings.json"
    try:
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}, settings_path
    return settings if isinstance(settings, dict) else {}, settings_path


def load_enabled_pi_models():
    settings, _settings_path = load_pi_settings()

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


def parse_skill_frontmatter(skill_path):
    try:
        text = Path(skill_path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        text = ""

    frontmatter = {}
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            for line in text[3:end].splitlines():
                if ":" not in line:
                    continue
                key, value = line.split(":", 1)
                frontmatter[key.strip()] = value.strip().strip("\"'")

    path = Path(skill_path)
    fallback_name = path.parent.name if path.name.upper() == "SKILL.MD" else path.stem
    return {
        "name": frontmatter.get("name") or fallback_name,
        "description": frontmatter.get("description") or "",
    }


def make_skill_record(skill_path, source, root=None):
    path = Path(skill_path)
    meta = parse_skill_frontmatter(path)
    name = re.sub(r"\s+", "-", str(meta["name"]).strip())
    if not name:
        return None
    record = {
        "name": name,
        "command": f"/{name}",
        "description": meta["description"],
        "path": str(path),
        "source": source,
        "directory": str(path.parent),
    }
    if root:
        try:
            record["relativePath"] = str(path.relative_to(root))
        except ValueError:
            record["relativePath"] = path.name
    return record


def should_skip_skill_dir(path):
    name = Path(path).name
    return name in PROJECT_FILE_IGNORE_DIRS


def discover_skills_in_path(path, source, include_root_markdown=False):
    root = Path(path).expanduser()
    if root.is_file() and root.suffix.lower() == ".md":
        record = make_skill_record(root, source, root.parent)
        return [record] if record else []
    if not root.is_dir():
        return []

    records = []
    if include_root_markdown:
        try:
            for item in sorted(root.glob("*.md"), key=lambda candidate: candidate.name.lower()):
                record = make_skill_record(item, source, root)
                if record:
                    records.append(record)
        except OSError:
            pass

    for current, dirs, files in os.walk(root, followlinks=True):
        dirs[:] = sorted(
            [directory for directory in dirs if not should_skip_skill_dir(directory)],
            key=str.lower,
        )
        if "SKILL.md" not in files:
            continue
        skill_path = Path(current) / "SKILL.md"
        record = make_skill_record(skill_path, source, root)
        if record:
            records.append(record)
    return records


def git_root_for_path(path):
    current = Path(path).resolve()
    for candidate in (current, *current.parents):
        if (candidate / ".git").exists():
            return candidate
    return None


def project_skill_roots(project):
    try:
        cwd = Path(resolve_project_cwd(project)).resolve()
    except ValueError:
        return []

    git_root = git_root_for_path(cwd)
    roots = []
    for folder in (cwd, *cwd.parents):
        roots.append((folder / ".pi" / "skills", "project .pi/skills", True))
        roots.append((folder / ".agents" / "skills", "project .agents/skills", False))
        if git_root and folder == git_root:
            break
        if not git_root and folder.parent == folder:
            break
    return roots


def configured_skill_roots():
    settings, settings_path = load_pi_settings()
    entries = settings.get("skills")
    if not isinstance(entries, list):
        return []

    roots = []
    for entry in entries:
        raw = os.path.expandvars(str(entry or "").strip().strip("\"'"))
        if not raw:
            continue
        candidate = Path(raw).expanduser()
        if not candidate.is_absolute():
            candidate = (settings_path.parent / candidate).resolve(strict=False)
        roots.append((candidate, "settings.json skills", True))
    return roots


def global_skill_roots():
    home = Path.home()
    return [
        (pi_agent_dir() / "skills", "~/.pi/agent/skills", True),
        (home / ".agents" / "skills", "~/.agents/skills", False),
        (home / ".agent" / "skills", "~/.agent/skills", False),
    ]


def list_pi_skills(project=None):
    roots = [
        *project_skill_roots(project or {}),
        *configured_skill_roots(),
        *global_skill_roots(),
    ]

    skills = []
    seen_names = set()
    seen_paths = set()
    for root, source, include_root_markdown in roots:
        for record in discover_skills_in_path(root, source, include_root_markdown):
            path_key = record["path"].lower()
            name_key = record["name"].lower()
            if path_key in seen_paths or name_key in seen_names:
                continue
            seen_paths.add(path_key)
            seen_names.add(name_key)
            skills.append(record)

    skills.sort(key=lambda item: (item["name"].lower(), item["source"].lower()))
    return skills


def pi_session_root():
    configured = os.environ.get("PI_CODING_AGENT_SESSION_DIR")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".pi" / "agent" / "sessions"


def pi_session_dir_for_cwd(cwd):
    safe_name = str(Path(cwd).resolve()).replace(":", "-").replace("\\", "-").replace("/", "-")
    return pi_session_root() / f"--{safe_name}--"


def create_pi_project(path):
    folder = require_project_folder_path(path)
    session_dir = pi_session_dir_for_cwd(folder)
    project_folder_existed = folder.exists()

    if project_folder_existed and not folder.is_dir():
        raise ValueError(f"项目路径不是文件夹：{folder}")
    if session_dir.exists():
        raise FileExistsError("对话项目已存在")

    try:
        if not project_folder_existed:
            folder.mkdir(parents=True, exist_ok=False)
        pi_session_root().mkdir(parents=True, exist_ok=True)
        session_dir.mkdir(parents=False, exist_ok=False)
    except FileExistsError as exc:
        if session_dir.exists():
            raise FileExistsError("对话项目已存在") from exc
        raise ValueError(f"无法创建项目文件夹：{folder}") from exc
    except OSError as exc:
        raise ValueError(f"无法创建对话项目：{session_dir}") from exc

    status = "dialog_created" if project_folder_existed else "project_and_dialog_created"
    message = "对话项目已创建" if project_folder_existed else "项目文件夹和对话项目已创建"
    project_id = pi_project_id_for_dir(session_dir)
    project = list_pi_session_projects().get(project_id)
    if not project:
        timestamp = now_ms()
        project = {
            "id": project_id,
            "name": folder.name or str(folder),
            "path": str(folder),
            "description": str(session_dir),
            "created": timestamp,
            "updated": timestamp,
            "source": "pi",
            "sessionDir": str(session_dir),
            "sessionCount": 0,
            **project_path_status(str(folder)),
            **git_branch_status(str(folder)),
        }
    return {
        "status": status,
        "message": message,
        "project": project,
    }


def pi_project_id_for_dir(session_dir):
    return f"pi_{Path(session_dir).name}"


def infer_cwd_from_pi_session_dir_name(name):
    if name.startswith("--") and name.endswith("--") and len(name) > 4:
        safe_name = name[2:-2]
    else:
        safe_name = name

    match = re.match(r"^([A-Za-z])--(.+)$", safe_name)
    if match and os.name == "nt":
        return infer_windows_cwd_from_safe_name(match.group(1), match.group(2))
    return safe_name.replace("-", os.sep)


def infer_windows_cwd_from_safe_name(drive, encoded_path):
    root = Path(f"{drive}:\\")
    if not root.exists():
        return f"{drive}:\\" + encoded_path.replace("-", "\\")

    tokens = encoded_path.split("-")
    current = root
    index = 0
    while index < len(tokens):
        best = None
        for end in range(len(tokens), index, -1):
            segment = "-".join(tokens[index:end])
            if not segment:
                continue
            candidate = current / segment
            if candidate.exists():
                best = (candidate, end)
                break
        if not best:
            return str(current / Path(*tokens[index:]))
        current, index = best
    return str(current)


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
        dirs = sorted(
            (path for path in root.iterdir() if path.is_dir()),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
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
        availability = project_path_status(cwd)
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
            **availability,
            **git_branch_status(cwd),
        }
    return projects


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
    if resolved == root or resolved.parent != root:
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
    status = project_path_status((project or {}).get("path"))
    if not status["available"]:
        raise ValueError("项目文件夹不存在，无法继续对话")
    return str(Path((project or {}).get("path")).expanduser())


def file_match_score(relative_path, query):
    if not query:
        return 0
    haystack = relative_path.lower()
    needle = query.lower().replace("\\", "/").lstrip("@")
    name = Path(relative_path).name.lower()
    if name.startswith(needle):
        return 0
    if haystack.startswith(needle):
        return 1
    if needle in name:
        return 2
    if needle in haystack:
        return 3
    return 99


def list_project_files(project, query="", limit=DEFAULT_PROJECT_FILE_LIMIT):
    root = Path(resolve_project_cwd(project)).resolve()
    query = str(query or "").strip().lstrip("@")
    try:
        limit = max(1, min(int(limit or DEFAULT_PROJECT_FILE_LIMIT), 1000))
    except (TypeError, ValueError):
        limit = DEFAULT_PROJECT_FILE_LIMIT

    matches = []
    for current, dirs, files in os.walk(root, followlinks=True):
        dirs[:] = sorted(
            [directory for directory in dirs if directory not in PROJECT_FILE_IGNORE_DIRS],
            key=str.lower,
        )
        current_path = Path(current)
        rel_dir = current_path.relative_to(root).as_posix()
        if rel_dir == ".":
            rel_dir = ""
        for file_name in sorted(files, key=str.lower):
            if file_name in PROJECT_FILE_IGNORE_FILES:
                continue
            path = current_path / file_name
            try:
                stat = path.stat()
                relative_path = path.relative_to(root).as_posix()
            except (OSError, ValueError):
                continue
            score = file_match_score(relative_path, query)
            if score >= 99:
                continue
            matches.append(
                {
                    "name": file_name,
                    "path": relative_path,
                    "directory": rel_dir,
                    "extension": path.suffix.lower().lstrip("."),
                    "size": stat.st_size,
                    "updated": int(stat.st_mtime * 1000),
                    "_score": score,
                }
            )

    matches.sort(key=lambda item: (item["_score"], item["path"].lower()))
    for item in matches:
        item.pop("_score", None)
    return matches[:limit]


def resolve_common_local_image_path(image_path):
    if image_path.is_absolute() or image_path.drive:
        return None
    home = Path.home()
    for base in (home / "Desktop", home / "Downloads", home / "Pictures"):
        candidate = (base / image_path).resolve()
        try:
            candidate.relative_to(base.resolve())
        except ValueError:
            continue
        if candidate.exists() and candidate.is_file():
            return candidate
    return None


def search_project_image(root, filename):
    """Search the project directory recursively for an image file by filename (case-insensitive).

    Returns the Path of the first match, or None if not found.
    """
    target = filename.lower()
    for current, dirs, files in os.walk(root, followlinks=True):
        dirs[:] = sorted(
            [d for d in dirs if d not in PROJECT_FILE_IGNORE_DIRS],
            key=str.lower,
        )
        for file_name in files:
            if file_name.lower() == target:
                return Path(current) / file_name
    return None




def resolve_project_image_path(project, image_path):
    raw_path = (image_path or "").strip().strip("\"'`")
    if raw_path.startswith("<") and raw_path.endswith(">"):
        raw_path = raw_path[1:-1].strip()
    raw_path = re.sub(r"^([A-Za-z]):\s+([\\/])", r"\1:\2", raw_path)
    raw_path = re.sub(r"^([A-Za-z])：", r"\1:", raw_path)  # normalize full-width colon C： -> C:
    if not raw_path:
        raise ValueError("图片路径为空。")

    root = Path(resolve_project_cwd(project)).resolve()
    candidate_input = Path(raw_path.replace("\\", "/"))

    if candidate_input.suffix.lower() not in IMAGE_EXTENSIONS:
        raise ValueError("仅支持图片文件。")

    is_external_absolute = candidate_input.is_absolute() or bool(candidate_input.drive)
    candidate = candidate_input.resolve() if is_external_absolute else (root / candidate_input).resolve()
    if not is_external_absolute:
        try:
            candidate.relative_to(root)
        except ValueError as exc:
            raise ValueError("图片路径不能超出项目文件夹。") from exc

    if not candidate.exists() or not candidate.is_file():
        fallback = resolve_common_local_image_path(candidate_input)
        if fallback:
            candidate = fallback

    if not candidate.exists() or not candidate.is_file():
        searched = search_project_image(root, candidate_input.name)
        if searched:
            candidate = searched

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


class MusePiHandler(SimpleHTTPRequestHandler):
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
        try:
            cwd = resolve_project_cwd(project)
        except ValueError:
            self.stream_ndjson([{"error": "项目文件夹不存在，无法继续对话"}], status=400)
            return
        prompt = resolve_at_paths(prompt, cwd)
        session_path = resolve_pi_session_path(payload.get("piSessionPath"))
        self.stream_ndjson(stream_pi_cli(command, prompt, cwd, session_path, model_name))

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

        if parsed_path == "/api/pi-skills":
            params = parse_qs(urlparse(self.path).query)
            project_id = (params.get("projectId") or [""])[0]
            with db_connection() as conn:
                project = load_projects(conn).get(project_id) or active_project(conn)
            self.send_json({"skills": list_pi_skills(project)})
            return

        if parsed_path == "/api/project-files":
            params = parse_qs(urlparse(self.path).query)
            project_id = (params.get("projectId") or [""])[0]
            query = (params.get("q") or [""])[0]
            limit = (params.get("limit") or [DEFAULT_PROJECT_FILE_LIMIT])[0]
            try:
                with db_connection() as conn:
                    project = load_projects(conn).get(project_id) or active_project(conn)
                self.send_json({"files": list_project_files(project, query, limit)})
            except (OSError, ValueError) as exc:
                self.send_json({"ok": False, "error": str(exc)}, status=400)
            return

        if self.path == "/api/state":
            with db_connection() as conn:
                config = load_config(conn)
                provider = (config or {}).get("activeAgentProvider")
                provider_config = ((config or {}).get("providers") or {}).get(provider) or {}
                projects = load_projects(conn)
                active_project_id = resolve_active_project_id(conn, projects)
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

        super().do_GET()

    def do_POST(self):
        try:
            global _active_tabs
            parsed_path = urlparse(self.path).path
            # 标签页引用计数：开一个注册，关一个注销，全部关闭才退服
            if parsed_path == "/api/hello":
                params = parse_qs(urlparse(self.path).query)
                tab_id = (params.get("tab") or [""])[0]
                if tab_id:
                    _active_tabs.add(tab_id)
                    print(f"标签页上线 ({tab_id})，当前 {len(_active_tabs)} 个")
                self.send_json({"ok": True, "count": len(_active_tabs)})
                return

            if parsed_path == "/api/bye":
                params = parse_qs(urlparse(self.path).query)
                tab_id = (params.get("tab") or [""])[0]
                if tab_id and tab_id in _active_tabs:
                    _active_tabs.discard(tab_id)
                    print(f"标签页下线 ({tab_id})，剩余 {len(_active_tabs)} 个")
                if not _active_tabs:
                    print("所有标签页已关闭，服务器退出。")
                    self.send_json({"ok": True})
                    os._exit(0)
                self.send_json({"ok": True})
                return

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
                    self.send_json({"ok": True, "projects": list_pi_session_projects()})
                    return

                if self.path == "/api/pi-project":
                    result = create_pi_project(payload.get("path"))
                    set_meta(conn, "active_project_id", result["project"]["id"])
                    self.send_json({"ok": True, **result})
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

        except ValueError as exc:
            self.send_json({"ok": False, "error": str(exc)}, status=400)
            return
        except FileExistsError as exc:
            self.send_json({"ok": False, "error": str(exc)}, status=409)
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
    parser = argparse.ArgumentParser(description="Run MUSE PI with a local SQLite database.")
    parser.add_argument("--no-open", action="store_true", help="Do not open the browser automatically.")
    parser.add_argument("--port", type=int, default=PORT, help="Port to bind. Defaults to 9000.")
    args = parser.parse_args()

    init_db()

    # 自动找可用端口
    port = args.port
    while True:
        try:
            server = ThreadingHTTPServer((HOST, port), MusePiHandler)
            break
        except OSError:
            print(f"端口 {port} 被占用，尝试 {port + 1}...")
            port += 1

    url = f"http://{HOST}:{port}/index.html"
    print(f"MUSE PI is running: {url}")
    print(f"SQLite database: {DB_PATH}")

    if not args.no_open:
        webbrowser.open(url)

    server.serve_forever()
