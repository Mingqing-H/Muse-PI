const PRESETS = [
  { name: 'MiMo',     url: 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions', models: ['mimo-v2.5-pro', 'mimo-v2.5'] },
  { name: 'OpenAI',   url: 'https://api.openai.com/v1/chat/completions', models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'] },
  { name: 'DeepSeek', url: 'https://api.deepseek.com/v1/chat/completions', models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'] },
  { name: 'Qwen',     url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', models: ['qwen3.7-max', 'qwen3.6-plus', 'qwen3.6-flash', 'qwen-plus', 'qwen-turbo', 'qwen-max'] },
  { name: 'GLM',      url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', models: ['glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7', 'glm-4.7-flashx', 'glm-4.7-flash', 'glm-4-long'] },
  { name: 'Kimi',     url: 'https://api.moonshot.cn/v1/chat/completions', models: ['kimi-latest', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  { name: 'SiliconFlow', url: 'https://api.siliconflow.cn/v1/chat/completions', models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct', 'Pro/deepseek-ai/DeepSeek-V3'] },
  { name: 'Pi CLI',   url: '', models: ['default'], kind: 'cli' },
];

const STORAGE_KEY = 'llm_config';
const PROJECTS_KEY = 'llm_projects';
const ACTIVE_PROJECT_KEY = 'llm_active_project';
const SESSIONS_KEY = 'llm_sessions';
const ACTIVE_KEY = 'llm_active_session';
const $ = id => document.getElementById(id);
let USE_DATABASE = location.protocol !== 'file:';

let configCache = null;
let piCliInfo = null;
let projectsCache = {};
let activeProjectIdCache = null;
let sessionsCache = {};
let activeIdCache = null;
let activePresetIndex = -1;
let activeRunMode = 'chat';

async function apiRequest(path, options = {}) {
  const resp = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

async function loadDatabaseState() {
  if (!USE_DATABASE) {
    try { configCache = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { configCache = null; }
    try { projectsCache = JSON.parse(localStorage.getItem(PROJECTS_KEY)) || {}; } catch { projectsCache = {}; }
    activeProjectIdCache = localStorage.getItem(ACTIVE_PROJECT_KEY) || null;
    try { sessionsCache = JSON.parse(localStorage.getItem(SESSIONS_KEY)) || {}; } catch { sessionsCache = {}; }
    activeIdCache = localStorage.getItem(ACTIVE_KEY) || null;
    ensureDefaultProject();
    return;
  }

  const state = await apiRequest('/api/state');
  configCache = state.config || null;
  piCliInfo = state.piCli || null;
  projectsCache = state.projects || {};
  activeProjectIdCache = state.activeProjectId || null;
  sessionsCache = state.sessions || {};
  activeIdCache = state.activeId || null;

  await migrateLocalStorageState();
  ensureDefaultProject();
}

async function migrateLocalStorageState() {
  const hasDatabaseData = configCache || Object.keys(sessionsCache).length > 0 || activeIdCache;
  if (hasDatabaseData) return;

  let localConfig = null;
  let localProjects = {};
  let localSessions = {};
  try { localConfig = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch {}
  try { localProjects = JSON.parse(localStorage.getItem(PROJECTS_KEY)) || {}; } catch {}
  try { localSessions = JSON.parse(localStorage.getItem(SESSIONS_KEY)) || {}; } catch {}
  const localActiveProjectId = localStorage.getItem(ACTIVE_PROJECT_KEY) || null;
  const localActiveId = localStorage.getItem(ACTIVE_KEY) || null;

  if (!localConfig && Object.keys(localProjects).length === 0 && Object.keys(localSessions).length === 0 && !localActiveId) return;

  configCache = localConfig;
  projectsCache = localProjects;
  activeProjectIdCache = localActiveProjectId;
  ensureDefaultProject();
  sessionsCache = localSessions;
  activeIdCache = localActiveId;
  if (configCache) await apiRequest('/api/config', { method: 'POST', body: JSON.stringify({ config: configCache }) });
  if (Object.keys(projectsCache).length > 0) await apiRequest('/api/projects', { method: 'POST', body: JSON.stringify({ projects: projectsCache }) });
  if (activeProjectIdCache) await apiRequest('/api/active-project', { method: 'POST', body: JSON.stringify({ activeProjectId: activeProjectIdCache }) });
  if (Object.keys(sessionsCache).length > 0) await apiRequest('/api/sessions', { method: 'POST', body: JSON.stringify({ sessions: sessionsCache }) });
  if (activeIdCache) await apiRequest('/api/active-session', { method: 'POST', body: JSON.stringify({ activeId: activeIdCache }) });
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(PROJECTS_KEY);
  localStorage.removeItem(ACTIVE_PROJECT_KEY);
  localStorage.removeItem(SESSIONS_KEY);
  localStorage.removeItem(ACTIVE_KEY);
}

function persistConfig() {
  if (USE_DATABASE) apiRequest('/api/config', { method: 'POST', body: JSON.stringify({ config: configCache }) }).catch(console.error);
  else localStorage.setItem(STORAGE_KEY, JSON.stringify(configCache));
}

function ensurePiCliDefaultConfig() {
  const store = toConfigStore(configCache);
  if (store.activeProvider || Object.keys(store.providers).length > 0) return;
  store.activeProvider = 'Pi CLI';
  store.providers['Pi CLI'] = {
    provider: 'Pi CLI',
    apiUrl: '',
    apiKey: '',
    modelName: 'default',
  };
  configCache = store;
  persistConfig();
}

function clearPersistedConfig() {
  if (USE_DATABASE) apiRequest('/api/config', { method: 'DELETE' }).catch(console.error);
  else localStorage.removeItem(STORAGE_KEY);
}

function defaultProject() {
  return {
    id: 'default',
    name: '本地工作区',
    path: location.protocol === 'file:' ? '' : location.origin,
    description: '默认项目',
    created: Date.now(),
    updated: Date.now(),
  };
}

function ensureDefaultProject() {
  if (!projectsCache || typeof projectsCache !== 'object') projectsCache = {};
  if (Object.keys(projectsCache).length === 0) {
    const p = defaultProject();
    projectsCache[p.id] = p;
    activeProjectIdCache = p.id;
  }
  if (!activeProjectIdCache || !projectsCache[activeProjectIdCache]) {
    activeProjectIdCache = Object.keys(projectsCache)[0];
  }
}

function persistProjects() {
  if (USE_DATABASE) apiRequest('/api/projects', { method: 'POST', body: JSON.stringify({ projects: projectsCache }) }).catch(console.error);
  else localStorage.setItem(PROJECTS_KEY, JSON.stringify(projectsCache));
}

function persistActiveProject() {
  if (USE_DATABASE) apiRequest('/api/active-project', { method: 'POST', body: JSON.stringify({ activeProjectId: activeProjectIdCache }) }).catch(console.error);
  else localStorage.setItem(ACTIVE_PROJECT_KEY, activeProjectIdCache || '');
}

function persistSessions() {
  if (USE_DATABASE) apiRequest('/api/sessions', { method: 'POST', body: JSON.stringify({ sessions: sessionsCache }) }).catch(console.error);
  else localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessionsCache));
}

function persistActiveId() {
  if (USE_DATABASE) apiRequest('/api/active-session', { method: 'POST', body: JSON.stringify({ activeId: activeIdCache }) }).catch(console.error);
  else localStorage.setItem(ACTIVE_KEY, activeIdCache || '');
}

function clearPersistedSessions() {
  sessionsCache = {};
  activeIdCache = null;
  if (USE_DATABASE) apiRequest('/api/sessions', { method: 'DELETE' }).catch(console.error);
  else {
    localStorage.removeItem(SESSIONS_KEY);
    localStorage.removeItem(ACTIVE_KEY);
  }
}

// Tab switching
document.querySelectorAll('.tab-btn').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === b.dataset.tab + 'View'));
    if (b.dataset.tab === 'projects') renderProjects();
    if (b.dataset.tab === 'chat') refreshChat();
    if (b.dataset.tab === 'config') $('configView').scrollTop = 0;
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
  const saved = getProviderConfig(i);
  activePresetIndex = i;
  $('apiUrl').value = saved?.apiUrl || p.url;
  $('apiKey').value = saved?.apiKey || '';
  updateModelDatalist(i);
  $('modelName').value = saved?.modelName || p.models[0] || '';
  syncPresetSelection(i);
  syncProviderFields(i);
}

function normalizeUrl(url) {
  return (url || '').trim().replace(/\/+$/, '');
}

function getPresetIndexForConfig(config) {
  const apiUrl = normalizeUrl(config?.apiUrl);
  if (!apiUrl) return -1;
  return PRESETS.findIndex(p => normalizeUrl(p.url) === apiUrl);
}

function providerNameForIndex(index) {
  return index >= 0 && PRESETS[index] ? PRESETS[index].name : 'custom';
}

function getPresetIndexForProviderName(name) {
  return PRESETS.findIndex(p => p.name === name);
}

function isCliProviderName(name) {
  const preset = PRESETS[getPresetIndexForProviderName(name)];
  return preset?.kind === 'cli';
}

function isCliConfig(config = getConfig()) {
  return isCliProviderName(config?.provider);
}

function syncProviderFields(activeIndex) {
  const preset = PRESETS[activeIndex];
  const isCli = preset?.kind === 'cli';
  if ($('apiUrlLabel')) $('apiUrlLabel').innerHTML = isCli ? 'Pi CLI 本地路径 <span class="hint">&mdash; 留空自动识别 pi</span>' : 'API 地址 <span class="hint">&mdash; OpenAI 兼容格式</span>';
  if ($('apiKeyLabel')) $('apiKeyLabel').textContent = 'API Key';
  if ($('modelNameLabel')) $('modelNameLabel').textContent = isCli ? '显示名称' : '模型名称';
  if ($('apiUrl')) $('apiUrl').placeholder = isCli ? '留空自动识别，或填写 D:\\npm-global\\pi.cmd' : 'https://api.openai.com/v1/chat/completions';
  if ($('apiKey')) $('apiKey').placeholder = 'sk-...';
  if ($('modelName')) $('modelName').placeholder = isCli ? 'default' : 'gpt-4o';
  const keyField = $('apiKey')?.closest('.field');
  if (keyField) keyField.classList.toggle('hidden', isCli);
  if (isCli && $('apiKey')) $('apiKey').value = '';
  updatePiCliPathStatus();
}

function isAutoPiCommand(value) {
  const normalized = (value || '').trim().toLowerCase();
  return !normalized || normalized === 'pi' || normalized === 'pi -p {prompt}';
}

function normalizePiCommandPreview(command) {
  const value = (command || '').trim();
  if (!value) return 'pi -p {prompt}';
  if (value.includes('{prompt}') || /\s(--print|-p)(\s|$)/.test(value)) return value;
  return `${value} -p {prompt}`;
}

function updatePiCliPathStatus() {
  const status = $('piCliPathStatus');
  if (!status) return;
  const isCli = activePresetIndex >= 0 && PRESETS[activePresetIndex]?.kind === 'cli';
  status.style.display = isCli ? '' : 'none';
  if (!isCli) return;

  const rawConfigured = $('apiUrl')?.value.trim() || '';
  const configured = isAutoPiCommand(rawConfigured) ? '' : rawConfigured;
  const detected = piCliInfo?.detectedPath || '';
  const executable = configured || detected || '未找到 pi';
  const command = configured ? normalizePiCommandPreview(configured) : (piCliInfo?.command || 'pi -p {prompt}');
  status.innerHTML = `
    <div><span>自动识别</span><code>${escapeHtml(detected || '未找到，请手动填写 pi.cmd 路径')}</code></div>
    <div><span>当前使用</span><code>${escapeHtml(executable)}</code></div>
    <div><span>执行命令</span><code>${escapeHtml(command)}</code></div>
  `;
}

async function refreshPiCliInfo() {
  if (!USE_DATABASE) return;
  try {
    piCliInfo = await apiRequest('/api/pi-cli-info');
    updatePiCliPathStatus();
  } catch (err) {
    console.error(err);
  }
}

function isConfigStore(config) {
  return !!config && typeof config === 'object' && !!config.providers && typeof config.providers === 'object';
}

function toConfigStore(config) {
  if (isConfigStore(config)) {
    return {
      activeProvider: config.activeProvider || null,
      providers: config.providers || {},
    };
  }

  if (config && (config.apiUrl || config.apiKey || config.modelName)) {
    const presetIndex = getPresetIndexForConfig(config);
    const provider = providerNameForIndex(presetIndex);
    return {
      activeProvider: provider,
      providers: {
        [provider]: { ...config, provider },
      },
    };
  }

  return { activeProvider: null, providers: {} };
}

function getProviderConfig(index) {
  const store = toConfigStore(configCache);
  return store.providers[providerNameForIndex(index)] || null;
}

function getActiveProviderConfig() {
  const store = toConfigStore(configCache);
  if (!store.activeProvider) return null;
  return store.providers[store.activeProvider] || null;
}

function syncPresetSelection(activeIndex) {
  document.querySelectorAll('.preset-btn').forEach((b, j) => b.classList.toggle('active', j === activeIndex));
}

function updateModelDatalist(activeIndex) {
  const dl = $('model-list');
  dl.innerHTML = '';
  if (activeIndex < 0) return;
  PRESETS[activeIndex].models.forEach(m => {
    const o = document.createElement('option');
    o.value = m;
    dl.appendChild(o);
  });
}

function loadConfig() {
  configCache = toConfigStore(configCache);
  const c = getActiveProviderConfig();
  let presetIndex = getPresetIndexForProviderName(configCache.activeProvider);
  if (presetIndex < 0) presetIndex = getPresetIndexForConfig(c);
  activePresetIndex = presetIndex;

  if (c) {
    const preset = presetIndex >= 0 ? PRESETS[presetIndex] : null;
    const isCli = preset?.kind === 'cli';
    $('apiUrl').value = isCli && isAutoPiCommand(c.apiUrl) ? '' : c.apiUrl || preset?.url || '';
    $('apiKey').value = c.apiKey || '';
    $('modelName').value = c.modelName || preset?.models?.[0] || '';
  } else {
    $('apiUrl').value = '';
    $('apiKey').value = '';
    $('modelName').value = '';
  }

  syncPresetSelection(presetIndex);
  updateModelDatalist(presetIndex);
  syncProviderFields(presetIndex);
  return c;
}

function getConfig() { return getActiveProviderConfig(); }

function saveConfig() {
  const c = { apiUrl: $('apiUrl').value.trim(), apiKey: $('apiKey').value.trim(), modelName: $('modelName').value.trim() };
  const presetIndex = activePresetIndex >= 0 ? activePresetIndex : getPresetIndexForConfig(c);
  const provider = providerNameForIndex(presetIndex);
  const isCli = isCliProviderName(provider);
  if (isCli) {
    c.apiKey = '';
    c.modelName = c.modelName || 'default';
  } else if (!c.apiUrl || !c.apiKey || !c.modelName) {
    showToast('请填写所有字段', 'var(--rose)');
    return false;
  }
  const store = toConfigStore(configCache);
  store.activeProvider = provider;
  store.providers[provider] = { ...c, provider };
  configCache = store;
  persistConfig();
  activePresetIndex = presetIndex;
  syncPresetSelection(presetIndex);
  updateModelDatalist(presetIndex);
  updatePiCliPathStatus();
  refreshPiCliInfo();
  updateModelBadge(); showToast('配置已保存', 'var(--accent)'); return true;
}

$('saveBtn').onclick = saveConfig;
$('clearBtn').onclick = () => {
  const store = toConfigStore(configCache);
  const provider = providerNameForIndex(activePresetIndex);
  delete store.providers[provider];
  store.activeProvider = null;
  configCache = Object.keys(store.providers).length ? store : null;
  if (configCache) persistConfig();
  else clearPersistedConfig();
  $('apiUrl').value = ''; $('apiKey').value = ''; $('modelName').value = '';
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  updateModelBadge(); showToast('配置已清除', 'var(--muted)');
};
$('toggleKey').onclick = () => { const i = $('apiKey'); i.type = i.type === 'password' ? 'text' : 'password'; };
$('apiUrl').addEventListener('input', updatePiCliPathStatus);
$('goChatBtn').onclick = () => { if (saveConfig()) { document.querySelectorAll('.tab-btn').forEach(x => x.classList.toggle('active', x.dataset.tab === 'chat')); document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'chatView')); refreshChat(); } };

function updateModelBadge() {
  const c = getConfig(), b = $('modelBadge');
  if (c && c.modelName) { b.textContent = isCliConfig(c) ? `Pi CLI · ${c.modelName}` : c.modelName; b.classList.remove('empty'); }
  else { b.textContent = '未配置'; b.classList.add('empty'); }
}

// Projects
function getProjects() { ensureDefaultProject(); return projectsCache; }
function getActiveProjectId() { ensureDefaultProject(); return activeProjectIdCache; }
function getActiveProject() { const projects = getProjects(); return projects[getActiveProjectId()] || null; }

function setActiveProject(id) {
  if (!projectsCache[id]) return;
  activeProjectIdCache = id;
  persistActiveProject();
  const projectSessions = getProjectSessionIds(id);
  if (!projectSessions.includes(getActiveId())) setActiveId(projectSessions[0] || null);
  renderProjectControls();
  renderProjects();
  refreshChat();
}

function createProjectFromPrompt() {
  const name = prompt('项目名称', '新项目');
  if (!name) return null;
  const path = prompt('项目路径（Pi CLI 会在这个目录执行）', '');
  if (path === null) return null;
  const id = 'p_' + Date.now();
  projectsCache[id] = {
    id,
    name: name.trim() || '新项目',
    path: path.trim(),
    description: '',
    created: Date.now(),
    updated: Date.now(),
  };
  activeProjectIdCache = id;
  persistProjects();
  persistActiveProject();
  renderProjectControls();
  renderProjects();
  refreshChat();
  showToast('项目已创建', 'var(--accent)');
  return id;
}

function getProjectSessionIds(projectId = getActiveProjectId()) {
  return Object.values(getSessions())
    .filter(s => (s.projectId || 'default') === projectId)
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .map(s => s.id);
}

function renderProjectControls() {
  const project = getActiveProject();
  if ($('projectBadge')) $('projectBadge').textContent = project?.name || '本地工作区';
  if ($('activeProjectHint')) $('activeProjectHint').textContent = project ? project.path || project.name : '';

  const select = $('projectSelect');
  if (!select) return;
  select.innerHTML = '';
  Object.values(getProjects())
    .sort((a, b) => (b.updated || 0) - (a.updated || 0))
    .forEach(projectItem => {
      const option = document.createElement('option');
      option.value = projectItem.id;
      option.textContent = projectItem.name;
      option.selected = projectItem.id === getActiveProjectId();
      select.appendChild(option);
    });
}

function renderProjects() {
  renderProjectControls();
  const grid = $('projectGrid');
  if (!grid) return;
  const sessions = getSessions();
  grid.innerHTML = '';
  Object.values(getProjects()).forEach(project => {
    const count = Object.values(sessions).filter(s => (s.projectId || 'default') === project.id).length;
    const card = document.createElement('button');
    card.className = 'project-card' + (project.id === getActiveProjectId() ? ' active' : '');
    card.innerHTML = `
      <span class="project-card-kicker">${count} 个会话</span>
      <strong>${escapeHtml(project.name)}</strong>
      <small>${escapeHtml(project.path || '未设置路径')}</small>
    `;
    card.onclick = () => setActiveProject(project.id);
    grid.appendChild(card);
  });
}

if ($('projectSelect')) $('projectSelect').onchange = e => setActiveProject(e.target.value);
if ($('btnNewProject')) $('btnNewProject').onclick = createProjectFromPrompt;
if ($('btnCreateProject')) $('btnCreateProject').onclick = createProjectFromPrompt;
if ($('btnOpenProjectChat')) $('btnOpenProjectChat').onclick = () => document.querySelector('[data-tab=chat]')?.click();

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.onclick = () => {
    if (isStreaming) return;
    activeRunMode = btn.dataset.mode || 'chat';
    document.querySelectorAll('.mode-btn').forEach(x => x.classList.toggle('active', x === btn));
    inputEl.placeholder = activeRunMode === 'task' ? '描述要在当前项目中执行的任务...' : '输入消息...';
  };
});

// Sessions
function getSessions() { return sessionsCache; }
function saveSessions(s) { sessionsCache = s; persistSessions(); }
function getActiveId() { return activeIdCache; }
function setActiveId(id) { activeIdCache = id; persistActiveId(); }

function createSession() {
  const s = getSessions();
  const id = 's_' + Date.now();
  s[id] = { id, title: '新会话', projectId: getActiveProjectId(), mode: 'chat', status: 'idle', messages: [], created: Date.now() };
  saveSessions(s); setActiveId(id);
  renderSessionList(); renderMessages();
  return id;
}

function deleteSession(id) {
  const s = getSessions();
  delete s[id]; saveSessions(s);
  if (getActiveId() === id) {
    const keys = getProjectSessionIds();
    setActiveId(keys.length ? keys[0] : null);
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
  const keys = getProjectSessionIds();

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
    clearPersistedSessions();
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
  const requiresApiKey = cfg && !isCliConfig(cfg);
  if (!cfg || !cfg.apiUrl || (requiresApiKey && !cfg.apiKey) || !cfg.modelName) {
    messagesEl.innerHTML = '<div class="no-config"><div class="icon">&#9670;</div><p>请先配置 Pi CLI 或模型接口</p><button onclick="document.querySelectorAll(\'[data-tab=config]\').forEach(x=>x.click())">前往配置</button></div>';
    inputArea.style.display = 'none';
    return;
  }
  const sessions = getSessions();
  const projectSessionIds = getProjectSessionIds();
  if (projectSessionIds.length === 0) createSession();
  else if (!getActiveId() || !sessions[getActiveId()] || (sessions[getActiveId()].projectId || 'default') !== getActiveProjectId()) setActiveId(projectSessionIds[0]);

  inputArea.style.display = '';
  renderProjectControls();
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

let markedConfigured = false;

function escapeHtml(text) {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function normalizeMarkdown(content) {
  return (content || '').replace(/^(#{1,4})([^\s#])/gm, '$1 $2');
}

function extractMath(content) {
  const blocks = [];
  const inlines = [];
  let text = (content || '').replace(/(^|\n)(\s*(?:\\\[[\s\S]+?\\\]|\$\$[\s\S]+?\$\$)\s*)(?=\n|$)/g, (match, prefix, source) => {
    const token = `MATHBLOCK${blocks.length}`;
    blocks.push(source.trim());
    return prefix ? `${prefix}\n${token}` : token;
  });

  text = text.replace(/\\\(([\s\S]+?)\\\)|(?<!\$)\$([^$\n]+?)\$(?!\$)/g, (match) => {
    const token = `MATHINLINE${inlines.length}`;
    inlines.push(match.trim());
    return token;
  });

  return { text, blocks, inlines };
}

function restoreMath(html, blocks, inlines) {
  let output = blocks.reduce((current, source, index) => {
    const token = `MATHBLOCK${index}`;
    const block = `<div class="math-block" data-latex="${escapeHtml(source)}">${escapeHtml(source)}</div>`;
    return current
      .replace(new RegExp(`<p>\\s*${token}\\s*</p>`, 'g'), block)
      .replace(new RegExp(token, 'g'), block);
  }, html);

  output = inlines.reduce((current, source, index) => {
    const token = `MATHINLINE${index}`;
    const inline = `<span class="math-inline" data-latex="${escapeHtml(source)}">${escapeHtml(source)}</span>`;
    return current.replace(new RegExp(token, 'g'), inline);
  }, output);

  return output;
}

function isTableDivider(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function isBlockStart(line, nextLine = '') {
  return /^(#{1,4})\s+/.test(line)
    || /^[-*+]\s+/.test(line)
    || /^\d+\.\s+/.test(line)
    || /^>\s?/.test(line)
    || /^```/.test(line)
    || (line.includes('|') && isTableDivider(nextLine));
}

function renderBasicMarkdown(content) {
  const lines = (content || '').split('\n');
  const blocks = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;

    const fence = line.match(/^```(\w+)?/);
    if (fence) {
      const code = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s*(\S.*)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    if (line.includes('|') && isTableDivider(lines[i + 1] || '')) {
      const headers = splitTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      i -= 1;
      blocks.push(`<table><thead><tr>${headers.map(cell => `<th>${renderInlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${renderInlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }

    if (/^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const ordered = /^\d+\.\s+/.test(line);
      const itemPattern = ordered ? /^\d+\.\s+/ : /^[-*+]\s+/;
      const items = [];
      while (i < lines.length && itemPattern.test(lines[i])) {
        items.push(lines[i].replace(itemPattern, ''));
        i += 1;
      }
      i -= 1;
      const tag = ordered ? 'ol' : 'ul';
      blocks.push(`<${tag}>${items.map(item => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</${tag}>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      i -= 1;
      blocks.push(`<blockquote>${renderInlineMarkdown(quote.join('\n')).replace(/\n/g, '<br>')}</blockquote>`);
      continue;
    }

    const paragraph = [line];
    while (i + 1 < lines.length && lines[i + 1].trim() && !isBlockStart(lines[i + 1], lines[i + 2] || '')) {
      i += 1;
      paragraph.push(lines[i]);
    }
    blocks.push(`<p>${renderInlineMarkdown(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }

  return blocks.join('');
}

function configureMarked() {
  if (markedConfigured || !window.marked) return;
  marked.setOptions({
    gfm: true,
    breaks: true,
    headerIds: false,
    mangle: false,
  });
  markedConfigured = true;
}

function renderMarkdown(content) {
  configureMarked();
  const { text, blocks, inlines } = extractMath(normalizeMarkdown(content));
  const html = !window.marked || !window.DOMPurify
    ? renderBasicMarkdown(text)
    : DOMPurify.sanitize(marked.parse(text));
  return restoreMath(html, blocks, inlines);
}

function typesetMath(element) {
  if (!window.MathJax?.typesetPromise) return;
  if (window.MathJax.typesetClear) MathJax.typesetClear([element]);
  MathJax.typesetPromise([element]).catch(console.error);
}

function formatLatexFallback(source) {
  let text = escapeHtml(source.trim()
    .replace(/^\\\[/, '')
    .replace(/\\\]$/, '')
    .replace(/^\\\(/, '')
    .replace(/\\\)$/, '')
    .replace(/^\$\$/, '')
    .replace(/\$\$$/, '')
    .replace(/^\$/, '')
    .replace(/\$$/, '')
    .trim());
  text = text
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '<span class="math-frac"><span>$1</span><span>$2</span></span>')
    .replace(/([A-Za-z0-9})])_\\?\{([^{}]+)\}/g, '$1<sub>$2</sub>')
    .replace(/([A-Za-z0-9})])\^\\?\{([^{}]+)\}/g, '$1<sup>$2</sup>')
    .replace(/([A-Za-z0-9})])_([A-Za-z0-9]+)/g, '$1<sub>$2</sub>')
    .replace(/([A-Za-z0-9})])\^(-?[A-Za-z0-9]+)/g, '$1<sup>$2</sup>')
    .replace(/\\text\{([^{}]+)\}/g, '<span class="math-text">$1</span>')
    .replace(/\\mathrm\{([^{}]+)\}/g, '<span class="math-text">$1</span>')
    .replace(/\\times/g, '&times;')
    .replace(/\\cdot/g, '&middot;')
    .replace(/\\,/g, ' ')
    .replace(/\\([A-Za-z]+)/g, '$1');
  return text;
}

function applyDisplayMathFallback(element) {
  element.querySelectorAll('.math-block, .math-inline').forEach(block => {
    const source = block.dataset.latex || block.textContent;
    const isDisplay = block.classList.contains('math-block');
    block.innerHTML = `<span class="math-fallback${isDisplay ? ' display' : ''}">${formatLatexFallback(source)}</span>`;
  });
}

function applyMathFallback(element) {
  if (window.MathJax?.typesetPromise) return;
  applyDisplayMathFallback(element);
  const skipTags = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE']);
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if ([...skipTags].some(tag => node.parentElement?.closest(tag.toLowerCase()))) return NodeFilter.FILTER_REJECT;
      return /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+?\$)/.test(node.nodeValue)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(node => {
    const html = node.nodeValue
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => `<span class="math-fallback display">${formatLatexFallback(expr)}</span>`)
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, expr) => `<span class="math-fallback display">${formatLatexFallback(expr)}</span>`)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, expr) => `<span class="math-fallback">${formatLatexFallback(expr)}</span>`)
      .replace(/\$([^$\n]+?)\$/g, (_, expr) => `<span class="math-fallback">${formatLatexFallback(expr)}</span>`);
    const span = document.createElement('span');
    span.innerHTML = html;
    node.parentNode.replaceChild(span, node);
  });
}

