const PRESETS = [
  { name: 'MiMo',     url: 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions', models: ['mimo-v2.5-pro', 'mimo-v2.5'] },
  { name: 'OpenAI',   url: 'https://api.openai.com/v1/chat/completions', models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'] },
  { name: 'DeepSeek', url: 'https://api.deepseek.com/v1/chat/completions', models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'] },
  { name: 'Qwen',     url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', models: ['qwen3.7-max', 'qwen3.6-plus', 'qwen3.6-flash', 'qwen-plus', 'qwen-turbo', 'qwen-max'] },
  { name: 'GLM',      url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', models: ['glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7', 'glm-4.7-flashx', 'glm-4.7-flash', 'glm-4-long'] },
  { name: 'Kimi',     url: 'https://api.moonshot.cn/v1/chat/completions', models: ['kimi-latest', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  { name: 'SiliconFlow', url: 'https://api.siliconflow.cn/v1/chat/completions', models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct', 'Pro/deepseek-ai/DeepSeek-V3'] },
];

const STORAGE_KEY = 'llm_config';
const SESSIONS_KEY = 'llm_sessions';
const ACTIVE_KEY = 'llm_active_session';
const $ = id => document.getElementById(id);

// Tab switching
document.querySelectorAll('.tab-btn').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === b.dataset.tab + 'View'));
    if (b.dataset.tab === 'chat') refreshChat();
  });
});

// Config
const presetsEl = $('presets');
PRESETS.forEach((p, i) => {
  const btn = document.createElement('button');
  btn.className = 'preset-btn'; btn.textContent = p.name;
  btn.onclick = () => applyPreset(i);
  presetsEl.appendChild(btn);
});

function applyPreset(i) {
  const p = PRESETS[i];
  $('apiUrl').value = p.url;
  const dl = $('model-list'); dl.innerHTML = '';
  p.models.forEach(m => { const o = document.createElement('option'); o.value = m; dl.appendChild(o); });
  $('modelName').value = p.models[0] || '';
  document.querySelectorAll('.preset-btn').forEach((b, j) => b.classList.toggle('active', j === i));
}

function loadConfig() {
  try { const c = JSON.parse(localStorage.getItem(STORAGE_KEY)); if (c) { $('apiUrl').value = c.apiUrl || ''; $('apiKey').value = c.apiKey || ''; $('modelName').value = c.modelName || ''; } return c; } catch { return null; }
}

function getConfig() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; } }

function saveConfig() {
  const c = { apiUrl: $('apiUrl').value.trim(), apiKey: $('apiKey').value.trim(), modelName: $('modelName').value.trim() };
  if (!c.apiUrl || !c.apiKey || !c.modelName) { showToast('请填写所有字段', 'var(--rose)'); return false; }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  updateModelBadge(); showToast('配置已保存', 'var(--accent)'); return true;
}

$('saveBtn').onclick = saveConfig;
$('clearBtn').onclick = () => {
  localStorage.removeItem(STORAGE_KEY);
  $('apiUrl').value = ''; $('apiKey').value = ''; $('modelName').value = '';
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  updateModelBadge(); showToast('配置已清除', 'var(--muted)');
};
$('toggleKey').onclick = () => { const i = $('apiKey'); i.type = i.type === 'password' ? 'text' : 'password'; };
$('goChatBtn').onclick = () => { if (saveConfig()) { document.querySelectorAll('.tab-btn').forEach(x => x.classList.toggle('active', x.dataset.tab === 'chat')); document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'chatView')); refreshChat(); } };

function updateModelBadge() {
  const c = getConfig(), b = $('modelBadge');
  if (c && c.modelName) { b.textContent = c.modelName; b.classList.remove('empty'); }
  else { b.textContent = '未配置'; b.classList.add('empty'); }
}

// Sessions
function getSessions() { try { return JSON.parse(localStorage.getItem(SESSIONS_KEY)) || {}; } catch { return {}; } }
function saveSessions(s) { localStorage.setItem(SESSIONS_KEY, JSON.stringify(s)); }
function getActiveId() { return localStorage.getItem(ACTIVE_KEY) || null; }
function setActiveId(id) { localStorage.setItem(ACTIVE_KEY, id); }

