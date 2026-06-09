<p align="center">
  <picture>
    <img src="https://raw.githubusercontent.com/Mingqing-H/Muse-PI/main/muse_pi_logo.ico" width="96" alt="MUSE PI">
  </picture>
</p>

<h1 align="center">MUSE PI</h1>

<p align="center">
  <em>不只是聊天界面，是你桌面上的一座私人 AI 画廊。</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.11%2B-8a8078?style=flat-square" alt="Python">
  <img src="https://img.shields.io/badge/依赖-零-8a8078?style=flat-square" alt="zero deps">
  <img src="https://img.shields.io/badge/构建-零步骤-c9a96e?style=flat-square" alt="zero build">
  <img src="https://img.shields.io/badge/许可-MIT-c9a96e?style=flat-square" alt="MIT">
  <img src="https://img.shields.io/badge/版本-v1.0.0-1a1714?style=flat-square" alt="v1.0.0">
</p>

---

## ✨ 这是什么

**MUSE PI** 是一个跑在你本地的 AI 对话界面。它兼具两种灵魂 ——

- 🎨 **暗色画廊般的聊天室** —— 接入 OpenAI、DeepSeek、Qwen、GLM、Kimi、SiliconFlow 等主流大模型，只管打字聊天。
- 🤖 **你的编程搭子** —— 挂载本地项目后，Pi CLI Agent 直接在对话里帮你写代码、改文件、查 BUG。

不需要 Docker。不需要 npm install。不需要 pip install -r requirements.txt。**拉下来就能跑。**

---

## 🎬 一秒开始

```bash
python backend/server.py
```

然后浏览器自动打开 `http://127.0.0.1:9000`，你就进入了。

Windows 用户直接双击 `start_server.bat`，连终端都不用开。