function setBubbleContent(bubble, role, content, renderRich = role !== 'user', renderMath = true) {
  if (role === 'user' || !renderRich) {
    bubble.textContent = content;
    return;
  }
  bubble.innerHTML = renderMarkdown(content);
  if (renderMath && window.MathJax?.typesetPromise) typesetMath(bubble);
  else applyMathFallback(bubble);
}

function createRichStreamRenderer(bubble) {
  let lastRender = 0;
  let pending = false;
  let pendingTimer = null;
  let latestContent = '';

  return (content, force = false) => {
    latestContent = content;
    if (force && pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
      pending = false;
    }
    const now = Date.now();
    if (!force && now - lastRender < 220) {
      if (!pending) {
        pending = true;
        pendingTimer = setTimeout(() => {
          pending = false;
          pendingTimer = null;
          lastRender = Date.now();
          setBubbleContent(bubble, 'assistant', latestContent, true, false);
          scrollToBottom();
        }, 220);
      }
      return;
    }
    lastRender = now;
    setBubbleContent(bubble, 'assistant', content, true, force);
    scrollToBottom();
  };
}

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
  setBubbleContent(bubble, role, content);

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

async function readOpenAIStream(cfg, messages, onDelta) {
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
        if (delta) onDelta(delta);
      } catch {}
    }
  }
}