function createSession() {
  const s = getSessions();
  const id = 's_' + Date.now();
  s[id] = { id, title: '新会话', messages: [], created: Date.now() };
  saveSessions(s); setActiveId(id);
  renderSessionList(); renderMessages();
  return id;
}

function deleteSession(id) {
  const s = getSessions();
  delete s[id]; saveSessions(s);
  if (getActiveId() === id) {
    const keys = Object.keys(s);
    setActiveId(keys.length ? keys[keys.length - 1] : null);
  }
  renderSessionList(); renderMessages();
}

function getActiveSession() {
  const s = getSessions(), id = getActiveId();
  return id && s[id] ? s[id] : null;
}

function updateActiveSession(patch) {
  const s = getSessions(), id = getActiveId();
  if (!id || !s[id]) return;
  Object.assign(s[id], patch); saveSessions(s);
}

function switchSession(id) {
  if (isStreaming) return;
  setActiveId(id); renderSessionList(); renderMessages();
}

function renderSessionList() {
  const list = $('sessionList');
  const sessions = getSessions();
  const activeId = getActiveId();
  const keys = Object.keys(sessions).sort((a, b) => (sessions[b].created || 0) - (sessions[a].created || 0));

  list.innerHTML = '';
  if (keys.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:40px 12px;color:var(--border-light);font-size:12px;letter-spacing:0.1em;">暂无会话</div>';
    return;
  }

  keys.forEach(id => {
    const s = sessions[id];
    const item = document.createElement('div');
    item.className = 'session-item' + (id === activeId ? ' active' : '');

    const title = document.createElement('div');
    title.className = 'session-title';
    title.textContent = s.title || '新会话';
    title.title = s.title || '新会话';

    const time = document.createElement('div');
    time.className = 'session-time';
    time.textContent = formatTime(s.created);

    const del = document.createElement('button');
    del.className = 'session-del';
    del.innerHTML = '&times;';
    del.title = '删除';
    del.onclick = (e) => {
      e.stopPropagation();
      showConfirm(`确定删除「${s.title || '新会话'}」？`, () => deleteSession(id));
    };

    item.onclick = () => switchSession(id);
    item.appendChild(title);
    item.appendChild(time);
    item.appendChild(del);
    list.appendChild(item);
  });
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date(), diff = now - d;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
  return (d.getMonth() + 1) + '/' + d.getDate();
}

$('btnNewSession').onclick = () => { if (isStreaming) return; createSession(); $('input').focus(); };

$('btnClearAll').onclick = () => {
  showConfirm('确定删除所有会话？此操作不可撤销。', () => {
    localStorage.removeItem(SESSIONS_KEY);
    localStorage.removeItem(ACTIVE_KEY);
    renderSessionList(); renderMessages();
    showToast('所有会话已清空', 'var(--muted)');
  });
};