> 没有 Python？去 [Releases](https://github.com/Mingqing-H/Muse-PI/releases) 下载 `Muse Pi.exe`，双击即用。关掉页面自动退出，干净利落。

---

## 🖤 为什么你会喜欢它

### 它好看

我们不是在开玩笑。MUSE PI 遵循一套独立的设计体系 —— **[MUSE Design](MUSE%20DESIGN.md)**：暖黑底色、金色微光、衬线标题、玻璃态面板、电影感光影。打开它的第一秒，你不会觉得这是又一个「开发者工具」。

- 暗色奢华画廊风格，不是蓝紫科技渐变
- Cormorant Garamond 衬线标题 + 中文宋体正文
- 金色作为唯一强调色，克制优雅
- 按钮像画廊邀请函，不像系统控件
- 毛玻璃导航栏 + 点击涟漪 + 滚动渐变 reveal

**你的终端是黑的，IDE 是黑的，凭什么聊天界面不能也是黑的且好看的？**

### 它极简

整个项目 **零外部依赖**。后端用 Python 标准库手搓了一个 HTTP 服务器 + SQLite 持久层；前端纯 HTML + CSS + JavaScript，没有 React、没有 Vue、没有 Webpack、没有 node_modules。

| 文件 | 行数 | 做了什么 |
|------|------|----------|
| `backend/server.py` | ~1980 | HTTP 服务 + REST API + SQLite + Pi CLI 集成 |
| `frontend/scripts/app.js` | ~3780 | 完整 SPA：四视图路由、SSE 流式对话、会话管理、配置系统、@文件引用 |
| `frontend/styles/main.css` | ~4200 | MUSE 设计体系 + 双主题 + 动效系统 + 响应式 |

近万行手写代码，没有一行是 AI 生成的脚手架。(你信吗？)

### 它聪明

- 🔌 **8 家 LLM 一键切换** —— MiMo、OpenAI、DeepSeek、Qwen、GLM、Kimi、SiliconFlow、Pi CLI，预设 API 地址点击即填
- 💬 **SSE 流式对话** —— 看着 AI 一个字一个字打出来，不是干等转圈
- 🧠 **@ 文件引用** —— 输入 `@` 自动弹出项目文件列表，直接引用代码上下文
- 🖼️ **项目内图片渲染** —— Agent 生成的图自动显示在对话里
- 📐 **LaTeX 数学渲染** —— MathJax 加持，`$E=mc^2$` 直接变公式
- 🔄 **会话持久化** —— SQLite 存一切，关了再开对话还在
- 📂 **项目隔离** —— 不同项目绑定独立的 Pi CLI 会话目录
- 💓 **心跳检测** —— 浏览器关了服务器自动退出，不多占你一个端口
- 🔍 **端口自动寻找** —— 默认端口被占了？自动找下一个可用的

### 它自由

- 🏠 **file:// 模式** —— 不启动服务器也能用，直接双击 `index.html` 打开，数据存 localStorage
- 💾 **localStorage → SQLite 自动迁移** —— 从 file 模式切到服务器模式，旧数据自动搬过去
- 🎯 **Agent 模型可选** —— Pi CLI 支持 `--model` 切换，不同任务用不同模型

---

## 🏗️ 项目结构

```
Muse-PI/
├── backend/
│   └── server.py          ← 整个后端，一个文件
├── frontend/
│   ├── index.html          ← 入口
│   ├── scripts/
│   │   └── app.js          ← 整个前端逻辑，一个文件
│   └── styles/
│       └── main.css        ← 整个样式系统，一个文件
├── tests/
│   └── test_pi_projects.py ← 单元测试
├── start_server.bat        ← Windows 一键启动
├── MUSE DESIGN.md          ← 设计体系文档
└── README.md               ← 你正在看的这个
```

**三个核心文件，一万行代码，一个完整产品。**

---

## 🎨 设计哲学

跟大多数 AI 聊天工具体验不同，MUSE PI 在视觉上下了真功夫。它的界面语言来自 [MUSE DESIGN.md](MUSE%20DESIGN.md) —— 一份独立的设计规范文档，定义了从色彩系统、字体层级、动效曲线到交互模式的完整体系。

部分亮点：

- **玻璃态顶部导航** —— `backdrop-filter: blur(24px)` + 半透明暖黑背景
- **金色细光强调** —— 仅用于焦点态和关键按钮，占比不超过界面的 5%
- **衬线标题 × 无衬线正文** —— 编辑式留白，像一本暗色摄影画册
- **缓出动效** —— `cubic-bezier(0.16, 1, 0.3, 1)`，慢速、优雅、像镜头推近
- **点击涟漪** —— 金色渐变光环跟随每次鼠标点击
- **双主题** —— MUSE 暗色主主题 + 亮色/玻璃覆盖层

> 我们不把聊天界面当工具做。我们把它当画廊做。

---

## 🚀 Release

**[v1.0.0](https://github.com/Mingqing-H/Muse-PI/releases/tag/v1.0.0)** 已发布，附带打包好的 Windows `.exe`：

- 双击 `Muse Pi.exe`，自动启动服务器并打开浏览器
- 关闭页面后服务器自动退出
- 无需安装 Python 或任何依赖

```bash
# 或者从源码启动
python backend/server.py
python backend/server.py --port 9000 --no-open   # 自定义端口，不自动打开浏览器
```

---

## 🔧 配置指南

1. 打开**配置**标签页
2. 点击预设按钮（OpenAI / DeepSeek / Qwen 等），自动填入 API 地址
3. 填入你的 API Key
4. 勾选要启用的模型
5. 保存，切回**对话**标签页开始聊天

Agent 模式同理 —— 在配置页切到 **Agent 模型**，选择 Pi CLI，填入 `pi` 命令路径即可。

---

## 📡 API 一览

| 方法 | 端点 | 说明 |
|------|------|------|
| `GET` | `/api/state` | 全量状态快照（配置 + 项目 + 会话） |
| `GET`/`POST`/`DELETE` | `/api/config` | 模型配置 CRUD |
| `GET`/`POST`/`DELETE` | `/api/sessions` | 会话读写 / 清空 |
| `POST` | `/api/active-session` | 切换当前会话 |
| `POST` | `/api/active-project` | 切换当前项目 |
| `GET` | `/api/pi-projects` | 列出 Agent 项目 |
| `POST` | `/api/pi-project` | 新建 Agent 项目 |
| `DELETE` | `/api/pi-project` | 删除项目（保留源文件） |
| `GET` | `/api/pi-sessions` | 项目下的会话列表 |
| `POST` | `/api/cli/chat` | Pi CLI 流式对话（NDJSON） |
| `GET` | `/api/pi-skills` | 列出项目可用 Skills |
| `GET` | `/api/project-files` | 按关键词检索项目文件 |
| `GET` | `/api/project-image` | 代理项目内的图片 |
| `GET` | `/api/pi-models` | 列出 Pi CLI 可用模型 |
| `GET` | `/api/heartbeat` | 浏览器心跳，服务器自动关停 |

---

## 🧪 测试

```bash
python -m unittest tests.test_pi_projects
```

---

## 🤝 贡献

欢迎提 Issue 和 PR。如果你喜欢这个项目，**给个 Star ⭐** 就是最大的鼓励。

你还可以：
- 阅读 [MUSE DESIGN.md](MUSE%20DESIGN.md) 了解设计语言
- 阅读 [CLAUDE.md](CLAUDE.md) 了解代码架构
- 在 [Discussions](https://github.com/Mingqing-H/Muse-PI/discussions) 分享你的使用体验

---

## 📜 许可

MIT License — 拿去做你想做的事。

---

<p align="center">
  <sub>Made with ♥ by <a href="https://github.com/Mingqing-H">Mingqing Huang</a> · Central South University</sub>
</p>

<p align="center">
  <sub>如果你觉得好用，求一颗 ⭐ 星星 —— 它真的会让我开心一整天 🌟</sub>
</p>