async function readCliStream(prompt, messages, onDelta) {
  const resp = await fetch('/api/cli/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: getActiveProjectId(),
      mode: activeRunMode,
      prompt,
      messages,
    }),
    signal: abortController.signal,
  });

  const reader = resp.body.getReader(), decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.error) throw new Error(event.error);
      if (event.delta) onDelta(event.delta);
    }
  }
}

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || isStreaming) return;
  const cfg = getConfig();
  if (!cfg) { document.querySelectorAll('[data-tab=config]').forEach(x => x.click()); return; }

  let session = getActiveSession();
  if (!session) { createSession(); session = getActiveSession(); }
  session.projectId = session.projectId || getActiveProjectId();
  session.mode = activeRunMode;
  session.status = activeRunMode === 'task' ? 'running' : 'idle';

  session.messages.push({ role: 'user', content: text });

  if (session.messages.filter(m => m.role === 'user').length === 1) {
    const title = text.length > 30 ? text.slice(0, 30) + '...' : text;
    updateActiveSession({ title, projectId: session.projectId, mode: session.mode, status: session.status, messages: session.messages, created: session.created });
    renderSessionList();
  } else {
    updateActiveSession({ projectId: session.projectId, mode: session.mode, status: session.status, messages: session.messages });
  }

  appendBubble('user', text);
  inputEl.value = ''; inputEl.style.height = 'auto'; inputEl.focus();

  isStreaming = true;
  sendBtn.innerHTML = '&#9632;';
  sendBtn.classList.add('stop'); sendBtn.title = '停止';

  const botBubble = appendBubble('assistant', '');
  botBubble.classList.add('streaming');
  const renderBotStream = createRichStreamRenderer(botBubble);
  let fullContent = '';

  try {
    abortController = new AbortController();
    const messages = session.messages.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
    const onDelta = delta => { fullContent += delta; renderBotStream(fullContent); };
    if (isCliConfig(cfg)) await readCliStream(text, messages, onDelta);
    else await readOpenAIStream(cfg, messages, onDelta);
  } catch (err) {
    if (err.name === 'AbortError') { fullContent += '\n\n[已停止]'; }
    else { botBubble.classList.remove('streaming'); botBubble.parentElement.className = 'msg error bot'; botBubble.textContent = `请求失败: ${err.message}`; }
  }

  botBubble.classList.remove('streaming');
  if (fullContent) {
    renderBotStream(fullContent, true);
    session = getActiveSession();
    if (session) { session.messages.push({ role: 'assistant', content: fullContent }); updateActiveSession({ messages: session.messages, status: 'idle' }); }
  }

  isStreaming = false;
  abortController = null;
  updateActiveSession({ status: 'idle' });
  sendBtn.innerHTML = '&#8593;';
  sendBtn.classList.remove('stop'); sendBtn.title = '发送';
}

function stopStreaming() { if (abortController) abortController.abort(); }

// Init
async function initApp() {
  try {
    await loadDatabaseState();
  } catch (err) {
    console.error(err);
    showToast('数据库连接失败，已切换为浏览器临时存储', 'var(--rose)');
    USE_DATABASE = false;
    await loadDatabaseState();
  }
  ensurePiCliDefaultConfig();
  loadConfig(); updateModelBadge(); renderProjectControls(); renderProjects(); refreshChat();
}

initApp();
