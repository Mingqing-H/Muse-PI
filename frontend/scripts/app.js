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
const CHAT_SCOPE = 'chat';
const AGENT_SCOPE = 'agent';
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
const IMAGE_EXT_PATTERN = IMAGE_EXTENSIONS.join('|');

const STORAGE_KEY = 'llm_config';
const PROJECTS_KEY = 'llm_projects';
const ACTIVE_PROJECT_KEY = 'llm_active_project';
const SESSIONS_KEY = 'llm_sessions';
const ACTIVE_KEY = 'llm_active_session';
const SIDEBAR_COLLAPSED_KEY = 'llm_sidebar_collapsed';
const $ = id => document.getElementById(id);
let USE_DATABASE = location.protocol !== 'file:';

let configCache = null;
let piCliInfo = null;
let projectsCache = {};
let activeProjectIdCache = null;
let sessionsCache = {};
let activeIdCache = null;
let activePresetIndex = -1;
let activeConfigScope = CHAT_SCOPE;
let activeWorkspace = CHAT_SCOPE;
let activeRunMode = 'chat';
const syncedPiProjects = new Set();
const streamingByScope = { [CHAT_SCOPE]: false, [AGENT_SCOPE]: false };
const abortControllersByScope = { [CHAT_SCOPE]: null, [AGENT_SCOPE]: null };
const inFlightByScope = { [CHAT_SCOPE]: null, [AGENT_SCOPE]: null };
const unreadScopes = new Set();

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
  if (!store.providers['Pi CLI']) {
    store.providers['Pi CLI'] = {
      provider: 'Pi CLI',
      apiUrl: '',
      apiKey: '',
      modelName: 'default',
    };
  }
  if (!store.activeAgentProvider) store.activeAgentProvider = 'Pi CLI';
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

function isWorkspaceStreaming(scope = activeWorkspace) {
  return !!streamingByScope[scope];
}

function setWorkspaceStreaming(scope, value, controller = null) {
  streamingByScope[scope] = !!value;
  abortControllersByScope[scope] = value ? controller : null;
  updateSendButtonState();
}

function updateSendButtonState() {
  if (!sendBtn) return;
  if (isWorkspaceStreaming(activeWorkspace)) {
    sendBtn.innerHTML = sendButtonIcon('stop') + '<span>停止</span>';
    sendBtn.classList.add('stop');
    sendBtn.title = '停止';
  } else {
    sendBtn.innerHTML = sendButtonIcon('send') + '<span>发送</span>';
    sendBtn.classList.remove('stop');
    sendBtn.title = '发送';
  }
}

function sendButtonIcon(kind = 'send') {
  if (kind === 'stop') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"></rect></svg>';
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.5 20 4l-7.5 16-1.8-6.7L4 11.5Z"></path><path d="m11 13 4.8-4.8"></path></svg>';
}

function renderTabUnread() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const scope = btn.dataset.tab;
    btn.classList.toggle('has-unread', unreadScopes.has(scope) && scope !== activeWorkspace);
  });
}

function markWorkspaceUnread(scope) {
  if (scope === activeWorkspace) return;
  unreadScopes.add(scope);
  renderTabUnread();
}

function clearWorkspaceUnread(scope) {
  unreadScopes.delete(scope);
  renderTabUnread();
}

// Tab switching
document.querySelectorAll('.tab-btn').forEach(b => {
  b.addEventListener('click', async () => {
    const tab = b.dataset.tab;
    const targetViewId = (tab === CHAT_SCOPE || tab === AGENT_SCOPE) ? 'chatView' : `${tab}View`;
    document.querySelectorAll('.tab-btn').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === targetViewId));
    // 只在对话和 Agent 标签显示右上角模型信息
    const topbarRight = document.querySelector('.topbar-right');
    if (topbarRight) topbarRight.style.visibility = (tab === CHAT_SCOPE || tab === AGENT_SCOPE) ? '' : 'hidden';
    if (tab === 'projects') renderProjects();
    if (tab === CHAT_SCOPE || tab === AGENT_SCOPE) {
      activeWorkspace = tab;
      if (tab === AGENT_SCOPE) activeRunMode = 'task';
      clearWorkspaceUnread(tab);
      await refreshChat();
    }
    if (tab === 'config') $('configView').scrollTop = 0;
    updateSendButtonState();
    renderTabUnread();
  });
});

// Config
const presetsEl = $('presets');

function presetIndicesForScope(scope = activeConfigScope) {
  return PRESETS
    .map((preset, index) => ({ preset, index }))
    .filter(({ preset }) => scope === AGENT_SCOPE ? preset.kind === 'cli' : preset.kind !== 'cli')
    .map(({ index }) => index);
}

function renderPresets() {
  presetsEl.innerHTML = '';
  presetIndicesForScope().forEach(i => {
    const p = PRESETS[i];
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.dataset.index = String(i);
    btn.textContent = p.name;
    btn.onclick = () => applyPreset(i);
    presetsEl.appendChild(btn);
  });
}

function setConfigScope(scope) {
  activeConfigScope = scope;
  document.querySelectorAll('.config-scope-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.scope === scope);
  });
  if ($('configHeaderTitle')) $('configHeaderTitle').innerHTML = scope === AGENT_SCOPE ? 'Agent <em>配置</em>' : '对话 <em>配置</em>';
  if ($('configHeaderText')) $('configHeaderText').textContent = scope === AGENT_SCOPE ? '配置用于本地项目操作的 Pi Agent' : '配置用于普通对话的 API 模型';
  if ($('goChatBtn')) $('goChatBtn').innerHTML = scope === AGENT_SCOPE ? '保存并进入 Agent &rarr;' : '保存并开始对话 &rarr;';
  renderPresets();
  loadConfig();
}

