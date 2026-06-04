"""Local HTTP server and SQLite persistence for LLM Studio."""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from contextlib import contextmanager
from pathlib import Path
import argparse
import json
import shlex
import shutil
import sqlite3
import subprocess
import time
import webbrowser
import uuid


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "llm_studio.sqlite"

HOST = "127.0.0.1"
PORT = 8765

SCHEMA_VERSION = 3

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
            project_id TEXT,
            mode TEXT NOT NULL DEFAULT 'chat',
            status TEXT NOT NULL DEFAULT 'idle',
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
            FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
            UNIQUE (session_id, position)
        );

        CREATE INDEX IF NOT EXISTS idx_chat_messages_session_position
            ON chat_messages(session_id, position);

        """
    )
    ensure_column(conn, "chat_sessions", "project_id", "TEXT")
    ensure_column(conn, "chat_sessions", "mode", "TEXT NOT NULL DEFAULT 'chat'")
    ensure_column(conn, "chat_sessions", "status", "TEXT NOT NULL DEFAULT 'idle'")
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
        return {"activeProvider": None, "providers": {}}

    if isinstance(config, dict) and isinstance(config.get("providers"), dict):
        return {
            "activeProvider": config.get("activeProvider"),
            "providers": config.get("providers") or {},
        }

    if isinstance(config, dict) and any(config.get(k) for k in ("apiUrl", "apiKey", "modelName")):
        provider = infer_provider(config)
        return {
            "activeProvider": provider,
            "providers": {
                provider: {
                    "provider": provider,
                    "apiUrl": config.get("apiUrl", ""),
                    "apiKey": config.get("apiKey", ""),
                    "modelName": config.get("modelName", ""),
                }
            },
        }

    return {"activeProvider": None, "providers": {}}


def save_config(conn, config):
    store = normalize_config_store(config)
    timestamp = now_ms()

    if store["activeProvider"]:
        set_meta(conn, "active_provider", store["activeProvider"])

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
    active_provider = get_meta(conn, "active_provider")
    if active_provider not in providers:
        active_provider = next(iter(providers), None)
    return {"activeProvider": active_provider, "providers": providers} if providers else None


def clear_config(conn):
    conn.execute("DELETE FROM model_provider_configs")
    delete_meta(conn, "active_provider")


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
        return projects

    project = default_project()
    save_projects(conn, {project["id"]: project})
    set_meta(conn, "active_project_id", project["id"])
    return {project["id"]: project}


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
                (id, title, project_id, mode, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session.get("id") or session_id,
                session.get("title") or "New chat",
                session.get("projectId"),
                session.get("mode") or "chat",
                session.get("status") or "idle",
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
                    (session_id, position, role, content, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    session.get("id") or session_id,
                    position,
                    role,
                    message.get("content") or "",
                    created_at + position,
                ),
            )


def load_sessions(conn):
    sessions = {}
    session_rows = conn.execute(
        """
        SELECT id, title, project_id, mode, status, created_at
        FROM chat_sessions
        ORDER BY created_at DESC
        """
    ).fetchall()
    for row in session_rows:
        messages = conn.execute(
            """
            SELECT role, content
            FROM chat_messages
            WHERE session_id = ?
            ORDER BY position
            """,
            (row["id"],),
        ).fetchall()
        sessions[row["id"]] = {
            "id": row["id"],
            "title": row["title"],
            "projectId": row["project_id"],
            "mode": row["mode"] or "chat",
            "status": row["status"] or "idle",
            "created": row["created_at"],
            "messages": [
                {"role": message["role"], "content": message["content"]}
                for message in messages
            ],
        }
    return sessions


def clear_sessions(conn):
    conn.execute("DELETE FROM chat_messages")
    conn.execute("DELETE FROM chat_sessions")
    delete_meta(conn, "active_session_id")


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


def resolve_project_cwd(project):
    project_path = (project or {}).get("path") or str(ROOT)
    try:
        path = Path(project_path).expanduser()
        if path.exists() and path.is_dir():
            return str(path)
    except OSError:
        pass
    return str(ROOT)


def stream_local_cli(command, prompt, cwd):
    if "{prompt}" in command:
        args = [
            arg.replace("{prompt}", prompt)
            for arg in split_command(command)
        ]
        stdin_payload = None
    else:
        args = split_command(command)
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


class LLMStudioHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

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
            provider = config.get("activeProvider")
            provider_config = (config.get("providers") or {}).get(provider) or {}
            project = load_projects(conn).get(payload.get("projectId")) or active_project(conn)

        if not provider:
            provider = "Pi CLI"
            provider_config = {"apiUrl": "pi", "modelName": "default"}

        if provider != "Pi CLI":
            self.stream_ndjson([{"error": "当前 Provider 不是 Pi CLI，请先在配置里选择 Pi CLI。"}], status=400)
            return

        command = normalize_pi_command(provider_config.get("apiUrl"))
        prompt = payload.get("prompt")
        if prompt is None:
            prompt = latest_user_prompt(payload.get("messages") or [])
        cwd = resolve_project_cwd(project)
        self.stream_ndjson(stream_local_cli(command, prompt, cwd))

    def do_GET(self):
        if self.path == "/api/state":
            with db_connection() as conn:
                config = load_config(conn)
                provider = (config or {}).get("activeProvider")
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
                provider = (config or {}).get("activeProvider")
                provider_config = ((config or {}).get("providers") or {}).get(provider) or {}
                self.send_json(inspect_pi_cli(provider_config.get("apiUrl") if provider == "Pi CLI" else ""))
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
