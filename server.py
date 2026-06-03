"""
LLM Studio 的本地服务。

你可以把这个文件理解成网页和数据库之间的“中间人”：

1. 浏览器负责显示页面，也就是 index.html、CSS、JS。
2. 这个 Python 服务负责接收浏览器发来的保存/读取请求。
3. SQLite 数据库负责把配置和会话真正保存到项目文件夹里。

为什么需要它？
普通浏览器页面不能直接读写 SQLite 文件，所以要让 Python 帮忙。
"""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse
import json
import sqlite3
import webbrowser


# 当前项目根目录。
# __file__ 是 server.py 自己的路径。
# parent 表示 server.py 所在的文件夹，也就是你的项目文件夹。
ROOT = Path(__file__).resolve().parent

# 数据库文件夹和数据库文件路径。
# 最终会生成：项目目录/data/llm_studio.sqlite
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "llm_studio.sqlite"

# 127.0.0.1 表示“只在你自己的电脑上访问”。
# 别人不能通过互联网访问这个服务，开发阶段更安全。
HOST = "127.0.0.1"

# 本地服务端口。
# 打开网页时使用：http://127.0.0.1:8765/index.html
PORT = 8765


def init_db():
    """创建数据库文件和表。

    如果 data 文件夹不存在，就创建它。
    如果数据库表已经存在，就什么都不重复创建。

    这里目前只建了一张 app_state 表：
    - key：保存项的名字，比如 config、sessions、activeId
    - value：保存项的内容，用 JSON 字符串保存

    这是一种简单的“键值存储”设计，适合当前这个小项目。
    """

    DATA_DIR.mkdir(exist_ok=True)

    # with sqlite3.connect(...) as conn 的意思是：
    # 打开数据库，执行完里面的代码后自动保存并关闭连接。
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS app_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )


def get_state(key, default=None):
    """从数据库读取一个保存项。

    参数 key 是要读取的名字，比如：
    - "config"：读取 API 配置
    - "sessions"：读取所有会话
    - "activeId"：读取当前打开的是哪个会话

    如果数据库里没有这个 key，就返回 default。
    """

    with sqlite3.connect(DB_PATH) as conn:
        # 问号 ? 是占位符。
        # 这样写比自己拼 SQL 字符串更安全，也不容易出错。
        row = conn.execute("SELECT value FROM app_state WHERE key = ?", (key,)).fetchone()

    if not row:
        return default

    try:
        # value 存进去时是 JSON 字符串。
        # 读取出来后，要转回 Python 的字典/列表/字符串。
        return json.loads(row[0])
    except json.JSONDecodeError:
        # 如果 value 不是合法 JSON，就返回默认值，避免程序直接崩掉。
        return default


def set_state(key, value):
    """把一个保存项写入数据库。

    如果 key 原来不存在，就新增一行。
    如果 key 原来已经存在，就更新原来的 value。
    """

    # ensure_ascii=False 的作用是：
    # 保存中文时直接保存中文，而不是保存成 \u4f60\u597d 这种编码形式。
    payload = json.dumps(value, ensure_ascii=False)

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO app_state (key, value)
            VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (key, payload),
        )


def delete_state(*keys):
    """从数据库删除一个或多个保存项。

    *keys 表示可以传多个 key。
    比如 delete_state("sessions", "activeId") 会同时删除会话和当前会话 ID。
    """

    with sqlite3.connect(DB_PATH) as conn:
        conn.executemany("DELETE FROM app_state WHERE key = ?", [(key,) for key in keys])