document.querySelectorAll('.config-scope-btn').forEach(btn => {
  btn.onclick = () => setConfigScope(btn.dataset.scope || CHAT_SCOPE);
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

function isAgentWorkspace() {
  return activeWorkspace === AGENT_SCOPE;
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
    const activeProvider = config.activeProvider || null;
    const providers = config.providers || {};
    const activeChatProvider = config.activeChatProvider
      || (activeProvider && !isCliProviderName(activeProvider) ? activeProvider : null)
      || Object.keys(providers).find(name => !isCliProviderName(name))
      || null;
    const activeAgentProvider = config.activeAgentProvider
      || (activeProvider && isCliProviderName(activeProvider) ? activeProvider : null)
      || Object.keys(providers).find(name => isCliProviderName(name))
      || null;
    return {
      activeChatProvider,
      activeAgentProvider,
      providers,
    };
  }

  if (config && (config.apiUrl || config.apiKey || config.modelName)) {
    const presetIndex = getPresetIndexForConfig(config);
    const provider = providerNameForIndex(presetIndex);
    const isCli = isCliProviderName(provider);
    return {
      activeChatProvider: isCli ? null : provider,
      activeAgentProvider: isCli ? provider : null,
      providers: {
        [provider]: { ...config, provider },
      },
    };
  }

  return { activeChatProvider: null, activeAgentProvider: null, providers: {} };
}

function getProviderConfig(index) {
  const store = toConfigStore(configCache);
  return store.providers[providerNameForIndex(index)] || null;
}

function getActiveProviderConfig() {
  const store = toConfigStore(configCache);
  const provider = activeConfigScope === AGENT_SCOPE ? store.activeAgentProvider : store.activeChatProvider;
  if (!provider) return null;
  return store.providers[provider] || null;
}

function getScopedConfig(scope = activeWorkspace) {
  const store = toConfigStore(configCache);
  const provider = scope === AGENT_SCOPE ? store.activeAgentProvider : store.activeChatProvider;
  if (!provider) return null;
  return store.providers[provider] || null;
}

function syncPresetSelection(activeIndex) {
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.toggle('active', Number(b.dataset.index) === activeIndex));
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
  const activeProvider = activeConfigScope === AGENT_SCOPE ? configCache.activeAgentProvider : configCache.activeChatProvider;
  let presetIndex = getPresetIndexForProviderName(activeProvider);
  if (presetIndex < 0) presetIndex = getPresetIndexForConfig(c);
  if (!presetIndicesForScope().includes(presetIndex)) presetIndex = presetIndicesForScope()[0] ?? -1;
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

function getConfig(scope = activeWorkspace) { return getScopedConfig(scope); }

function saveConfig() {
  const c = { apiUrl: $('apiUrl').value.trim(), apiKey: $('apiKey').value.trim(), modelName: $('modelName').value.trim() };
  const presetIndex = activePresetIndex >= 0 ? activePresetIndex : getPresetIndexForConfig(c);
  const provider = providerNameForIndex(presetIndex);
  const isCli = isCliProviderName(provider);
  if (activeConfigScope === CHAT_SCOPE && isCli) {
    showToast('对话模型不能使用 Pi CLI', 'var(--rose)');
    return false;
  }
  if (activeConfigScope === AGENT_SCOPE && !isCli) {
    showToast('Agent 只能使用 Pi CLI', 'var(--rose)');
    return false;
  }
  if (isCli) {
    c.apiKey = '';
    c.modelName = c.modelName || 'default';
  } else if (!c.apiUrl || !c.apiKey || !c.modelName) {
    showToast('请填写所有字段', 'var(--rose)');
    return false;
  }
  const store = toConfigStore(configCache);
  if (activeConfigScope === AGENT_SCOPE) store.activeAgentProvider = provider;
  else store.activeChatProvider = provider;
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
  if (activeConfigScope === AGENT_SCOPE) store.activeAgentProvider = null;
  else store.activeChatProvider = null;
  configCache = Object.keys(store.providers).length ? store : null;
  if (configCache) persistConfig();
  else clearPersistedConfig();
  $('apiUrl').value = ''; $('apiKey').value = ''; $('modelName').value = '';
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  updateModelBadge(); showToast('配置已清除', 'var(--muted)');
};
$('toggleKey').onclick = () => { const i = $('apiKey'); i.type = i.type === 'password' ? 'text' : 'password'; };
$('apiUrl').addEventListener('input', updatePiCliPathStatus);
$('goChatBtn').onclick = () => {
  if (!saveConfig()) return;
  const target = activeConfigScope === AGENT_SCOPE ? AGENT_SCOPE : CHAT_SCOPE;
  document.querySelectorAll(`.tab-btn[data-tab="${target}"]`).forEach(x => x.click());
};

function updateModelBadge() {
  const c = getConfig(), b = $('modelBadge');
  if (c && c.modelName) { b.textContent = isCliConfig(c) ? `Pi CLI · ${c.modelName}` : c.modelName; b.classList.remove('empty'); }
  else { b.textContent = '未配置'; b.classList.add('empty'); }
}

// Projects
function getProjects() { ensureDefaultProject(); return projectsCache; }
function getActiveProjectId() { ensureDefaultProject(); return activeProjectIdCache; }
function getActiveProject() { const projects = getProjects(); return projects[getActiveProjectId()] || null; }

async function setActiveProject(id) {
  if (!projectsCache[id]) return;
  activeProjectIdCache = id;
  persistActiveProject();
  if (isAgentWorkspace()) {
    try {
      await syncPiProjectSessions(id, true);
    } catch (err) {
      console.error(err);
      showToast('Pi Agent 会话同步失败', 'var(--rose)');
    }
  }
  const projectSessions = getProjectSessionIds(id);
  if (!projectSessions.includes(getActiveId())) setActiveId(projectSessions[0] || null);
  renderProjectControls();
  renderProjects();
  if (isAgentWorkspace()) refreshChat();
}

function saveProjectForm(projectId, values) {
  const isNew = !projectId;
  const id = projectId || 'p_' + Date.now();
  const current = projectsCache[id] || {};
  projectsCache[id] = {
    id,
    name: values.name.trim() || '新项目',
    path: values.path.trim(),
    description: current.description || '',
    created: current.created || Date.now(),
    updated: Date.now(),
  };
  if (isNew) activeProjectIdCache = id;
  persistProjects();
  if (isNew) persistActiveProject();
  renderProjectControls();
  renderProjects();
  if (isAgentWorkspace()) refreshChat();
  showToast(isNew ? '项目已创建' : '项目已更新', 'var(--accent)');
  return id;
}

function openProjectForm(projectId = null) {
  const project = projectId ? getProjects()[projectId] : null;
  if (projectId && !project) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <form class="project-form">
      <div class="project-form-head">
        <h3>${project ? '编辑项目' : '新建项目'}</h3>
        <button type="button" class="modal-x" aria-label="关闭">&times;</button>
      </div>
      <label>
        <span>项目名称</span>
        <input name="name" type="text" value="${escapeHtml(project?.name || '')}" placeholder="例如：我的应用" autocomplete="off">
      </label>
      <label>
        <span>本地文件夹路径</span>
        <div class="path-input-row">
          <input name="path" type="text" value="${escapeHtml(project?.path || '')}" placeholder="C:\\Users\\you\\project" spellcheck="false">
          <button type="button" class="btn-browse" title="浏览文件夹">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            <span>浏览</span>
          </button>
        </div>
      </label>
      <p>Agent 会在这个目录里执行 Pi CLI。请填写本机可访问的完整文件夹路径。</p>
      <div class="project-form-actions">
        <button type="button" class="btn btn-secondary form-cancel">取消</button>
        <button type="submit" class="btn btn-primary">保存</button>
      </div>
    </form>
  `;
  const close = () => overlay.remove();
  document.body.appendChild(overlay);
  const form = overlay.querySelector('form');
  const nameInput = form.elements.name;
  const pathInput = form.elements.path;
  overlay.querySelector('.modal-x').onclick = close;
  overlay.querySelector('.form-cancel').onclick = close;
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  // 浏览文件夹按钮
  const browseBtn = overlay.querySelector('.btn-browse');
  if (browseBtn) {
    browseBtn.onclick = async () => {
      try {
        browseBtn.disabled = true;
        browseBtn.classList.add('loading');
        const resp = await fetch('/api/pick-folder');
        const data = await resp.json();
        if (data.ok && data.path) {
          pathInput.value = data.path;
          pathInput.focus();
        }
      } catch (e) {
        showToast('无法打开文件夹选择器', 'var(--rose)');
      } finally {
        browseBtn.disabled = false;
        browseBtn.classList.remove('loading');
      }
    };
  }
  form.onsubmit = event => {
    event.preventDefault();
    const name = nameInput.value.trim();
    const path = pathInput.value.trim();
    if (!name) {
      showToast('请填写项目名称', 'var(--rose)');
      nameInput.focus();
      return;
    }
    if (!path) {
      showToast('请填写本地文件夹路径', 'var(--rose)');
      pathInput.focus();
      return;
    }
    close();
    saveProjectForm(projectId, { name, path });
  };
  setTimeout(() => nameInput.focus(), 0);
}

function deleteProject(projectId) {
  const project = getProjects()[projectId];
  if (!project) return;
  if (Object.keys(getProjects()).length <= 1) {
    showToast('至少保留一个项目', 'var(--rose)');
    return;
  }
  showConfirm(`确定删除项目「${project.name || '未命名项目'}」？该项目下的 Agent 会话也会删除。`, () => {
    delete projectsCache[projectId];
    const sessions = getSessions();
    Object.keys(sessions).forEach(sessionId => {
      const session = sessions[sessionId];
      if (getSessionKind(session) === AGENT_SCOPE && (session.projectId || 'default') === projectId) {
        delete sessions[sessionId];
      }
    });
    sessionsCache = sessions;
    persistSessions();
    if (activeProjectIdCache === projectId) {
      activeProjectIdCache = Object.keys(projectsCache)[0] || null;
    }
    persistProjects();
    persistActiveProject();
    const visibleSessionIds = getVisibleSessionIds();
    if (!visibleSessionIds.includes(getActiveId())) setActiveId(visibleSessionIds[0] || null);
    renderProjectControls();
    renderProjects();
    if (isAgentWorkspace()) refreshChat();
    showToast('项目已删除', 'var(--muted)');
  });
}

function getProjectSessionIds(projectId = getActiveProjectId()) {
  return Object.values(getSessions())
    .filter(s => getSessionKind(s) === AGENT_SCOPE && (s.projectId || 'default') === projectId)
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .map(s => s.id);
}

function getChatSessionIds() {
  return Object.values(getSessions())
    .filter(s => getSessionKind(s) === CHAT_SCOPE)
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .map(s => s.id);
}

function getVisibleSessionIds() {
  return isAgentWorkspace() ? getProjectSessionIds() : getChatSessionIds();
}

function renderProjectControls() {
  const project = getActiveProject();
  if (isAgentWorkspace()) activeRunMode = 'task';
  if ($('projectBadge')) $('projectBadge').textContent = isAgentWorkspace() ? (project?.name || '本地工作区') : '对话无需项目';
  if ($('activeProjectHint')) $('activeProjectHint').textContent = isAgentWorkspace() && project ? project.path || project.name : '';
  if ($('projectSwitcher')) $('projectSwitcher').style.display = isAgentWorkspace() ? '' : 'none';
  if ($('btnNewSession')) $('btnNewSession').textContent = isAgentWorkspace() ? '+ 新建 Agent 会话' : '+ 新建对话';
  if ($('input')) $('input').placeholder = isAgentWorkspace() ? '描述要在当前项目中执行的任务...' : '输入消息...';

  const trigger = $('projectSelectTrigger');
  const dropdown = $('projectSelectDropdown');
  if (!trigger || !dropdown) return;
  dropdown.innerHTML = '';
  const projects = Object.values(getProjects()).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const activeId = getActiveProjectId();
  const activeProject = projects.find(p => p.id === activeId);
  trigger.textContent = activeProject ? activeProject.name : '选择项目';
  projects.forEach(projectItem => {
    const li = document.createElement('li');
    li.className = 'custom-select-option' + (projectItem.id === activeId ? ' selected' : '');
    li.textContent = projectItem.name;
    li.dataset.value = projectItem.id;
    li.onclick = () => {
      setActiveProject(projectItem.id);
      $('projectSelect')?.classList.remove('open');
    };
    dropdown.appendChild(li);
  });
}

function renderProjects() {
  renderProjectControls();
  const grid = $('projectGrid');
  if (!grid) return;
  const sessions = getSessions();
  grid.innerHTML = '';
  Object.values(getProjects()).forEach(project => {
    const count = Object.values(sessions).filter(s => getSessionKind(s) === AGENT_SCOPE && (s.projectId || 'default') === project.id).length;
    const card = document.createElement('button');
    card.className = 'project-card' + (project.id === getActiveProjectId() ? ' active' : '');
    card.innerHTML = `
      <span class="project-card-kicker">${count} 个 Agent 会话</span>
      <strong>${escapeHtml(project.name)}</strong>
      <small>${escapeHtml(project.path || '未设置路径')}</small>
      <span class="project-card-actions">
        <span class="project-action" data-action="edit">编辑</span>
        <span class="project-action danger" data-action="delete">删除</span>
      </span>
    `;
    card.onclick = event => {
      const action = event.target?.dataset?.action;
      if (action === 'edit') {
        event.stopPropagation();
        openProjectForm(project.id);
        return;
      }
      if (action === 'delete') {
        event.stopPropagation();
        deleteProject(project.id);
        return;
      }
      setActiveProject(project.id);
    };
    card.ondblclick = event => {
      if (event.target?.dataset?.action) return;
      setActiveProject(project.id);
      document.querySelector('[data-tab=agent]')?.click();
    };
    grid.appendChild(card);
  });
}

if ($('projectSelectTrigger')) {
  $('projectSelectTrigger').onclick = e => {
    e.stopPropagation();
    $('projectSelect')?.classList.toggle('open');
  };
  document.addEventListener('click', e => {
    if (!$('projectSelect')?.contains(e.target)) $('projectSelect')?.classList.remove('open');
  });
}
if ($('btnNewProject')) $('btnNewProject').onclick = () => openProjectForm();
if ($('btnCreateProject')) $('btnCreateProject').onclick = () => openProjectForm();
if ($('btnOpenProjectChat')) $('btnOpenProjectChat').onclick = () => document.querySelector('[data-tab=agent]')?.click();


// Sessions
function getSessions() { return sessionsCache; }
function saveSessions(s) { sessionsCache = s; persistSessions(); }
function getActiveId() { return activeIdCache; }
function setActiveId(id) { activeIdCache = id; persistActiveId(); }

function getSessionKind(session) {
  if (session?.kind === CHAT_SCOPE || session?.kind === AGENT_SCOPE) return session.kind;
  return session?.projectId ? AGENT_SCOPE : CHAT_SCOPE;
}

function piPathKey(path) {
  return (path || '').replace(/\\/g, '/').toLowerCase();
}

async function syncPiProjectSessions(projectId = getActiveProjectId(), force = false) {
  if (!USE_DATABASE || !projectId) return false;
  if (!force && syncedPiProjects.has(projectId)) return false;

  const data = await apiRequest(`/api/pi-sessions?projectId=${encodeURIComponent(projectId)}`);
  const piSessions = data.sessions || [];
  const sessions = getSessions();
  const pathToId = new Map();
  Object.entries(sessions).forEach(([id, session]) => {
    const key = piPathKey(session.piSessionPath);
    if (key) pathToId.set(key, id);
  });

  const seenPiPaths = new Set();
  let changed = false;
  piSessions.forEach(piSession => {
    const key = piPathKey(piSession.piSessionPath);
    if (!key) return;
    seenPiPaths.add(key);
    const existingId = pathToId.get(key) || (sessions[piSession.id] ? piSession.id : null);
    if (existingId) {
      sessions[existingId] = {
        ...sessions[existingId],
        ...piSession,
        id: existingId,
        title: piSession.title || sessions[existingId].title,
        source: 'pi',
      };
    } else {
      sessions[piSession.id] = piSession;
    }
    changed = true;
  });

  Object.entries(sessions).forEach(([id, session]) => {
    if (getSessionKind(session) !== AGENT_SCOPE || (session.projectId || 'default') !== projectId) return;
    const key = piPathKey(session.piSessionPath);
    if (session.source === 'pi' && key && !seenPiPaths.has(key)) {
      delete sessions[id];
      changed = true;
    }
  });

  syncedPiProjects.add(projectId);
  if (changed) {
    saveSessions(sessions);
    renderProjects();
  }
  return changed;
}

async function deletePiSessionFile(piSessionPath) {
  if (!piSessionPath) return;
  const resp = await fetch('/api/pi-session', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ piSessionPath }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error(text || `HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
}

function createSession() {
  const s = getSessions();
  const id = 's_' + Date.now();
  s[id] = {
    id,
    title: isAgentWorkspace() ? '新 Agent 会话' : '新对话',
    kind: activeWorkspace,
    projectId: isAgentWorkspace() ? getActiveProjectId() : null,
    mode: isAgentWorkspace() ? 'task' : 'chat',
    status: 'idle',
    messages: [],
    created: Date.now(),
  };
  saveSessions(s); setActiveId(id);
  renderSessionList(); renderMessages();
  return id;
}

function deleteSession(id) {
  const s = getSessions();
  delete s[id]; saveSessions(s);
  if (getActiveId() === id) {
    const keys = getVisibleSessionIds();
    setActiveId(keys.length ? keys[0] : null);
  }
  renderSessionList(); renderMessages();
}

async function deleteSessionWithPiOption(id) {
  const session = getSessions()[id];
  if (!session) return;
  const piSessionPath = getSessionKind(session) === AGENT_SCOPE ? session.piSessionPath : '';

  let deletedPiSession = false;
  if (piSessionPath && USE_DATABASE) {
    try {
      await deletePiSessionFile(piSessionPath);
      deletedPiSession = true;
      syncedPiProjects.delete(session.projectId || 'default');
    } catch (err) {
      console.error(err);
      if (err.status !== 404) {
        showToast('Pi Agent 会话删除失败', 'var(--rose)');
        return;
      }
    }
  }

  deleteSession(id);
  showToast(deletedPiSession ? '会话和 Pi Agent 记录已删除' : '会话已删除', 'var(--muted)');
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

function getSessionById(id) {
  const sessions = getSessions();
  return id && sessions[id] ? sessions[id] : null;
}

function updateSessionById(id, patch) {
  const sessions = getSessions();
  if (!id || !sessions[id]) return null;
  Object.assign(sessions[id], patch);
  saveSessions(sessions);
  return sessions[id];
}

function switchSession(id) {
  if (isWorkspaceStreaming()) return;
  setActiveId(id); renderSessionList(); renderMessages();
}

function renderSessionList() {
  const list = $('sessionList');
  const sessions = getSessions();
  const activeId = getActiveId();
  const keys = getVisibleSessionIds();

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
      showConfirm(`确定删除「${s.title || '新会话'}」？`, () => deleteSessionWithPiOption(id));
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

function formatClock(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function getMessageActorLabel(role, meta = {}) {
  if (role === 'user') return meta.kind === AGENT_SCOPE ? '用户任务' : '用户消息';
  return meta.kind === AGENT_SCOPE ? 'Agent 回复' : 'AI 回复';
}

function getMessageMetaText(role, meta = {}) {
  const parts = [];
  const time = formatClock(meta.created);
  const label = getMessageActorLabel(role, meta);
  if (time) parts.push(`${label} ${time}`);
  else parts.push(label);
  if (role !== 'user') {
    if (Number.isFinite(meta.thinkingMs)) parts.push(`思考耗时 ${formatDuration(meta.thinkingMs)}`);
    else if (meta.pending) parts.push('思考中');
  }
  return parts.join(' · ');
}

function setBubbleMeta(bubble, role, meta = {}) {
  const metaEl = bubble?.parentElement?.querySelector('.msg-meta');
  if (!metaEl) return;
  const text = getMessageMetaText(role, meta);
  metaEl.textContent = text;
  metaEl.classList.toggle('empty', !text);
}

$('btnNewSession').onclick = () => { if (isWorkspaceStreaming()) return; createSession(); $('input').focus(); };

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
const chatLayoutEl = document.querySelector('.chat-layout');
const sidebarToggle = $('sidebarToggle');

function setSidebarCollapsed(collapsed, persist = true) {
  if (!chatLayoutEl || !sidebarToggle) return;
  chatLayoutEl.classList.toggle('sidebar-collapsed', collapsed);
  sidebarToggle.title = collapsed ? '显示会话窗格' : '隐藏会话窗格';
  sidebarToggle.setAttribute('aria-label', sidebarToggle.title);
  if (persist) localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
}

if (sidebarToggle) {
  setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1', false);
  sidebarToggle.onclick = () => setSidebarCollapsed(!chatLayoutEl?.classList.contains('sidebar-collapsed'));
}

async function refreshChat() {
  updateModelBadge();
  const cfg = getConfig();
  if (isAgentWorkspace()) {
    try {
      await syncPiProjectSessions(getActiveProjectId());
    } catch (err) {
      console.error(err);
      showToast('Pi Agent 会话同步失败', 'var(--rose)');
    }
  }
  const requiresApiKey = cfg && !isCliConfig(cfg);
  const invalidConfig = !cfg
    || (isAgentWorkspace() ? !isCliConfig(cfg) : isCliConfig(cfg))
    || (!isCliConfig(cfg) && !cfg.apiUrl)
    || (requiresApiKey && !cfg.apiKey)
    || !cfg.modelName;
  if (invalidConfig) {
    const missing = isAgentWorkspace() ? '请先配置 Agent 使用的 Pi CLI' : '请先配置对话使用的 API 模型';
    messagesEl.innerHTML = `<div class="no-config"><div class="icon">&#9670;</div><p>${missing}</p><button id="emptyConfigBtn">前往配置</button></div>`;
    const emptyConfigBtn = $('emptyConfigBtn');
    if (emptyConfigBtn) emptyConfigBtn.onclick = () => {
      document.querySelector('[data-tab=config]')?.click();
      setConfigScope(isAgentWorkspace() ? AGENT_SCOPE : CHAT_SCOPE);
    };
    inputArea.style.display = 'none';
    renderProjectControls();
    renderSessionList();
    return;
  }
  const sessions = getSessions();
  const visibleSessionIds = getVisibleSessionIds();
  if (visibleSessionIds.length === 0) createSession();
  else if (!getActiveId() || !sessions[getActiveId()] || !visibleSessionIds.includes(getActiveId())) setActiveId(visibleSessionIds[0]);

  inputArea.style.display = '';
  renderProjectControls();
  renderSessionList(); renderMessages();
}

function renderMessages() {
  messagesEl.innerHTML = '';
  const session = getActiveSession();
  const visibleMessages = (session?.messages || []).filter(shouldRenderMessage);
  if (!session || visibleMessages.length === 0) {
    messagesEl.innerHTML = `
      <div class="welcome">
        <div class="icon">&#9670;</div>
        <h2>开始 <em>${isAgentWorkspace() ? 'Agent' : '对话'}</em></h2>
        <p>${isAgentWorkspace() ? '在当前项目目录里交给 Pi Agent 处理' : '输入任意消息与大模型交流'}</p>
        <div class="tips">
          ${isAgentWorkspace()
            ? '<div class="tip" onclick="useTip(this)">阅读项目结构并给出改进建议</div><div class="tip" onclick="useTip(this)">帮我修复当前测试失败</div><div class="tip" onclick="useTip(this)">实现一个小功能并说明改动</div><div class="tip" onclick="useTip(this)">检查最近的代码风险</div>'
            : '<div class="tip" onclick="useTip(this)">解释量子计算</div><div class="tip" onclick="useTip(this)">写一首关于春天的诗</div><div class="tip" onclick="useTip(this)">用 Python 实现快速排序</div><div class="tip" onclick="useTip(this)">推荐几本科幻小说</div>'}
        </div>
      </div>`;
    return;
  }
  const sessionKind = getSessionKind(session);
  visibleMessages.forEach(m => appendBubble(m.role, m.content, false, {
    created: m.created,
    thinkingMs: m.thinkingMs,
    kind: sessionKind,
    projectId: session.projectId,
  }));
  renderInFlightMessage(sessionKind, getActiveId());
  scrollToBottom();
}

function renderInFlightMessage(scope, sessionId) {
  const flight = inFlightByScope[scope];
  if (!flight || flight.sessionId !== sessionId) return;
  const bubble = appendBubble('assistant', flight.content || flight.thinkingText, false, {
    created: flight.started,
    thinkingMs: flight.firstDeltaAt ? flight.firstDeltaAt - flight.started : undefined,
    kind: flight.kind,
    projectId: flight.projectId,
    pending: !flight.firstDeltaAt,
  });
  bubble.classList.add('streaming');
  if (!flight.content) bubble.classList.add('thinking');
  flight.bubble = bubble;
  flight.renderer = createRichStreamRenderer(bubble, {
    created: flight.started,
    kind: flight.kind,
    projectId: flight.projectId,
    pending: !flight.firstDeltaAt,
  });
  if (flight.content) flight.renderer(flight.content, true);
}

function shouldRenderMessage(message) {
  const content = (message?.content || '').trim();
  if (!content) return false;
  if (message?.role === 'tool' || message?.role === 'toolResult') return false;
  if (/^\[tool:\s*[\w.-]+\]$/i.test(content)) return false;
  if (/^\(?no output\)?$/i.test(content)) return false;
  return true;
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
    .replace(/&lt;(https?:\/\/[^&\s]+)&gt;/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function trimUrlTail(rawUrl) {
  let url = rawUrl;
  let tail = '';
  while (url) {
    const ch = url.slice(-1);
    if (/[.,;:!?]/.test(ch)) {
      tail = ch + tail;
      url = url.slice(0, -1);
      continue;
    }
    if (ch === ')' && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length) {
      tail = ch + tail;
      url = url.slice(0, -1);
      continue;
    }
    if (ch === ']' && (url.match(/\]/g) || []).length > (url.match(/\[/g) || []).length) {
      tail = ch + tail;
      url = url.slice(0, -1);
      continue;
    }
    break;
  }
  return { url, tail };
}

function normalizeUrlBoundaries(content) {
  return (content || '').replace(
    /(https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)(?=[\u3400-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF])/g,
    match => {
      const { url, tail } = trimUrlTail(match);
      return url ? `<${url}>${tail}` : match;
    }
  );
}

function normalizeMarkdown(content) {
  return normalizeUrlBoundaries(content).replace(/^(#{1,4})([^\s#])/gm, '$1 $2');
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

function normalizeProjectImagePath(value) {
  let path = (value || '').trim();
  path = path.replace(/^[*`"'“”‘’（(【\[]+|[*`"'“”‘’。.,，、；;：:！!？?）)】\]]+$/g, '');
  path = path.split(/[?#]/)[0].replace(/\\/g, '/').trim();
  if (!path || path.startsWith('/')) return '';
  if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:\//i.test(path)) return '';
  if (path.includes('\0')) return '';
  const extension = path.split('.').pop()?.toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(extension)) return '';
  return path;
}

function projectImageUrl(path, projectId) {
  return `/api/project-image?projectId=${encodeURIComponent(projectId || '')}&path=${encodeURIComponent(path)}`;
}

function extractProjectImagePaths(content) {
  const seen = new Set();
  const paths = [];
  const add = value => {
    const path = normalizeProjectImagePath(value);
    if (!path || seen.has(path)) return;
    const pathKey = path.toLowerCase();
    if (!/^[a-z]:\//i.test(path) && paths.some(existing => existing.toLowerCase().endsWith(`/${pathKey}`))) return;
    seen.add(path);
    paths.push(path);
  };

  const markdownPattern = /!?\[[^\]]*]\(([^)\s]+(?:\s+[^)]*)?)\)/g;
  for (const match of (content || '').matchAll(markdownPattern)) add(match[1]);

  const absoluteWindowsPattern = new RegExp(`[A-Za-z]:[\\\\/][^\\s<>"'“”‘’|]+?\\.(${IMAGE_EXT_PATTERN})`, 'gi');
  for (const match of (content || '').matchAll(absoluteWindowsPattern)) add(match[0]);

  const filenamePattern = new RegExp(`(?:[A-Za-z]:[\\\\/])?\\.?\\/?[^\\s*<>"'“”‘’|：:，。；;！!？?（）()【】\\[\\]]+?\\.(${IMAGE_EXT_PATTERN})`, 'gi');
  for (const match of (content || '').matchAll(filenamePattern)) add(match[0]);

  return paths;
}

function appendProjectImagePreviews(bubble, content, meta = {}) {
  if (meta.kind !== AGENT_SCOPE || !meta.projectId) return;

  const renderedPaths = new Set();
  bubble.querySelectorAll('img').forEach(img => {
    const path = normalizeProjectImagePath(img.getAttribute('src'));
    if (!path) return;
    const src = projectImageUrl(path, meta.projectId);
    img.src = src;
    img.classList.add('project-inline-image');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.dataset.projectImagePath = path;
    if (!img.closest('a')) {
      const link = document.createElement('a');
      link.href = src;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      img.parentNode.insertBefore(link, img);
      link.appendChild(img);
    }
    renderedPaths.add(path);
  });

  const paths = extractProjectImagePaths(content).filter(path => !renderedPaths.has(path));
  if (!paths.length) return;

  const gallery = document.createElement('div');
  gallery.className = 'project-image-gallery';
  paths.forEach(path => {
    const figure = document.createElement('figure');
    figure.className = 'project-image-card';

    const image = document.createElement('img');
    image.src = projectImageUrl(path, meta.projectId);
    image.alt = path;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.onerror = () => figure.classList.add('load-error');

    const link = document.createElement('a');
    link.href = image.src;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.appendChild(image);

    const caption = document.createElement('figcaption');
    caption.textContent = path;

    figure.appendChild(link);
    figure.appendChild(caption);
    gallery.appendChild(figure);
  });
  bubble.appendChild(gallery);
}

function setBubbleContent(bubble, role, content, renderRich = role !== 'user', renderMath = true, meta = {}) {
  if (role === 'user' || !renderRich) {
    bubble.textContent = content;
    return;
  }
  bubble.innerHTML = renderMarkdown(content);
  if (renderMath && window.MathJax?.typesetPromise) typesetMath(bubble);
  else applyMathFallback(bubble);
  appendProjectImagePreviews(bubble, content, meta);
}

function createRichStreamRenderer(bubble, meta = {}) {
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
          setBubbleContent(bubble, 'assistant', latestContent, true, false, meta);
          scrollToBottom();
        }, 220);
      }
      return;
    }
    lastRender = now;
    setBubbleContent(bubble, 'assistant', content, true, force, meta);
    scrollToBottom();
  };
}

function appendBubble(role, content, animate = true, meta = {}) {
  const welcome = messagesEl.querySelector('.welcome');
  if (welcome) welcome.remove();

  const div = document.createElement('div');
  div.className = `msg ${role === 'user' ? 'user' : 'bot'}`;
  if (!animate) div.style.animation = 'none';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  if (role === 'user') {
    avatar.innerHTML = '<span class="user-face" aria-hidden="true"></span>';
  } else {
    avatar.innerHTML = '<span class="bot-face" aria-hidden="true"><span></span></span>';
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  setBubbleContent(bubble, role, content, role !== 'user', true, meta);

  const contentWrap = document.createElement('div');
  contentWrap.className = 'msg-content';

  const metaEl = document.createElement('div');
  metaEl.className = 'msg-meta';
  metaEl.textContent = getMessageMetaText(role, meta);
  metaEl.classList.toggle('empty', !metaEl.textContent);

  contentWrap.appendChild(bubble);
  contentWrap.appendChild(metaEl);
  div.appendChild(avatar);
  div.appendChild(contentWrap);
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

sendBtn.addEventListener('click', () => { if (isWorkspaceStreaming()) stopStreaming(activeWorkspace); else sendMessage(); });
updateSendButtonState();

async function readOpenAIStream(cfg, messages, onDelta, signal) {
  const resp = await fetch(cfg.apiUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.modelName, messages, stream: true }),
    signal,
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

async function readCliStream(prompt, messages, context, onDelta, onSession) {
  const resp = await fetch('/api/cli/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: context.sessionId,
      projectId: context.projectId,
      piSessionPath: context.piSessionPath || '',
      mode: context.mode,
      prompt,
      messages,
    }),
    signal: context.signal,
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
      if (event.session && onSession) onSession(event.session);
    }
  }
}

async function legacySendMessage() {
  return sendMessage();
  const text = inputEl.value.trim();
  if (!text || isStreaming) return;
  const cfg = getConfig();
  if (!cfg || (isAgentWorkspace() ? !isCliConfig(cfg) : isCliConfig(cfg))) {
    document.querySelector('[data-tab=config]')?.click();
    setConfigScope(isAgentWorkspace() ? AGENT_SCOPE : CHAT_SCOPE);
    return;
  }

  let session = getActiveSession();
  if (!session) { createSession(); session = getActiveSession(); }
  session.kind = activeWorkspace;
  session.projectId = isAgentWorkspace() ? (session.projectId || getActiveProjectId()) : null;
  session.mode = isAgentWorkspace() ? 'task' : 'chat';
  session.status = isAgentWorkspace() ? 'running' : 'idle';
  const requestSessionId = getActiveId();
  const responseKind = session.kind;
  const responseProjectId = session.projectId;

  const userCreated = Date.now();
  session.messages.push({ role: 'user', content: text, created: userCreated });

  if (session.messages.filter(m => m.role === 'user').length === 1) {
    const title = text.length > 30 ? text.slice(0, 30) + '...' : text;
    updateActiveSession({ title, kind: session.kind, projectId: session.projectId, mode: session.mode, status: session.status, messages: session.messages, created: session.created });
    renderSessionList();
  } else {
    updateActiveSession({ kind: session.kind, projectId: session.projectId, mode: session.mode, status: session.status, messages: session.messages });
  }

  appendBubble('user', text, true, { created: userCreated, kind: responseKind, projectId: responseProjectId });
  inputEl.value = ''; inputEl.style.height = 'auto'; inputEl.focus();

  isStreaming = true;
  sendBtn.innerHTML = sendButtonIcon('stop') + '<span>停止</span>';
  sendBtn.classList.add('stop'); sendBtn.title = '停止';

  const thinkingText = isAgentWorkspace() ? 'Agent 正在执行任务' : '模型正在思考';
  const responseStarted = Date.now();
  let firstDeltaAt = null;
  const responseMeta = { created: responseStarted, kind: responseKind, projectId: responseProjectId, pending: true };
  const botBubble = appendBubble('assistant', thinkingText, true, responseMeta);
  botBubble.classList.add('streaming', 'thinking');
  const renderBotStream = createRichStreamRenderer(botBubble, responseMeta);
  let fullContent = '';

  try {
    abortController = new AbortController();
    const messages = session.messages
      .filter(shouldRenderMessage)
      .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
    const onDelta = delta => {
      if (!fullContent) {
        firstDeltaAt = Date.now();
        botBubble.classList.remove('thinking');
        setBubbleMeta(botBubble, 'assistant', { created: responseStarted, thinkingMs: firstDeltaAt - responseStarted, kind: responseKind, projectId: responseProjectId });
      }
      fullContent += delta;
      renderBotStream(fullContent);
    };
    const onPiSession = piSession => {
      const sessions = getSessions();
      const target = requestSessionId && sessions[requestSessionId];
      if (!target) return;
      target.piSessionPath = piSession.path || target.piSessionPath || '';
      target.piSessionId = piSession.id || target.piSessionId || '';
      target.source = 'pi';
      saveSessions(sessions);
    };
    if (isAgentWorkspace()) await readCliStream(text, messages, onDelta, onPiSession);
    else await readOpenAIStream(cfg, messages, onDelta);
  } catch (err) {
    if (err.name === 'AbortError') { fullContent += '\n\n[已停止]'; }
    else {
      botBubble.classList.remove('streaming', 'thinking');
      botBubble.closest('.msg')?.classList.add('error');
      botBubble.textContent = `请求失败: ${err.message}`;
    }
  }

  botBubble.classList.remove('streaming', 'thinking');
  if (fullContent) {
    const assistantCreated = firstDeltaAt || Date.now();
    const thinkingMs = Math.max(0, assistantCreated - responseStarted);
    renderBotStream(fullContent, true);
    setBubbleMeta(botBubble, 'assistant', { created: assistantCreated, thinkingMs, kind: responseKind, projectId: responseProjectId });
    session = getActiveSession();
    if (session) { session.messages.push({ role: 'assistant', content: fullContent, created: assistantCreated, thinkingMs }); updateActiveSession({ messages: session.messages, status: 'idle' }); }
  } else if (!botBubble.textContent.trim() || botBubble.textContent.trim() === thinkingText) {
    botBubble.textContent = '已完成，但没有返回内容。';
    setBubbleMeta(botBubble, 'assistant', { created: Date.now(), thinkingMs: Date.now() - responseStarted, kind: responseKind, projectId: responseProjectId });
  }

  isStreaming = false;
  abortController = null;
  updateActiveSession({ status: 'idle' });
  sendBtn.innerHTML = sendButtonIcon('send') + '<span>发送</span>';
  sendBtn.classList.remove('stop'); sendBtn.title = '发送';
}

function legacyStopStreaming() { return stopStreaming(); }

async function sendMessage() {
  const text = inputEl.value.trim();
  const requestWorkspace = activeWorkspace;
  const requestIsAgent = requestWorkspace === AGENT_SCOPE;
  if (!text || isWorkspaceStreaming(requestWorkspace)) return;

  const cfg = getConfig(requestWorkspace);
  if (!cfg || (requestIsAgent ? !isCliConfig(cfg) : isCliConfig(cfg))) {
    document.querySelector('[data-tab=config]')?.click();
    setConfigScope(requestWorkspace);
    return;
  }

  let session = getActiveSession();
  if (!session) {
    createSession();
    session = getActiveSession();
  }
  if (!session) return;

  session.kind = requestWorkspace;
  session.projectId = requestIsAgent ? (session.projectId || getActiveProjectId()) : null;
  session.mode = requestIsAgent ? 'task' : 'chat';
  session.status = requestIsAgent ? 'running' : 'idle';

  const requestSessionId = getActiveId();
  const requestProjectId = session.projectId;
  const requestRunMode = requestIsAgent ? 'task' : activeRunMode;
  const requestPiSessionPath = session.piSessionPath || '';
  const responseKind = requestWorkspace;
  const responseProjectId = session.projectId;

  const userCreated = Date.now();
  session.messages.push({ role: 'user', content: text, created: userCreated });
  const patch = {
    kind: session.kind,
    projectId: session.projectId,
    mode: session.mode,
    status: session.status,
    messages: session.messages,
  };
  if (session.messages.filter(m => m.role === 'user').length === 1) {
    patch.title = text.length > 30 ? text.slice(0, 30) + '...' : text;
    patch.created = session.created;
  }
  updateSessionById(requestSessionId, patch);
  renderSessionList();

  appendBubble('user', text, true, { created: userCreated, kind: responseKind, projectId: responseProjectId });
  inputEl.value = '';
  inputEl.style.height = 'auto';
  inputEl.focus();

  const controller = new AbortController();
  setWorkspaceStreaming(requestWorkspace, true, controller);

  const thinkingText = requestIsAgent ? 'Agent 正在执行任务' : '模型正在思考';
  const responseStarted = Date.now();
  let firstDeltaAt = null;
  let fullContent = '';
  const responseMeta = { created: responseStarted, kind: responseKind, projectId: responseProjectId, pending: true };
  const botBubble = appendBubble('assistant', thinkingText, true, responseMeta);
  botBubble.classList.add('streaming', 'thinking');
  const renderBotStream = createRichStreamRenderer(botBubble, responseMeta);

  inFlightByScope[requestWorkspace] = {
    sessionId: requestSessionId,
    content: '',
    started: responseStarted,
    firstDeltaAt: null,
    thinkingText,
    kind: responseKind,
    projectId: responseProjectId,
    bubble: botBubble,
    renderer: renderBotStream,
  };

  try {
    const messages = session.messages
      .filter(shouldRenderMessage)
      .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));

    const onDelta = delta => {
      const flight = inFlightByScope[requestWorkspace];
      if (!fullContent) {
        firstDeltaAt = Date.now();
        if (flight) flight.firstDeltaAt = firstDeltaAt;
        if (flight?.bubble?.isConnected) {
          flight.bubble.classList.remove('thinking');
          setBubbleMeta(flight.bubble, 'assistant', {
            created: responseStarted,
            thinkingMs: firstDeltaAt - responseStarted,
            kind: responseKind,
            projectId: responseProjectId,
          });
        }
      }
      fullContent += delta;
      if (flight) flight.content = fullContent;
      if (flight?.renderer && flight?.bubble?.isConnected) flight.renderer(fullContent);
    };

    const onPiSession = piSession => {
      const sessions = getSessions();
      const target = requestSessionId && sessions[requestSessionId];
      if (!target) return;
      target.piSessionPath = piSession.path || target.piSessionPath || '';
      target.piSessionId = piSession.id || target.piSessionId || '';
      target.source = 'pi';
      saveSessions(sessions);
    };

    if (requestIsAgent) {
      await readCliStream(
        text,
        messages,
        {
          sessionId: requestSessionId,
          projectId: requestProjectId,
          piSessionPath: requestPiSessionPath,
          mode: requestRunMode,
          signal: controller.signal,
        },
        onDelta,
        onPiSession
      );
    } else {
      await readOpenAIStream(cfg, messages, onDelta, controller.signal);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      fullContent += '\n\n[已停止]';
    } else {
      const flight = inFlightByScope[requestWorkspace];
      if (flight?.bubble?.isConnected) {
        flight.bubble.classList.remove('streaming', 'thinking');
        flight.bubble.closest('.msg')?.classList.add('error');
        flight.bubble.textContent = `请求失败: ${err.message}`;
      }
    }
  }

  const flight = inFlightByScope[requestWorkspace];
  if (flight?.bubble?.isConnected) flight.bubble.classList.remove('streaming', 'thinking');

  if (fullContent) {
    const assistantCreated = firstDeltaAt || Date.now();
    const thinkingMs = Math.max(0, assistantCreated - responseStarted);
    if (flight?.renderer && flight?.bubble?.isConnected) {
      flight.renderer(fullContent, true);
      setBubbleMeta(flight.bubble, 'assistant', {
        created: assistantCreated,
        thinkingMs,
        kind: responseKind,
        projectId: responseProjectId,
      });
    }

    session = getSessionById(requestSessionId);
    if (session) {
      session.messages.push({ role: 'assistant', content: fullContent, created: assistantCreated, thinkingMs });
      updateSessionById(requestSessionId, { messages: session.messages, status: 'idle' });
    }
  } else if (flight?.bubble?.isConnected && (!flight.bubble.textContent.trim() || flight.bubble.textContent.trim() === thinkingText)) {
    flight.bubble.textContent = '已完成，但没有返回内容。';
    setBubbleMeta(flight.bubble, 'assistant', {
      created: Date.now(),
      thinkingMs: Date.now() - responseStarted,
      kind: responseKind,
      projectId: responseProjectId,
    });
  }

  inFlightByScope[requestWorkspace] = null;
  setWorkspaceStreaming(requestWorkspace, false);
  updateSessionById(requestSessionId, { status: 'idle' });
  if (activeWorkspace === requestWorkspace && getActiveId() === requestSessionId) renderMessages();
  else markWorkspaceUnread(requestWorkspace);
}

function stopStreaming(scope = activeWorkspace) {
  const controller = abortControllersByScope[scope];
  if (controller) controller.abort();
}

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
  renderPresets();
  setConfigScope(CHAT_SCOPE);
  updateModelBadge(); renderProjectControls(); renderProjects(); await refreshChat();
}

initApp();