function showConfirm(msg, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  overlay.innerHTML = `
    <div class="confirm-box">
      <p>${msg}</p>
      <div class="confirm-actions">
        <button class="c-cancel">取消</button>
        <button class="c-danger">确认</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.c-cancel').onclick = () => overlay.remove();
  overlay.querySelector('.c-danger').onclick = () => { overlay.remove(); onConfirm(); };
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// Chat
const messagesEl = $('messages');
const inputEl = $('input');
const sendBtn = $('sendBtn');
const inputArea = $('inputArea');

let isStreaming = false;
let abortController = null;

function refreshChat() {
  updateModelBadge();
  const cfg = getConfig();
  if (!cfg || !cfg.apiUrl || !cfg.apiKey || !cfg.modelName) {
    messagesEl.innerHTML = '<div class="no-config"><div class="icon">&#9670;</div><p>请先配置大模型接口</p><button onclick="document.querySelectorAll(\'[data-tab=config]\').forEach(x=>x.click())">前往配置</button></div>';
    inputArea.style.display = 'none';
    return;
  }
  const sessions = getSessions();
  if (Object.keys(sessions).length === 0) createSession();
  else if (!getActiveId() || !sessions[getActiveId()]) setActiveId(Object.keys(sessions).sort((a, b) => (sessions[b].created || 0) - (sessions[a].created || 0))[0]);

  inputArea.style.display = '';
  renderSessionList(); renderMessages();
}

function renderMessages() {
  messagesEl.innerHTML = '';
  const session = getActiveSession();
  if (!session || session.messages.length === 0) {
    messagesEl.innerHTML = `
      <div class="welcome">
        <div class="icon">&#9670;</div>
        <h2>开始 <em>对话</em></h2>
        <p>输入任意消息与大模型交流</p>
        <div class="tips">
          <div class="tip" onclick="useTip(this)">解释量子计算</div>
          <div class="tip" onclick="useTip(this)">写一首关于春天的诗</div>
          <div class="tip" onclick="useTip(this)">用 Python 实现快速排序</div>
          <div class="tip" onclick="useTip(this)">推荐几本科幻小说</div>
        </div>
      </div>`;
    return;
  }
  session.messages.forEach(m => appendBubble(m.role, m.content, false));
  scrollToBottom();
}

function useTip(el) { inputEl.value = el.textContent; inputEl.focus(); }

function appendBubble(role, content, animate = true) {
  const welcome = messagesEl.querySelector('.welcome');
  if (welcome) welcome.remove();

  const div = document.createElement('div');
  div.className = `msg ${role === 'user' ? 'user' : 'bot'}`;
  if (!animate) div.style.animation = 'none';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? '你' : 'AI';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = content;

  div.appendChild(avatar);
  div.appendChild(bubble);
  messagesEl.appendChild(div);
  scrollToBottom();
  return bubble;
}

function scrollToBottom() { requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; }); }

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
});

inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

sendBtn.addEventListener('click', () => { if (isStreaming) stopStreaming(); else sendMessage(); });

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || isStreaming) return;
  const cfg = getConfig();
  if (!cfg) { document.querySelectorAll('[data-tab=config]').forEach(x => x.click()); return; }

  let session = getActiveSession();
  if (!session) { createSession(); session = getActiveSession(); }

  session.messages.push({ role: 'user', content: text });

  if (session.messages.filter(m => m.role === 'user').length === 1) {
    const title = text.length > 30 ? text.slice(0, 30) + '...' : text;
    updateActiveSession({ title, messages: session.messages, created: session.created });
    renderSessionList();
  } else {
    updateActiveSession({ messages: session.messages });
  }

  appendBubble('user', text);
  inputEl.value = ''; inputEl.style.height = 'auto'; inputEl.focus();

  isStreaming = true;
  sendBtn.innerHTML = '&#9632;';
  sendBtn.classList.add('stop'); sendBtn.title = '停止';

  const botBubble = appendBubble('assistant', '');
  botBubble.classList.add('streaming');
  let fullContent = '';

  try {
    abortController = new AbortController();
    const messages = session.messages.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));

    const resp = await fetch(cfg.apiUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.modelName, messages, stream: true }),
      signal: abortController.signal,
    });

    if (!resp.ok) { const e = await resp.text(); throw new Error(`HTTP ${resp.status}: ${e.slice(0, 200)}`); }

    const reader = resp.body.getReader(), decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t || !t.startsWith('data: ')) continue;
        const d = t.slice(6);
        if (d === '[DONE]') continue;
        try {
          const delta = JSON.parse(d).choices?.[0]?.delta?.content;
          if (delta) { fullContent += delta; botBubble.textContent = fullContent; scrollToBottom(); }
        } catch {}
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') { fullContent += '\n\n[已停止]'; }
    else { botBubble.classList.remove('streaming'); botBubble.parentElement.className = 'msg error bot'; botBubble.textContent = `请求失败: ${err.message}`; }
  }

  botBubble.classList.remove('streaming');
  if (fullContent) {
    session = getActiveSession();
    if (session) { session.messages.push({ role: 'assistant', content: fullContent }); updateActiveSession({ messages: session.messages }); }
  }

  isStreaming = false;
  abortController = null;
  sendBtn.innerHTML = '&#8593;';
  sendBtn.classList.remove('stop'); sendBtn.title = '发送';
}

function stopStreaming() { if (abortController) abortController.abort(); }

// Init
loadConfig(); updateModelBadge(); refreshChat();