class LLMStudioHandler(SimpleHTTPRequestHandler):
    """处理浏览器请求的类。

    浏览器访问网页、读取数据库、保存数据库，都会先到这里。

    它继承 SimpleHTTPRequestHandler，所以它有两个能力：
    1. 像普通静态服务器一样返回 index.html、CSS、JS、图片。
    2. 额外处理我们自己写的 /api/... 数据接口。
    """

    def __init__(self, *args, **kwargs):
        # directory=str(ROOT) 表示：
        # 静态文件从项目根目录提供。
        # 所以浏览器才能访问 index.html、styles/main.css、scripts/app.js。
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, payload, status=200):
        """给浏览器返回 JSON 数据。

        payload 是要返回的数据，比如 {"ok": True}。
        status 是 HTTP 状态码，200 表示成功，404 表示接口不存在，500 表示出错。
        """

        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        """读取浏览器发来的 JSON 数据。

        前端用 fetch(..., { body: JSON.stringify(...) }) 发数据。
        这里负责把那段 JSON 文本转成 Python 能用的字典。
        """

        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        """处理 GET 请求。

        GET 通常表示“读取数据”。

        当前自定义接口：
        - GET /api/state：读取配置、所有会话、当前会话 ID

        如果访问的不是 /api/state，就交给父类处理。
        比如访问 /index.html 时，父类会把 index.html 文件返回给浏览器。
        """

        if self.path == "/api/state":
            self.send_json(
                {
                    "config": get_state("config"),
                    "sessions": get_state("sessions", {}),
                    "activeId": get_state("activeId"),
                }
            )
            return

        super().do_GET()

    def do_POST(self):
        """处理 POST 请求。

        POST 通常表示“保存数据”。

        当前自定义接口：
        - POST /api/config：保存 API 配置
        - POST /api/sessions：保存所有会话
        - POST /api/active-session：保存当前打开的会话 ID
        """

        try:
            payload = self.read_json()

            if self.path == "/api/config":
                set_state("config", payload.get("config"))
                self.send_json({"ok": True})
                return

            if self.path == "/api/sessions":
                set_state("sessions", payload.get("sessions", {}))
                self.send_json({"ok": True})
                return

            if self.path == "/api/active-session":
                set_state("activeId", payload.get("activeId"))
                self.send_json({"ok": True})
                return

        except Exception as exc:
            # 如果保存过程中出错，就告诉浏览器失败原因。
            self.send_json({"ok": False, "error": str(exc)}, status=500)
            return

        # 走到这里，说明浏览器请求了一个我们没有写过的接口。
        self.send_json({"ok": False, "error": "Unknown endpoint"}, status=404)

    def do_DELETE(self):
        """处理 DELETE 请求。

        DELETE 通常表示“删除数据”。

        当前自定义接口：
        - DELETE /api/config：删除 API 配置
        - DELETE /api/sessions：删除所有会话和当前会话 ID
        """

        if self.path == "/api/config":
            delete_state("config")
            self.send_json({"ok": True})
            return

        if self.path == "/api/sessions":
            delete_state("sessions", "activeId")
            self.send_json({"ok": True})
            return

        self.send_json({"ok": False, "error": "Unknown endpoint"}, status=404)


# 下面这段是程序入口。
# 只有当你直接运行 python server.py 时，它才会执行。
# 如果别的 Python 文件 import server.py，这里不会自动启动服务。
if __name__ == "__main__":
    # argparse 用来读取命令行参数。
    # 比如 python server.py --no-open
    # --no-open 的意思是：启动服务，但不要自动打开浏览器。
    parser = argparse.ArgumentParser(description="Run LLM Studio with a local SQLite database.")
    parser.add_argument("--no-open", action="store_true", help="Do not open the browser automatically.")
    args = parser.parse_args()

    # 先确保数据库和表已经创建。
    init_db()

    # 创建一个本地 HTTP 服务。
    # ThreadingHTTPServer 表示可以同时处理多个请求。
    server = ThreadingHTTPServer((HOST, PORT), LLMStudioHandler)

    url = f"http://{HOST}:{PORT}/index.html"
    print(f"LLM Studio is running: {url}")
    print(f"SQLite database: {DB_PATH}")

    # 默认自动打开浏览器。
    # 如果命令里带了 --no-open，就不自动打开。
    if not args.no_open:
        webbrowser.open(url)

    # 让服务一直运行。
    # 只要这个程序不关闭，网页就可以继续读写数据库。
    server.serve_forever()
