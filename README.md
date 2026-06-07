 # LLM Studio
 
 本地运行的 LLM 对话界面 —— 支持多模型提供商、Pi Agent 本地编程协作、会话持久化。零构建步骤，零外部 Python 依赖。
 
 ## 特性
 
 - **多模型对话** — 支持 OpenAI、DeepSeek、Qwen、GLM、Kimi、SiliconFlow、MiMo 等主流 API，基于标准 API 地址切换
 - **Pi Agent 集成** — 接入本地 Pi CLI 作为 Agent，在对话中直接对本地项目执行编程任务
 - **项目管理** — 为 Pi Agent 绑定本地项目文件夹，会话和任务记录按项目自动隔离
 - **会话历史** — 所有对话持久化至 SQLite 数据库，支持历史检索与重命名
 - **数学渲染** — 内嵌 MathJax 支持，`$...$` 行内公式与 `$$...$$` 块公式自动渲染
 - **Markdown 渲染** — 使用 marked + DOMPurify 安全渲染 Markdown，支持代码高亮、表格、图片引用
 - **主题界面** — 暗色奢华画廊风格（MUSE 设计体系），搭配玻璃态亮色覆盖层
 - **file:// 模式** — 可直接在本地打开前端 HTML 文件运行，无需启动服务器（此时数据存储在 localStorage）
 
 ## 快速开始
 
 ### 前提条件
 
 - Python 3.11+
 - 一个或多个 LLM API Key
 
 ### 启动
 
 ```bash
 # 默认端口 8765
 python backend/server.py
 
 # 自定义端口，不自动打开浏览器
 python backend/server.py --port 9000 --no-open
 ```
 
 Windows 上也可以双击 `start_server.bat`。
 
 启动后访问 http://127.0.0.1:8765。
 
 ### 配置 Provider
 
 1. 点击右上角 **配置** 标签
 2. 选择 **对话模型** 或 **Agent 模型** 标签页
 3. 点击预设按钮（OpenAI / DeepSeek / Qwen 等）自动填入 API 地址
 4. 填入对应的 API Key
 5. 选择或输入要启用的模型名称
 6. 点击 **保存配置**
 
 ### 开始对话
 
 - **对话** 标签页 — 直接与配置的 API 模型对话
 - **Agent** 标签页 — 绑定项目后，通过 Pi CLI 对本地代码执行操作
 
 ## 项目界面
 
 ### 项目（Agent 项目）
 
 管理用于 Pi Agent 的本地项目文件夹。每个项目有自己的 `.pi/` 会话目录，会话记录按项目分开存储。
 
 ### 对话 / Agent
 
 左侧边栏显示历史会话列表，支持：
 
 - 新建对话（`+ 新建对话`）
 - 重命名会话（双击标题）
 - 删除会话
 - 全部清空
 
 右侧输入区支持 `Enter` 发送、`Shift+Enter` 换行。
 
 Agent 模式下输入区顶部显示项目路径提示和当前 Git 分支。
 
 ### 配置
 
 双标签页配置：
 
 - **对话模型** — 用于普通聊天的 API
 - **Agent 模型** — 仅支持 Pi CLI，配置 Pi CLI 的命令路径
 
 ## 项目结构
 
 ```
 ├── backend/
 │   └── server.py          # HTTP 服务器 + SQLite 持久层（单文件 ~1670 行）
 ├── frontend/
 │   ├── index.html          # 主页面
 │   ├── scripts/
 │   │   └── app.js          # SPA 应用逻辑（~2585 行）
 │   ├── styles/
 │   │   └── main.css        # 双主题样式表（~2875 行）
 │   └── images/             # 静态图片资源
 ├── data/
 │   └── llm_studio.sqlite   # SQLite 数据库（自动创建）
 ├── tests/
 │   └── test_pi_projects.py # 单元测试
 ├── start_server.bat        # Windows 启动脚本
 ├── MUSE DESIGN.md          # MUSE 设计体系文档
 └── CLAUDE.md               # 开发指导（供 AI 编码助手使用）
 ```
 
 ## 架构说明
 
 ### 后端
 
 `backend/server.py` 是一个单文件 Python 服务器，使用标准库 `http.server` 实现：
 
 - 同时提供静态文件服务和 REST API
 - SQLite 数据库用于持久化配置、会话和消息
 - Pi CLI 集成：通过 subprocess 调用 `pi --print`，以 NDJSON 格式流式输出
 
 API 端点：
 
 | 方法   | 路径                      | 用途             |
 |--------|--------------------------|------------------|
 | GET    | `/api/state`            | 获取完整应用状态    |
 | GET/POST/DELETE | `/api/config` | 配置 CRUD         |
 | GET/POST | `/api/sessions`     | 会话读写          |
 | POST   | `/api/active-session`   | 设置当前会话      |
 | POST   | `/api/active-project`   | 设置当前项目      |
 | GET    | `/api/pi-projects`      | 列 Pi 项目        |
 | GET    | `/api/pi-sessions`      | 列 Pi 会话        |
 | POST   | `/api/pi-project`       | 创建 Pi 项目      |
 | DELETE | `/api/pi-session`       | 删除 Pi 会话文件  |
 | DELETE | `/api/pi-project`       | 删除 Pi 项目目录  |
 | POST   | `/api/cli/chat`         | Pi CLI 流式对话   |
 | GET    | `/api/project-image`    | 提供项目文件夹内的图片 |
 | GET    | `/api/project-files`    | 列出项目文件      |
 
 ### 前端
 
 纯 JavaScript SPA，无框架依赖。状态管理采用全局缓存变量 + 数据库/localStorage 双存储策略：
 
 - HTTP 模式下自动与 SQLite 同步
 - `file://` 模式下回退至 localStorage
 
 ### 存储
 
 - **SQLite 数据库**：`data/llm_studio.sqlite`
 - **表结构**：`app_meta`、`model_provider_configs`、`chat_sessions`、`chat_messages`
 - **本地存储**：在 `file://` 模式下使用 localStorage 作为降级方案
 - **迁移机制**：从 localStorage 自动迁移到 SQLite
 
 ## 配置 Provider 预设
 
 | Provider      | API 地址                                         |
 |---------------|-------------------------------------------------|
 | MiMo          | `https://token-plan-cn.xiaomimimo.com/v1/...`   |
 | OpenAI        | `https://api.openai.com/v1/chat/completions`   |
 | DeepSeek      | `https://api.deepseek.com/v1/chat/completions` |
 | Qwen          | `https://dashscope.aliyuncs.com/compatible-mode/...` |
 | GLM           | `https://open.bigmodel.cn/api/paas/v4/...`     |
 | Kimi          | `https://api.moonshot.cn/v1/chat/completions`  |
 | SiliconFlow   | `https://api.siliconflow.cn/v1/...`            |
 | Pi CLI        | 本地命令路径                                      |
 
 ## 测试
 
 ```bash
 python -m unittest tests.test_pi_projects
 ```
 
 ## 技术栈
 
 | 层       | 技术                                      |
 |----------|------------------------------------------|
 | 后端     | Python 标准库（http.server, sqlite3）      |
 | 前端     | 原生 HTML + CSS + JavaScript（无框架）      |
 | 渲染     | marked, DOMPurify, MathJax 3（CDN）       |
 | 存储     | SQLite / localStorage                     |
 | Agent    | Pi CLI（subprocess 集成）                  |
 | 设计     | MUSE Design System（暗色奢华风格）           |
 
 ## 许可
 
 MIT


