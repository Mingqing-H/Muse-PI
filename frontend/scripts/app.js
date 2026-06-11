const PRESETS = [
  { name: 'MiMo',     url: 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions', models: ['mimo-v2.5-pro', 'mimo-v2.5'] },
  { name: 'OpenAI',   url: 'https://api.openai.com/v1/chat/completions', models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'] },
  { name: 'DeepSeek', url: 'https://api.deepseek.com/v1/chat/completions', models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'] },
  { name: 'Qwen',     url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', models: ['qwen3.7-max', 'qwen3.6-plus', 'qwen3.6-flash', 'qwen-plus'] },
  { name: 'GLM',      url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', models: ['glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7-flash'] },
  { name: 'Kimi',     url: 'https://api.moonshot.cn/v1/chat/completions', models: ['kimi-latest', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  { name: 'SiliconFlow', url: 'https://api.siliconflow.cn/v1/chat/completions', models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct', 'Pro/deepseek-ai/DeepSeek-V3'] },
  { name: 'Pi CLI',   url: '', models: ['default'], kind: 'cli' },
];
const PI_MODEL_OPTIONS = PRESETS.find(p => p.name === 'Pi CLI')?.models || ['default'];
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
let piModelOptionsCache = null;
let piModelOptionsError = '';
let agentModelSearchValue = '';
let enabledModelDraft = [];
let skillOptionsCache = null;
let skillOptionsProjectId = null;
const fileOptionsCache = {};
const referencePickerState = {
  open: false,
  type: '',
  query: '',
  tokenStart: 0,
  tokenEnd: 0,
  activeIndex: 0,
  items: [],
};
const syncedPiProjects = new Set();
const streamingByScope = { [CHAT_SCOPE]: false, [AGENT_SCOPE]: false };
const inFlightByScope = { [CHAT_SCOPE]: {}, [AGENT_SCOPE]: {} };
const unreadScopes = new Set();

async function apiRequest(path, options = {}) {
  const resp = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

function extractErrorMessage(error) {
  const raw = error?.message || String(error || '');
  if (!raw) return '';
  try {
    const data = JSON.parse(raw);
    return data.error || raw;
  } catch {
    return raw;
  }
}

let toastTimer = null;
function showToast(message, color = 'var(--accent)') {
  const toast = $('toast');
  if (!toast) return;
  if (toastTimer) clearTimeout(toastTimer);
  toast.textContent = message || '';
  toast.style.color = color;
  toast.style.borderColor = color;
  toast.classList.add('show');
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    toastTimer = null;
  }, 2600);
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
  const localActiveId = localStorage.getItem(ACTIVE_KEY) || null;

  if (!localConfig && Object.keys(localProjects).length === 0 && Object.keys(localSessions).length === 0 && !localActiveId) return;

  configCache = localConfig;
  projectsCache = {};
  activeProjectIdCache = null;
  ensureDefaultProject();
  sessionsCache = localSessions;
  activeIdCache = localActiveId;
  if (configCache) await apiRequest('/api/config', { method: 'POST', body: JSON.stringify({ config: configCache }) });
  if (Object.keys(sessionsCache).length > 0) await apiRequest('/api/sessions', { method: 'POST', body: JSON.stringify({ sessions: sessionsCache }) });
  if (activeIdCache) await apiRequest('/api/active-session', { method: 'POST', body: JSON.stringify({ activeId: activeIdCache }) });
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(PROJECTS_KEY);
  localStorage.removeItem(ACTIVE_PROJECT_KEY);
  localStorage.removeItem(SESSIONS_KEY);
  localStorage.removeItem(ACTIVE_KEY);
}

function persistConfig() {
  if (USE_DATABASE) return apiRequest('/api/config', { method: 'POST', body: JSON.stringify({ config: configCache }) });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(configCache));
  return Promise.resolve({ ok: true });
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
  if (USE_DATABASE) {
    if (!activeProjectIdCache || !isProjectAvailable(projectsCache[activeProjectIdCache])) {
      activeProjectIdCache = Object.entries(projectsCache)
        .find(([, project]) => isProjectAvailable(project))?.[0] || null;
    }
    return;
  }
  if (Object.keys(projectsCache).length === 0) {
    const p = defaultProject();
    projectsCache[p.id] = p;
    activeProjectIdCache = p.id;
  }
  if (!activeProjectIdCache || !projectsCache[activeProjectIdCache]) {
    activeProjectIdCache = Object.keys(projectsCache)[0] || null;
  }
}

function persistProjects({ throwOnError = false } = {}) {
  if (USE_DATABASE) {
    return Promise.resolve({ ok: true });
  }
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projectsCache));
  return Promise.resolve({ ok: true });
}

function persistActiveProject({ throwOnError = false } = {}) {
  if (USE_DATABASE) {
    const request = apiRequest('/api/active-project', { method: 'POST', body: JSON.stringify({ activeProjectId: activeProjectIdCache }) });
    if (!throwOnError) request.catch(console.error);
    return request;
  }
  localStorage.setItem(ACTIVE_PROJECT_KEY, activeProjectIdCache || '');
  return Promise.resolve({ ok: true });
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
  return Object.keys(inFlightByScope[scope] || {}).length > 0;
}

function getSessionFlight(scope = activeWorkspace, id = getActiveId()) {
  return id ? inFlightByScope[scope]?.[id] || null : null;
}

function isActiveSessionStreaming(scope = activeWorkspace) {
  return !!getSessionFlight(scope, getActiveId());
}

function isSessionRunning(id) {
  const session = getSessionById(id);
  return !!session && (
    session.status === 'running'
    || Object.values(inFlightByScope).some(flights => !!flights?.[id])
  );
}

function setWorkspaceStreaming(scope) {
  streamingByScope[scope] = isWorkspaceStreaming(scope);
  updateSendButtonState();
  updateAgentModelPicker();
  renderSessionList();
}

function updateSendButtonState() {
  if (!sendBtn) return;
  const activeStreaming = isActiveSessionStreaming(activeWorkspace);
  sendBtn.disabled = false;
  sendBtn.classList.remove('background-busy');
  if (activeStreaming) {
    sendBtn.innerHTML = sendButtonIcon('stop') + '<span>停止</span>';
    sendBtn.classList.add('stop');
    sendBtn.title = '停止当前会话';
  } else {
    sendBtn.innerHTML = sendButtonIcon('send') + '<span>发送</span>';
    sendBtn.classList.remove('stop');
    sendBtn.title = '发送';
  }
  return;
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
    if (tab === 'projects') {
      await syncPiProjectFolders(true);
      renderProjects();
    }
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
  const store = toConfigStore(configCache);
  presetIndicesForScope().forEach(i => {
    const p = PRESETS[i];
    const btn = document.createElement('button');
    const saved = store.providers[p.name];
    const hasConfig = !!saved;
    btn.className = 'preset-btn'
      + (hasConfig ? ' configured' : '')
      + (i === activePresetIndex ? ' active' : '');
    btn.dataset.index = String(i);
    const savedModels = getEnabledModelsForConfig(saved, p);
    btn.title = hasConfig && savedModels.length ? `${p.name} 已配置：${savedModels.join(', ')}` : p.name;
    btn.innerHTML = `<span class="preset-name">${escapeHtml(p.name)}</span>${hasConfig ? '<span class="preset-status">已配置</span>' : ''}`;
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
  enabledModelDraft = getEnabledModelsForConfig(saved, p);
  $('modelName').value = getActiveModelForConfig(saved, enabledModelDraft);
  renderModelOptions(i);
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
  if ($('modelNameLabel')) $('modelNameLabel').style.display = isCli ? 'none' : '';
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
  if (!dl) return;
  dl.innerHTML = '';
  if (activeIndex < 0) return;
  PRESETS[activeIndex].models.forEach(m => {
    const o = document.createElement('option');
    o.value = m;
    dl.appendChild(o);
  });
}

function uniqueModels(models) {
  return Array.from(new Set((models || []).map(model => String(model || '').trim()).filter(Boolean)));
}

function getEnabledModelsForConfig(config, preset = PRESETS[activePresetIndex]) {
  const configured = uniqueModels(config?.enabledModels);
  if (configured.length) return configured;
  const current = (config?.modelName || '').trim();
  if (current) return [current];
  return preset?.kind === 'cli' ? [preset?.models?.[0] || 'default'] : [];
}

function getActiveModelForConfig(config, enabledModels = []) {
  const configured = (config?.modelName || '').trim();
  if (configured && (!enabledModels.length || enabledModels.includes(configured))) return configured;
  return enabledModels[0] || '';
}

function syncModelDraftValue() {
  const current = $('modelName')?.value.trim() || '';
  if (current && enabledModelDraft.includes(current)) return;
  $('modelName').value = enabledModelDraft[0] || '';
}

function renderModelOptions(activeIndex = activePresetIndex) {
  const wrap = $('modelOptions');
  if (!wrap) return;
  wrap.innerHTML = '';
  const preset = PRESETS[activeIndex];
  if (!preset?.models?.length) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.toggle('hidden', preset.kind === 'cli');
  if (preset.kind === 'cli') return;

  enabledModelDraft = uniqueModels(enabledModelDraft).filter(model => preset.models.includes(model));
  syncModelDraftValue();
  preset.models.forEach(model => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'model-option-btn';
    btn.classList.toggle('active', enabledModelDraft.includes(model));
    btn.textContent = model;
    btn.title = enabledModelDraft.includes(model) ? '已启用，点击停用' : '点击启用';
    btn.onclick = async () => {
      if (enabledModelDraft.includes(model)) {
        if (enabledModelDraft.length <= 1) {
          showToast('至少保留一个启用模型', 'var(--rose)');
          return;
        }
        enabledModelDraft = enabledModelDraft.filter(item => item !== model);
      } else {
        enabledModelDraft = [...enabledModelDraft, model];
      }
      syncModelDraftValue();
      renderModelOptions(activeIndex);
      if (activeConfigScope === CHAT_SCOPE) {
        const saved = await saveConfig({ silent: true });
        if (saved) showToast('启用模型已保存', 'var(--accent)');
      }
    };
    wrap.appendChild(btn);
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
    enabledModelDraft = getEnabledModelsForConfig(c, preset);
    $('modelName').value = getActiveModelForConfig(c, enabledModelDraft);
  } else {
    $('apiUrl').value = '';
    $('apiKey').value = '';
    enabledModelDraft = [];
    $('modelName').value = '';
  }

  syncPresetSelection(presetIndex);
  updateModelDatalist(presetIndex);
  renderModelOptions(presetIndex);
  syncProviderFields(presetIndex);
  return c;
}

function getConfig(scope = activeWorkspace) { return getScopedConfig(scope); }

async function saveConfig(options = {}) {
  const silent = options?.silent === true;
  syncModelDraftValue();
  const c = {
    apiUrl: $('apiUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    modelName: $('modelName').value.trim(),
    enabledModels: uniqueModels(enabledModelDraft),
  };
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
    c.enabledModels = [c.modelName];
  } else if (!c.apiUrl || !c.apiKey || !c.enabledModels.length) {
    showToast('请填写所有字段', 'var(--rose)');
    return false;
  }
  if (!isCli && !c.modelName) c.modelName = c.enabledModels[0];
  const store = toConfigStore(configCache);
  if (activeConfigScope === AGENT_SCOPE) store.activeAgentProvider = provider;
  else store.activeChatProvider = provider;
  store.providers[provider] = { ...c, provider };
  configCache = store;
  try {
    await persistConfig();
  } catch (err) {
    console.error(err);
    showToast('配置保存失败', 'var(--rose)');
    return false;
  }
  activePresetIndex = presetIndex;
  syncPresetSelection(presetIndex);
  updateModelDatalist(presetIndex);
  updatePiCliPathStatus();
  refreshPiCliInfo();
  updateModelBadge(); updateAgentModelPicker(); renderPresets(); renderModelOptions(presetIndex);
  if (!silent) showToast('配置已保存', 'var(--accent)');
  return true;
}

$('saveBtn').onclick = () => saveConfig();
$('clearBtn').onclick = () => {
  const store = toConfigStore(configCache);
  const provider = providerNameForIndex(activePresetIndex);
  delete store.providers[provider];
  if (activeConfigScope === AGENT_SCOPE) store.activeAgentProvider = null;
  else store.activeChatProvider = null;
  configCache = Object.keys(store.providers).length ? store : null;
  if (configCache) persistConfig();
  else clearPersistedConfig();
  enabledModelDraft = [];
  $('apiUrl').value = ''; $('apiKey').value = ''; $('modelName').value = '';
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  renderModelOptions(activePresetIndex);
  updateModelBadge(); updateAgentModelPicker(); renderPresets(); showToast('配置已清除', 'var(--muted)');
};
$('toggleKey').onclick = () => { const i = $('apiKey'); i.type = i.type === 'password' ? 'text' : 'password'; };
$('apiUrl').addEventListener('input', updatePiCliPathStatus);
$('modelName').addEventListener('input', () => renderModelOptions(activePresetIndex));

function updateModelBadge() {
  const c = getConfig(), b = $('modelBadge');
  if (c && c.modelName) {
    const label = isCliConfig(c) ? 'Pi CLI' : c.modelName;
    b.textContent = label;
    b.title = `当前模型：${label}`;
    b.classList.remove('empty');
  }
  else {
    b.textContent = '未配置';
    b.title = '模型未配置';
    b.classList.add('empty');
  }
}

function getAgentModelName() {
  const cfg = getConfig(AGENT_SCOPE);
  return (cfg?.modelName || 'default').trim() || 'default';
}

function getAgentModelOptions() {
  const current = getAgentModelName();
  const discovered = (piModelOptionsCache || []).map(model => model.value || model.id || model).filter(Boolean);
  const fallback = discovered.length ? [] : PI_MODEL_OPTIONS;
  return Array.from(new Set([current, ...discovered, ...fallback])).filter(Boolean);
}

async function refreshPiModelOptions() {
  if (!USE_DATABASE) return;
  try {
    const data = await apiRequest('/api/pi-models');
    piModelOptionsCache = Array.isArray(data.models) ? data.models : [];
    piModelOptionsError = data.error || (!piModelOptionsCache.length && data.raw ? data.raw.trim() : '');
  } catch (err) {
    console.error(err);
    piModelOptionsError = err.message || '模型列表读取失败';
  }
}

function setAgentModelName(modelName) {
  const model = (modelName || '').trim() || 'default';
  const store = toConfigStore(configCache);
  let provider = store.activeAgentProvider || 'Pi CLI';
  if (!isCliProviderName(provider)) provider = 'Pi CLI';
  const existing = store.providers[provider] || {
    provider,
    apiUrl: '',
    apiKey: '',
    modelName: 'default',
  };
  store.activeAgentProvider = provider;
  store.providers[provider] = { ...existing, provider, apiKey: '', modelName: model };
  configCache = store;
  persistConfig();
  updateModelBadge();
  updateAgentModelPicker();
  showToast(`Agent 模型已切换为 ${model}`, 'var(--accent)');
}

function getChatModelOptions() {
  const store = toConfigStore(configCache);
  return Object.entries(store.providers || {})
    .filter(([provider]) => !isCliProviderName(provider))
    .flatMap(([provider, cfg]) => {
      const preset = PRESETS[getPresetIndexForProviderName(provider)] || PRESETS[getPresetIndexForConfig(cfg)];
      return getEnabledModelsForConfig(cfg, preset).map(model => ({
        provider,
        model,
        label: `${provider} · ${model}`,
      }));
    });
}

function setChatModelName(providerName, modelName) {
  const model = (modelName || '').trim();
  const provider = (providerName || '').trim();
  if (!provider || !model) return;
  const store = toConfigStore(configCache);
  if (!provider || !store.providers[provider]) return;
  const preset = PRESETS[getPresetIndexForProviderName(provider)];
  const enabledModels = getEnabledModelsForConfig(store.providers[provider], preset);
  if (!enabledModels.includes(model)) return;
  store.activeChatProvider = provider;
  store.providers[provider] = { ...store.providers[provider], modelName: model, enabledModels };
  configCache = store;
  persistConfig();
  updateModelBadge();
  updateAgentModelPicker();
  showToast(`对话模型已切换为 ${provider} · ${model}`, 'var(--accent)');
}

function renderChatModelMenu() {
  const menu = $('agentModelMenu');
  if (!menu) return;
  const current = getConfig(CHAT_SCOPE);
  const currentProvider = current?.provider || toConfigStore(configCache).activeChatProvider || '';
  const currentModel = current?.modelName || '';
  const options = getChatModelOptions();
  menu.innerHTML = '';

  const list = document.createElement('div');
  list.className = 'agent-model-list';
  menu.appendChild(list);

  options.forEach(option => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'agent-model-option';
    btn.classList.toggle('active', option.provider === currentProvider && option.model === currentModel);
    btn.innerHTML = `<span class="chat-model-provider">${escapeHtml(option.provider)}</span><span class="chat-model-name">${escapeHtml(option.model)}</span>`;
    btn.title = option.label;
    btn.onpointerdown = event => {
      event.preventDefault();
      closeAgentModelMenu();
      setChatModelName(option.provider, option.model);
    };
    list.appendChild(btn);
  });

  if (!options.length) {
    const empty = document.createElement('div');
    empty.className = 'agent-model-empty';
    empty.textContent = '请先在配置里启用可用于对话的模型。';
    list.appendChild(empty);
  }
}

function renderAgentModelMenu() {
  if (!isAgentWorkspace()) {
    renderChatModelMenu();
    return;
  }
  const menu = $('agentModelMenu');
  if (!menu) return;
  const current = getAgentModelName();
  const query = agentModelSearchValue.trim().toLowerCase();
  const allOptions = getAgentModelOptions();
  const visibleOptions = query
    ? allOptions.filter(model => model.toLowerCase().includes(query))
    : allOptions;
  menu.innerHTML = '';

  const search = document.createElement('input');
  search.id = 'agentModelSearchInput';
  search.className = 'agent-model-search';
  search.type = 'text';
  search.spellcheck = false;
  search.placeholder = '搜索模型，或输入自定义模型后按 Enter';
  search.value = agentModelSearchValue;
  search.oninput = () => {
    agentModelSearchValue = search.value;
    renderAgentModelMenu();
  };
  search.onkeydown = event => {
    if (event.key === 'Enter') {
      const value = search.value.trim();
      if (!value) return;
      event.preventDefault();
      closeAgentModelMenu();
      setAgentModelName(value);
    }
  };
  menu.appendChild(search);

  const list = document.createElement('div');
  list.className = 'agent-model-list';
  menu.appendChild(list);

  visibleOptions.forEach(model => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'agent-model-option';
    btn.classList.toggle('active', model === current);
    btn.textContent = model;
    btn.onpointerdown = event => {
      event.preventDefault();
      closeAgentModelMenu();
      setAgentModelName(model);
    };
    list.appendChild(btn);
  });

  if (!visibleOptions.length) {
    const empty = document.createElement('div');
    empty.className = 'agent-model-empty';
    empty.textContent = agentModelSearchValue.trim()
      ? '没有匹配项，按 Enter 可使用当前输入作为自定义模型。'
      : '没有可展示的模型。';
    list.appendChild(empty);
  }

  if (piModelOptionsError && !(piModelOptionsCache || []).length) {
    const note = document.createElement('div');
    note.className = 'agent-model-note';
    note.textContent = '没有读到 Pi 模型列表，可在搜索框输入终端 /model 里看到的模型 ID，然后按 Enter。';
    menu.appendChild(note);
  }

  requestAnimationFrame(() => {
    const input = $('agentModelSearchInput');
    if (!input || document.activeElement === input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

function closeAgentModelMenu() {
  $('agentModelPicker')?.classList.remove('open');
}

function toggleAgentModelMenu() {
  const picker = $('agentModelPicker');
  if (!picker || picker.classList.contains('hidden')) return;
  const opening = !picker.classList.contains('open');
  document.querySelectorAll('.agent-model-picker.open').forEach(el => el.classList.remove('open'));
  if (opening) {
    agentModelSearchValue = '';
    renderAgentModelMenu();
    picker.classList.add('open');
    if (isAgentWorkspace() && USE_DATABASE) {
      const menu = $('agentModelMenu');
      if (menu) menu.insertAdjacentHTML('afterbegin', '<div class="agent-model-loading">正在读取 Pi 模型...</div>');
      refreshPiModelOptions().then(() => {
        if (picker.classList.contains('open')) renderAgentModelMenu();
      });
    }
  }
}

function updateAgentModelPicker() {
  const picker = $('agentModelPicker');
  const label = $('agentModelLabel');
  const trigger = $('agentModelTrigger');
  if (!picker || !label || !trigger) return;
  const visible = activeWorkspace === CHAT_SCOPE || isAgentWorkspace();
  picker.classList.toggle('hidden', !visible);
  picker.classList.toggle('readonly', false);
  if (!visible) closeAgentModelMenu();
  const chatModel = getConfig(CHAT_SCOPE)?.modelName || '未配置';
  const model = isAgentWorkspace() ? getAgentModelName() : chatModel;
  label.textContent = model;
  trigger.disabled = isActiveSessionStreaming(activeWorkspace);
  trigger.title = isAgentWorkspace() ? `Pi Agent 模型：${model}` : `选择对话模型：${model}`;
  if (picker.classList.contains('open')) renderAgentModelMenu();
}

// Projects
function isProjectAvailable(project) {
  return !!project && project.available !== false;
}

function projectUnavailableReason(project) {
  return project?.unavailableReason || '项目文件夹不存在';
}

function getProjects() { ensureDefaultProject(); return projectsCache; }
function getActiveProjectId() { ensureDefaultProject(); return activeProjectIdCache; }
function getActiveProject() { const projects = getProjects(); return projects[getActiveProjectId()] || null; }

function normalizeProjectFolderPath(path) {
  const value = (path || '').trim().replace(/^["']+|["']+$/g, '');
  if (!value) return '';
  const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (/^[a-z]:\/?$/i.test(normalized)) return normalized.slice(0, 2).toLowerCase() + '/';
  return normalized.replace(/\/+$/, '').toLowerCase();
}

function isAbsoluteLocalProjectPath(path) {
  const value = (path || '').trim().replace(/^["']+|["']+$/g, '');
  if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  if (/^[a-z]:[\\/]/i.test(value)) return true;
  return /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

function projectPathValidationMessage(path) {
  if (!(path || '').trim()) return '请填写本地文件夹路径';
  if (!isAbsoluteLocalProjectPath(path)) {
    return '项目路径必须是绝对路径，例如 C:\\Users\\you\\project，不能只填 123 或 .\\project。';
  }
  return '';
}

function projectPathKey(path) {
  return normalizeProjectFolderPath(path);
}

function findProjectPathConflict(path, ignoredProjectId = null) {
  const key = projectPathKey(path);
  if (!key) return null;
  return Object.values(getProjects()).find(project =>
    project.id !== ignoredProjectId && projectPathKey(project.path) === key
  ) || null;
}

function projectPathConflictMessage(conflict) {
  return `对话项目已存在：${conflict?.name || '未命名项目'}`;
}

function showProjectPathConflict(conflict) {
  showToast(projectPathConflictMessage(conflict), 'var(--rose)');
}

function projectCreateToastMessage(result) {
  return result?.message || '对话项目已创建';
}

async function createPiProject(path) {
  return apiRequest('/api/pi-project', {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
}

async function syncPiProjectFolders(force = false) {
  if (!USE_DATABASE) return false;
  try {
    const data = await apiRequest('/api/pi-projects');
    const piProjects = data.projects || {};
    const previousProjects = projectsCache || {};
    const previousActiveProjectId = activeProjectIdCache;
    projectsCache = piProjects;
    ensureDefaultProject();
    Array.from(syncedPiProjects).forEach(id => {
      if (!projectsCache[id]) syncedPiProjects.delete(id);
    });
    if (previousActiveProjectId !== activeProjectIdCache) {
      persistActiveProject();
    }
    return force || JSON.stringify(previousProjects) !== JSON.stringify(projectsCache);
  } catch (err) {
    console.error(err);
    showToast('Pi Agent 项目同步失败', 'var(--rose)');
    return false;
  }
}

async function setActiveProject(id) {
  const project = projectsCache[id];
  if (!project) return;
  if (!isProjectAvailable(project)) {
    showToast(projectUnavailableReason(project), 'var(--rose)');
    renderProjects();
    return;
  }
  activeProjectIdCache = id;
  skillOptionsCache = null;
  skillOptionsProjectId = null;
  delete fileOptionsCache[referenceCacheKey(id)];
  closeReferencePicker();
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

async function saveProjectForm(values) {
  const path = (values.path || '').trim();
  const validationMessage = projectPathValidationMessage(path);
  if (validationMessage) {
    showToast(validationMessage, 'var(--rose)');
    return null;
  }
  const conflict = findProjectPathConflict(path);
  if (conflict) {
    showProjectPathConflict(conflict);
    return null;
  }
  const result = await createPiProject(path);
  if (result.project?.id) activeProjectIdCache = result.project.id;
  await syncPiProjectFolders(true);
  if (result.project?.id && projectsCache[result.project.id]) activeProjectIdCache = result.project.id;
  await persistActiveProject({ throwOnError: true });
  syncedPiProjects.delete(activeProjectIdCache);
  renderProjectControls();
  renderProjects();
  if (isAgentWorkspace()) refreshChat();
  showToast(projectCreateToastMessage(result), 'var(--accent)');
  return result.project?.id || activeProjectIdCache;
}

function openProjectForm() {
  const formUid = `project-${Date.now().toString(36)}`;
  const pathInputId = `${formUid}-path`;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <form class="project-form">
      <div class="project-form-head">
        <h3>新建项目</h3>
        <button type="button" class="modal-x" aria-label="关闭">&times;</button>
      </div>
      <div class="project-form-field">
        <label for="${pathInputId}">本地文件夹路径</label>
        <div class="path-input-row">
          <input id="${pathInputId}" name="path" type="text" value="" placeholder="C:\\Users\\you\\project" spellcheck="false">
        </div>
        <div class="project-form-error" data-role="project-path-error" aria-live="polite"></div>
      </div>
      <p>Agent 会在项目文件夹里执行 Pi CLI，会话记录会保存在 Pi 的 sessions 目录。</p>
      <div class="project-form-actions">
        <button type="button" class="btn btn-secondary form-cancel">取消</button>
        <button type="submit" class="btn btn-primary">创建</button>
      </div>
    </form>
  `;
  const close = () => overlay.remove();
  document.body.appendChild(overlay);
  const form = overlay.querySelector('form');
  const pathInput = form.querySelector('input[name="path"]');
  const pathError = form.querySelector('[data-role="project-path-error"]');
  const submitButton = form.querySelector('button[type="submit"]');
  if (!pathInput) {
    showToast('项目表单初始化失败', 'var(--rose)');
    overlay.remove();
    return;
  }
  const setPathError = message => {
    if (!pathError) return;
    pathError.textContent = message || '';
    pathError.classList.toggle('show', Boolean(message));
  };
  pathInput.addEventListener('input', () => setPathError(''));
  overlay.querySelector('.modal-x').onclick = close;
  overlay.querySelector('.form-cancel').onclick = close;
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  form.onsubmit = async event => {
    event.preventDefault();
    setPathError('');
    const path = pathInput.value.trim();
    const validationMessage = projectPathValidationMessage(path);
    if (validationMessage) {
      setPathError(validationMessage);
      showToast(validationMessage, 'var(--rose)');
      pathInput.focus();
      return;
    }
    const conflict = findProjectPathConflict(path);
    if (conflict) {
      const message = projectPathConflictMessage(conflict);
      setPathError(message);
      showToast(message, 'var(--rose)');
      pathInput.focus();
      pathInput.select();
      return;
    }
    if (submitButton) submitButton.disabled = true;
    try {
      const savedId = await saveProjectForm({ path });
      if (savedId) close();
    } catch (error) {
      console.error(error);
      const message = extractErrorMessage(error) || '项目创建失败';
      setPathError(message);
      showToast(message, 'var(--rose)');
      pathInput.focus();
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  };
  setTimeout(() => pathInput.focus(), 0);
}

function deleteProject(projectId) {
  const project = getProjects()[projectId];
  if (!project) return;
  if (getProjectSessionIds(projectId).some(id => isSessionRunning(id))) {
    showToast('项目里还有会话正在运行，结束后再删除。', 'var(--muted)');
    return;
  }
  showConfirm(`确定删除对话项目「${project.name || project.id}」？这只会删除 Pi 会话记录文件夹，不会删除项目文件夹。`, async () => {
    try {
      await deletePiProjectFolder(project);
      removeProjectLocally(projectId);
      await syncPiProjectFolders(true);
      renderProjectControls();
      renderProjects();
      if (isAgentWorkspace()) refreshChat();
      showToast('对话项目已删除，项目文件夹已保留', 'var(--muted)');
    } catch (err) {
      console.error(err);
      showToast('对话项目删除失败', 'var(--rose)');
    }
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

function updateAgentBranchBadge(project) {
  const badge = $('agentBranchBadge');
  if (!badge) return;
  const branch = isAgentWorkspace() && isProjectAvailable(project) ? (project?.gitBranch || '') : '';
  badge.textContent = branch;
  badge.title = branch ? `Git branch: ${branch}` : '';
  badge.classList.toggle('hidden', !branch);
  badge.classList.toggle('detached', Boolean(project?.gitBranchDetached));
}

function renderProjectControls() {
  const project = getActiveProject();
  const hasUsableProject = isProjectAvailable(project);
  if (isAgentWorkspace()) activeRunMode = 'task';
  if ($('projectBadge')) {
    const showProjectBadge = isAgentWorkspace();
    const projectBadgeLabel = showProjectBadge ? (project?.name || '未选择项目') : '';
    $('projectBadge').textContent = projectBadgeLabel;
    $('projectBadge').title = showProjectBadge ? `当前项目：${projectBadgeLabel}` : '';
    $('projectBadge').classList.toggle('hidden', !showProjectBadge);
  }
  if ($('activeProjectHint')) $('activeProjectHint').textContent = isAgentWorkspace() && project ? project.path || project.name : '';
  updateAgentBranchBadge(project);
  if ($('projectSwitcher')) $('projectSwitcher').style.display = isAgentWorkspace() ? '' : 'none';
  if ($('btnNewSession')) $('btnNewSession').textContent = isAgentWorkspace() ? '+ 新建 Agent 会话' : '+ 新建对话';
  if ($('input')) $('input').placeholder = isAgentWorkspace() ? (hasUsableProject ? '描述要在当前项目中执行的任务...' : '请新建项目或恢复项目文件夹') : '输入消息...';
  updateAgentModelPicker();

  const trigger = $('projectSelectTrigger');
  const dropdown = $('projectSelectDropdown');
  if (!trigger || !dropdown) return;
  dropdown.innerHTML = '';
  const projects = Object.values(getProjects()).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const activeId = getActiveProjectId();
  const activeProject = projects.find(p => p.id === activeId);
  trigger.textContent = activeProject ? activeProject.name : (projects.length ? '暂无可用项目' : '暂无项目');
  projects.forEach(projectItem => {
    const available = isProjectAvailable(projectItem);
    const li = document.createElement('li');
    li.className = 'custom-select-option' + (projectItem.id === activeId ? ' selected' : '') + (available ? '' : ' unavailable');
    li.textContent = available ? projectItem.name : `${projectItem.name}（缺失）`;
    li.dataset.value = projectItem.id;
    li.onclick = () => {
      if (!available) {
        showToast(projectUnavailableReason(projectItem), 'var(--rose)');
        return;
      }
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
  const projectItems = Object.values(getProjects()).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  if (projectItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'project-empty';
    empty.innerHTML = '<strong>暂无对话项目</strong><small>新建项目后，会在 Pi sessions 目录里生成对应的会话记录文件夹。</small>';
    grid.appendChild(empty);
    return;
  }
  projectItems.forEach(project => {
    const available = isProjectAvailable(project);
    const localCount = Object.values(sessions).filter(s => getSessionKind(s) === AGENT_SCOPE && (s.projectId || 'default') === project.id).length;
    const count = Number.isFinite(project.sessionCount) ? project.sessionCount : localCount;
    const card = document.createElement('button');
    card.className = 'project-card' + (project.id === getActiveProjectId() ? ' active' : '') + (available ? '' : ' unavailable');
    if (!available) card.setAttribute('aria-disabled', 'true');
    card.innerHTML = `
      <span class="project-card-kicker">${count} 个 Agent 会话${available ? '' : ' · 缺失'}</span>
      <strong>${escapeHtml(project.name)}</strong>
      <small>项目文件夹：${escapeHtml(project.path || '未设置路径')}</small>
      <small>会话记录：${escapeHtml(project.sessionDir || '未设置路径')}</small>
      ${available ? '' : `<span class="project-card-status">${escapeHtml(projectUnavailableReason(project))}</span>`}
      <span class="project-card-actions">
        <span class="project-action danger" data-action="delete">删除</span>
      </span>
    `;
    card.onclick = event => {
      const action = event.target?.dataset?.action;
      if (action === 'delete') {
        event.stopPropagation();
        deleteProject(project.id);
        return;
      }
      if (!available) {
        showToast(projectUnavailableReason(project), 'var(--rose)');
        return;
      }
      setActiveProject(project.id);
    };
    card.ondblclick = event => {
      if (event.target?.dataset?.action) return;
      if (!available) {
        showToast(projectUnavailableReason(project), 'var(--rose)');
        return;
      }
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
        title: sessions[existingId].customTitle || piSession.title || sessions[existingId].title,
        customTitle: sessions[existingId].customTitle || '',
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

async function deletePiProjectFolder(project) {
  if (!project?.sessionDir && project?.source !== 'pi') return false;
  const resp = await fetch('/api/pi-project', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, sessionDir: project.sessionDir || '' }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error(text || `HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return true;
}

function removeProjectLocally(projectId) {
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
  persistActiveProject();
  syncedPiProjects.delete(projectId);
  const visibleSessionIds = getVisibleSessionIds();
  if (!visibleSessionIds.includes(getActiveId())) setActiveId(visibleSessionIds[0] || null);
}

function createSession() {
  if (isAgentWorkspace() && !isProjectAvailable(getActiveProject())) {
    showToast('请新建项目或恢复项目文件夹', 'var(--rose)');
    return null;
  }
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
  updateSendButtonState();
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
  if (isSessionRunning(id)) {
    showToast('会话仍在运行，结束后再删除。', 'var(--muted)');
    return;
  }
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

async function clearVisibleSessionsWithPiOption() {
  const ids = getVisibleSessionIds();
  if (ids.length === 0) return;
  if (ids.some(id => isSessionRunning(id))) {
    showToast('有会话仍在运行，结束后再清空。', 'var(--muted)');
    return;
  }

  const sessions = getSessions();
  const agentProjectIds = new Set();
  let deletedPiCount = 0;

  for (const id of ids) {
    const session = sessions[id];
    if (!session) continue;
    const isAgentSession = getSessionKind(session) === AGENT_SCOPE;
    const piSessionPath = isAgentSession ? session.piSessionPath : '';
    if (isAgentSession) agentProjectIds.add(session.projectId || 'default');

    if (piSessionPath && USE_DATABASE) {
      try {
        await deletePiSessionFile(piSessionPath);
        deletedPiCount += 1;
      } catch (err) {
        console.error(err);
        if (err.status !== 404) {
          showToast('Pi Agent 会话清空失败', 'var(--rose)');
          return;
        }
      }
    }
  }

  ids.forEach(id => { delete sessions[id]; });
  saveSessions(sessions);
  agentProjectIds.forEach(projectId => syncedPiProjects.delete(projectId));

  const nextIds = getVisibleSessionIds();
  setActiveId(nextIds.length ? nextIds[0] : null);
  renderProjects();
  renderSessionList();
  renderMessages();
  showToast(deletedPiCount > 0 ? `已清空 ${ids.length} 个会话，并删除 ${deletedPiCount} 条 Pi Agent 记录` : `已清空 ${ids.length} 个会话`, 'var(--muted)');
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

function normalizeSessionTitle(title) {
  return (title || '').replace(/\s+/g, ' ').trim();
}

function getSessionDisplayTitle(session) {
  return session?.customTitle || session?.title || '新会话';
}

function renameSession(id, title) {
  const nextTitle = normalizeSessionTitle(title);
  if (!nextTitle) {
    showToast('会话名不能为空', 'var(--rose)');
    return false;
  }
  updateSessionById(id, { title: nextTitle, customTitle: nextTitle });
  renderSessionList();
  showToast('会话名已更新', 'var(--muted)');
  return true;
}

function startSessionRename(id, titleEl) {
  const session = getSessionById(id);
  if (!session || !titleEl) return;
  const item = titleEl.closest('.session-item');
  const currentTitle = getSessionDisplayTitle(session);
  const input = document.createElement('input');
  input.className = 'session-title-input';
  input.type = 'text';
  input.value = currentTitle;
  input.maxLength = 80;
  input.setAttribute('aria-label', '编辑会话名称');

  let finished = false;
  const finish = shouldSave => {
    if (finished) return;
    finished = true;
    const nextTitle = normalizeSessionTitle(input.value);
    if (shouldSave && nextTitle && nextTitle !== currentTitle) renameSession(id, nextTitle);
    else renderSessionList();
  };

  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('dblclick', e => e.stopPropagation());
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));

  item?.classList.add('renaming');
  titleEl.replaceWith(input);
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function switchSession(id) {
  const session = getSessionById(id);
  if (session?.completedUnread) updateSessionById(id, { completedUnread: false });
  setActiveId(id);
  renderSessionList();
  renderMessages();
  updateSendButtonState();
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
    const running = isSessionRunning(id);
    const completedUnread = !!s.completedUnread && !running;
    item.className = 'session-item' + (id === activeId ? ' active' : '') + (running ? ' running' : '') + (completedUnread ? ' completed-unread' : '');

    const title = document.createElement('div');
    title.className = 'session-title';
    title.textContent = s.title || '新会话';
    title.title = s.title || '新会话';

    const time = document.createElement('div');
    time.className = 'session-time';
    time.textContent = formatTime(s.created);
    title.textContent = getSessionDisplayTitle(s);
    title.title = '双击编辑名称';
    title.ondblclick = e => {
      e.stopPropagation();
      startSessionRename(id, title);
    };

    const state = document.createElement('span');
    state.className = 'session-state';
    state.title = running ? '正在运行' : (completedUnread ? '已完成' : '');
    state.setAttribute('aria-hidden', 'true');

    const del = document.createElement('button');
    del.className = 'session-del';
    del.innerHTML = '&times;';
    del.title = '删除';
    del.onclick = (e) => {
      e.stopPropagation();
      showConfirm(`确定删除「${s.title || '新会话'}」？`, () => deleteSessionWithPiOption(id));
    };

    const edit = document.createElement('button');
    edit.className = 'session-edit';
    edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="m16.5 3.5 4 4L8 20H4v-4L16.5 3.5Z"></path></svg>';
    edit.title = '编辑名称';
    edit.setAttribute('aria-label', '编辑会话名称');
    edit.onclick = e => {
      e.stopPropagation();
      startSessionRename(id, title);
    };

    item.onclick = () => switchSession(id);
    item.appendChild(title);
    item.appendChild(time);
    item.appendChild(state);
    item.appendChild(edit);
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
  const metaEl = bubble?.parentElement?.querySelector('.msg-meta-row .msg-meta');
  if (!metaEl) return;
  const text = getMessageMetaText(role, meta);
  metaEl.textContent = text;
  metaEl.classList.toggle('empty', !text);
}

$('btnNewSession').onclick = () => { createSession(); $('input').focus(); updateSendButtonState(); };

$('btnClearAll').onclick = () => {
  const count = getVisibleSessionIds().length;
  if (count === 0) return;
  showConfirm(`确定删除当前列表中的 ${count} 个会话？此操作不可撤销。`, () => {
    clearVisibleSessionsWithPiOption().catch(err => {
      console.error(err);
      showToast('会话清空失败', 'var(--rose)');
    });
  });
  return;
  if (Object.keys(getSessions()).some(id => isSessionRunning(id))) {
    showToast('有会话仍在运行，结束后再清空。', 'var(--muted)');
    return;
  }
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
// ── Input pill overlay ──
const inputRow = inputEl.parentNode;
const inputWrap = document.createElement('div');
inputWrap.className = 'input-wrap';
inputRow.insertBefore(inputWrap, inputEl);
inputWrap.appendChild(inputEl);
inputEl.style.background = 'transparent';

// ── Contenteditable input: inline pill rendering ──
function getInputText() { return inputEl.innerText || ''; }
function setInputText(t) { inputEl.innerText = t; renderPills(); }

function getCaret() {
  const s = window.getSelection(); if (!s.rangeCount) return 0;
  const r = s.getRangeAt(0), p = r.cloneRange();
  p.selectNodeContents(inputEl); p.setEnd(r.endContainer, r.endOffset);
  return p.toString().length;
}
function setCaret(pos) {
  const s = window.getSelection(), r = document.createRange(); let rem = pos;
  (function walk(n) {
    if (n.nodeType===3) { const L=n.textContent.length;
      if (rem<=L) { r.setStart(n,rem); r.collapse(1); s.removeAllRanges(); s.addRange(r); return 1; }
      rem-=L; } else for (const c of n.childNodes) if (walk(c)) return 1;
  })(inputEl)||(r.selectNodeContents(inputEl),r.collapse(0),s.removeAllRanges(),s.addRange(r));
}
function getKnownFileNames() {
  if (!isAgentWorkspace()) return new Set();
  const files = fileOptionsCache[referenceCacheKey()] || [];
  const names = new Set();
  files.forEach(f => { if (f.name) names.add(f.name); if (f.path) names.add(f.path); });
  return names;
}

function renderPills() {
  const p = getCaret(), t = inputEl.innerText||'';
  if (!t) { inputEl.innerHTML=''; return; }
  const knownFiles = getKnownFileNames();
  inputEl.innerHTML = t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/(^|\s)(\/\S+)/g,'$1<span class="ref-pill">$2</span>')
    .replace(/(^|\s)(@\S+)/g, (match, prefix, ref) => {
      if (knownFiles.size && knownFiles.has(ref.slice(1))) return `${prefix}<span class="ref-pill">${ref}</span>`;
      return match;
    });
  setCaret(Math.min(p,t.length));
}
inputEl.addEventListener('paste', e => { e.preventDefault();
  document.execCommand('insertText',false,(e.clipboardData||window.clipboardData).getData('text/plain')); });
inputEl.addEventListener('drop', e => e.preventDefault());

const sendBtn = $('sendBtn');
const inputArea = $('inputArea');
const chatLayoutEl = document.querySelector('.chat-layout');
const sidebarToggle = $('sidebarToggle');
const agentModelTrigger = $('agentModelTrigger');
const agentModelPicker = $('agentModelPicker');
const referencePickerEl = $('referencePicker');

if (agentModelTrigger) {
  agentModelTrigger.onclick = event => {
    event.stopPropagation();
    toggleAgentModelMenu();
  };
}

if (agentModelPicker) {
  agentModelPicker.addEventListener('click', event => event.stopPropagation());
}

document.addEventListener('click', closeAgentModelMenu);

function referenceCacheKey(projectId = getActiveProjectId()) {
  return projectId || 'default';
}

async function loadSkillOptions(force = false) {
  const projectId = getActiveProjectId();
  if (!USE_DATABASE) return [];
  if (!force && skillOptionsCache && skillOptionsProjectId === projectId) return skillOptionsCache;
  const params = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  const data = await apiRequest(`/api/pi-skills${params}`);
  skillOptionsProjectId = projectId;
  skillOptionsCache = data.skills || [];
  return skillOptionsCache;
}

async function loadFileOptions(force = false) {
  const projectId = getActiveProjectId();
  if (!USE_DATABASE || !isProjectAvailable(getActiveProject())) return [];
  const key = referenceCacheKey(projectId);
  if (!force && fileOptionsCache[key]) return fileOptionsCache[key];
  const params = new URLSearchParams({ projectId: projectId || '', limit: '600' });
  const data = await apiRequest(`/api/project-files?${params.toString()}`);
  fileOptionsCache[key] = data.files || [];
  return fileOptionsCache[key];
}

function getReferenceTrigger() {
  if (!isAgentWorkspace() || !inputEl) return null;
  const caret = getCaret();
  // contenteditable, no selection direction check
  const before = getInputText().slice(0, caret);
  const match = before.match(/(^|[\s([{])([/@]\S*)$/);
  if (!match) return null;
  return {
    type: match[2][0] === '/' ? 'skill' : 'file',
    query: match[2].slice(1),
    tokenStart: caret - match[2].length,
    tokenEnd: caret,
  };
}

function filterReferenceItems(type, query, options) {
  let normalized = (query || '').trim().toLowerCase();
  const items = [];
  if (type === 'skill') {
   if (['skill', 'skills', '技能'].includes(normalized)) normalized = '';
   options.forEach(skill => {
     const name = skill.name || '';
     const haystack = `${name} ${skill.description || ''} ${skill.source || ''} ${skill.path || ''}`.toLowerCase();
     if (normalized && !haystack.includes(normalized)) return;
      // Compute priority: name-start > name-contain > other-fields
      let priority = 0;
      if (normalized) {
        const lowerName = name.toLowerCase();
        if (!lowerName.includes(normalized)) {
          // Name doesn't match, only other fields matched → lower priority
          priority = 2;
        } else if (!lowerName.startsWith(normalized)) {
          priority = 1;
        }
      }
     items.push({
       type,
       title: name,
       subtitle: skill.description || skill.source || skill.path || '',
       meta: skill.source || '',
       insertText: `/${name} `,
       badge: "/",
        _priority: priority,
     });
   });
    if (normalized) items.sort((a, b) => a._priority - b._priority);
   return items.slice(0, 50);
  }

  options.forEach(file => {
    const path = file.path || '';
    const name = file.name || path;
   const haystack = `${path} ${name}`.toLowerCase();
   if (normalized && !haystack.includes(normalized)) return;
    // Compute priority: name-start > name-contain > path-only
    let priority = 0;
    if (normalized) {
      const lowerName = name.toLowerCase();
      if (!lowerName.includes(normalized)) {
        priority = 2; // only path matched
      } else if (!lowerName.startsWith(normalized)) {
        priority = 1;
      }
    }
   const quotedPath = /\s/.test(path) ? `"${path}"` : path;
   items.push({
     type,
     title: name,
     subtitle: path,
     meta: file.directory || file.extension || '',
     insertText: `@${quotedPath} `,
     badge: '@',
      _priority: priority,
   });
 });
  if (normalized) items.sort((a, b) => a._priority - b._priority);
 return items.slice(0, 50);
}

function closeReferencePicker() {
  referencePickerState.open = false;
  referencePickerState.items = [];
  if (referencePickerEl) {
    referencePickerEl.classList.add('hidden');
    referencePickerEl.innerHTML = '';
  }
}

function renderReferencePicker(status = '') {
  if (!referencePickerEl) return;
  const type = referencePickerState.type;
  const title = type === 'skill' ? 'Skills' : 'Files';
  const lead = type === 'skill' ? '/' : '@';
  const items = referencePickerState.items || [];
  referencePickerEl.classList.remove('hidden');

  // Preserve .reference-picker-list element across renders so scrollTop persists
  let head = referencePickerEl.querySelector('.reference-picker-head');
  let list = referencePickerEl.querySelector('.reference-picker-list');

  if (!head || !list) {
    // First render after open: build structure
    referencePickerEl.innerHTML = [
      '<div class="reference-picker-head">',
      '  <span class="reference-picker-title"></span>',
      '  <span class="reference-picker-count"></span>',
      '  <small></small>',
      '</div>',
      '<div class="reference-picker-list"></div>',
    ].join('\n');
    head = referencePickerEl.querySelector('.reference-picker-head');
    list = referencePickerEl.querySelector('.reference-picker-list');
    // Attach wheel listener once
    list.addEventListener('wheel', e => {
      if (list.scrollHeight > list.clientHeight) {
        e.preventDefault();
        list.scrollBy({ top: e.deltaY, behavior: 'auto' });
      }
    }, { passive: false });
  }

  // Update head
  head.querySelector('.reference-picker-title').textContent = title;
  const countEl = head.querySelector('.reference-picker-count');
  countEl.textContent = items.length > 0 ? String(items.length) : '';
  head.querySelector("small").textContent = escapeHtml(referencePickerState.query ? lead + referencePickerState.query : lead);

  // Update list content - element preserved, scrollTop stays intact
  list.innerHTML = [
    status ? '<div class="reference-picker-empty">' + escapeHtml(status) + '</div>' : '',
    items.map((item, index) =>
      '<button class="reference-option' + (index === referencePickerState.activeIndex ? ' active' : '') +
        '" data-index="' + index + '" type="button" role="option" aria-selected="' +
        (index === referencePickerState.activeIndex ? 'true' : 'false') + '">' +
        '<span class="reference-option-mark">' + escapeHtml(item.badge || lead) + '</span>' +
        '<span class="reference-option-copy">' +
          '<strong>' + escapeHtml(item.title) + '</strong>' +
          '<small>' + escapeHtml(item.subtitle || item.meta || '') + '</small>' +
        '</span>' +
      '</button>'
    ).join(''),
    !status && items.length === 0 ? '<div class="reference-picker-empty">没有匹配项</div>' : '',
  ].filter(Boolean).join('\n');

  // Attach button event handlers
  list.querySelectorAll('.reference-option').forEach(button => {
    const selectButtonItem = event => {
      event.preventDefault();
      event.stopPropagation();
      const index = Number(button.dataset.index || 0);
      referencePickerState.activeIndex = index;
      const item = referencePickerState.items[index];
      if (item) insertReferenceItem(item);
    };
    button.onmouseenter = () => {
      referencePickerState.activeIndex = Number(button.dataset.index || 0);
      renderReferencePicker();
    };
    button.onpointerdown = selectButtonItem;
    button.onclick = selectButtonItem;
  });

  // scroll active item into view so keyboard navigation follows selection
  const activeButton = list.querySelector('.reference-option.active');
  if (activeButton) {
    activeButton.scrollIntoView({ block: 'nearest' });
  }
}

async function updateReferencePicker({ force = false } = {}) {
  const trigger = getReferenceTrigger();
  if (!trigger) {
    closeReferencePicker();
    return;
  }

  referencePickerState.open = true;
  referencePickerState.type = trigger.type;
  referencePickerState.query = trigger.query;
  referencePickerState.tokenStart = trigger.tokenStart;
  referencePickerState.tokenEnd = trigger.tokenEnd;
  if (!force) referencePickerState.activeIndex = 0;
  renderReferencePicker('正在读取...');

  try {
    const options = trigger.type === 'skill'
      ? await loadSkillOptions()
      : await loadFileOptions();
    const latest = getReferenceTrigger();
    if (!latest || latest.type !== trigger.type || latest.tokenStart !== trigger.tokenStart) return;
    referencePickerState.query = latest.query;
    referencePickerState.tokenEnd = latest.tokenEnd;
    referencePickerState.items = filterReferenceItems(trigger.type, latest.query, options);
    referencePickerState.activeIndex = Math.min(referencePickerState.activeIndex, Math.max(0, referencePickerState.items.length - 1));
    renderReferencePicker();
  } catch (error) {
    console.error(error);
    referencePickerState.items = [];
    renderReferencePicker(trigger.type === 'skill' ? '技能读取失败' : '文件读取失败');
  }
}

function insertReferenceItem(item) {
  const start = referencePickerState.tokenStart;
  const end = Math.max(start, referencePickerState.tokenEnd ?? getCaret());
  const value = getInputText();
  setInputText(value.slice(0, start) + item.insertText + value.slice(end));
  setCaret(start + item.insertText.length);
  closeReferencePicker();
  inputEl.focus();
}

function handleReferencePickerKeydown(event) {
  if (!referencePickerState.open || !referencePickerEl || referencePickerEl.classList.contains('hidden')) return false;
  const items = referencePickerState.items || [];
  if (event.key === 'Escape') {
    event.preventDefault();
    closeReferencePicker();
    return true;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!items.length) return true;
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    referencePickerState.activeIndex = (referencePickerState.activeIndex + delta + items.length) % items.length;
    renderReferencePicker();
    return true;
  }
  if ((event.key === 'Enter' || event.key === 'Tab') && items.length) {
    event.preventDefault();
    insertReferenceItem(items[referencePickerState.activeIndex] || items[0]);
    return true;
  }
  if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault();
    return true;
  }
  return false;
}

function isSkillListRequest(text) {
  return /^\/(?:skills?|技能)?$/i.test((text || '').trim());
}

if (referencePickerEl) {
  referencePickerEl.addEventListener('click', event => event.stopPropagation());
}

document.addEventListener('click', closeReferencePicker);

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
  if (isAgentWorkspace() && !isProjectAvailable(getActiveProject())) {
    messagesEl.innerHTML = `<div class="no-config"><div class="icon">&#9670;</div><p>请新建项目或恢复项目文件夹</p><button id="emptyProjectBtn">前往项目</button></div>`;
    const emptyProjectBtn = $('emptyProjectBtn');
    if (emptyProjectBtn) emptyProjectBtn.onclick = () => document.querySelector('[data-tab=projects]')?.click();
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
  buildRoundNav();
}

function renderInFlightMessage(scope, sessionId) {
  const flight = getSessionFlight(scope, sessionId);
  if (!flight) return;
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

function useTip(el) { setInputText(el.textContent); inputEl.focus(); }

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
    const escapedSource = escapeHtml(source);
    const block = `<div class="math-block" data-latex="${escapedSource}"><span class="math-content">${escapedSource}</span><button class="math-copy-btn" onclick="copyMathFormula(this)" title="复制公式"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></div>`;
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

function copyMathFormula(button) {
  const mathBlock = button.closest('.math-block');
  const latex = mathBlock.getAttribute('data-latex');

  navigator.clipboard.writeText(latex).then(() => {
    // 复制成功，显示反馈
    button.classList.add('copied');
    button.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
    setTimeout(() => {
      button.classList.remove('copied');
      button.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    }, 2000);
  }).catch(err => {
    console.error('复制失败:', err);
    // 降级方案
    const textarea = document.createElement('textarea');
    textarea.value = latex;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      button.classList.add('copied');
      button.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
      setTimeout(() => {
        button.classList.remove('copied');
        button.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      }, 2000);
    } catch (e) {
      console.error('降级复制也失败:', e);
    }
    document.body.removeChild(textarea);
  });
}

function copyTable(button) {
  const wrapper = button.closest('.table-wrapper');
  const table = wrapper.querySelector('table');
  if (!table) return;

  // 构建带样式的 HTML（粘贴到 Word/飞书等保留表格格式）
  const tableHtml = '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;border:1px solid #999">'
    + table.innerHTML + '</table>';

  // 构建纯文本 TSV（粘贴到终端/记事本回退）
  const rows = [];
  table.querySelectorAll('tr').forEach(tr => {
    const cells = Array.from(tr.children).filter(c => c.tagName === 'TD' || c.tagName === 'TH');
    rows.push(cells.map(c => c.textContent.trim()).join('\t'));
  });
  const tsv = rows.join('\n');

  function showOk() {
    button.classList.add('copied');
    button.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
    setTimeout(() => {
      button.classList.remove('copied');
      button.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    }, 2000);
  }

  // 优先用 Clipboard API 同时写入 HTML + 纯文本
  if (navigator.clipboard.write) {
    const htmlBlob = new Blob([tableHtml], { type: 'text/html' });
    const textBlob = new Blob([tsv], { type: 'text/plain' });
    navigator.clipboard.write([
      new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob })
    ]).then(showOk).catch(() => fallbackCopy());
  } else {
    fallbackCopy();
  }

  function fallbackCopy() {
    // 降级：用 execCommand，只能写纯文本
    const textarea = document.createElement('textarea');
    textarea.value = tsv;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try { document.execCommand('copy'); showOk(); } catch (e) { console.error('复制失败:', e); }
    document.body.removeChild(textarea);
  }
}

/** 给 bubble 内所有表格添加复制按钮（DOMPurify 之后调用） */
function addTableCopyButtons(bubble) {
  // 已有 wrapper 的表格，直接加按钮
  bubble.querySelectorAll('.table-wrapper').forEach(wrapper => {
    if (wrapper.querySelector('.table-copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'table-copy-btn';
    btn.title = '复制表格';
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    btn.addEventListener('click', () => copyTable(btn));
    wrapper.appendChild(btn);
  });
  // marked 生成的裸 table，包一层再加按钮
  bubble.querySelectorAll('table:not(.table-wrapper table)').forEach(table => {
    if (table.closest('.table-wrapper')) return; // 已在 wrapper 内
    const wrapper = document.createElement('div');
    wrapper.className = 'table-wrapper';
    table.parentNode.insertBefore(wrapper, table);
    wrapper.appendChild(table);
    const btn = document.createElement('button');
    btn.className = 'table-copy-btn';
    btn.title = '复制表格';
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    btn.addEventListener('click', () => copyTable(btn));
    wrapper.appendChild(btn);
  });
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
      const tableHtml = `<table><thead><tr>${headers.map(cell => `<th>${renderInlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${renderInlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      blocks.push(`<div class="table-wrapper">${tableHtml}</div>`);
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
  if (path.startsWith('<') && path.endsWith('>')) path = path.slice(1, -1).trim();
  const imageTarget = path.match(new RegExp(`^([\\s\\S]*?\\.(${IMAGE_EXT_PATTERN}))(?:\\s+["'][\\s\\S]*["'])?$`, 'i'));
  if (imageTarget) path = imageTarget[1].trim();
  path = path.replace(/^([a-z]):(?:\s+|%20)+([\\/])/i, '$1:$2');
  path = path.replace(/^([a-z])：/i, '$1:');  // normalize full-width colon C： -> C:
  path = path.replace(/^[*`"'“”‘’（(【\[]+|[*`"'“”‘’。.,，、；;：:！!？?）)】\]]+$/g, '');
  path = path.replace(/^[<([{]+|[>\])}.,;!?]+$/g, '');
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

function loadDeferredProjectImages(gallery) {
  gallery.querySelectorAll('img[data-src]').forEach(image => {
    image.src = image.dataset.src;
    image.removeAttribute('data-src');
  });
}

function restoreMessagesScrollTop(scrollTop) {
  const maxScrollTop = Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight);
  messagesEl.scrollTop = Math.min(scrollTop, maxScrollTop);
}

function extractProjectImagePaths(content) {
  const source = content || '';
  const seen = new Set();
  const paths = [];
  const claimedRanges = [];
  const add = (value, range) => {
    const path = normalizeProjectImagePath(value);
    if (!path || seen.has(path)) return;
    const pathKey = path.toLowerCase();
    if (!/^[a-z]:\//i.test(path) && paths.some(existing => existing.toLowerCase().endsWith(`/${pathKey}`))) {
      if (range) claimedRanges.push(range);
      return;
    }
    seen.add(path);
    paths.push(path);
    if (range) claimedRanges.push(range);
  };

  const markdownAnglePattern = /!?\[[^\]]*]\(<([^>\r\n]+)>\)/g;
  for (const match of source.matchAll(markdownAnglePattern)) {
    add(match[1], [match.index, match.index + match[0].length]);
  }

  const markdownPattern = /!?\[[^\]]*]\(([^)\r\n]+)\)/g;
  for (const match of source.matchAll(markdownPattern)) {
    add(match[1], [match.index, match.index + match[0].length]);
  }

  const absoluteWindowsPattern = new RegExp(`[A-Za-z]:\\s*[\\\\/][^\\r\\n<>"'“”‘’|]+?\\.(${IMAGE_EXT_PATTERN})`, 'gi');
  for (const match of source.matchAll(absoluteWindowsPattern)) {
    add(match[0], [match.index, match.index + match[0].length]);
  }

  const filenameSource = source.split('').map((char, index) =>
    claimedRanges.some(([start, end]) => index >= start && index < end) ? ' ' : char
  ).join('');

  const lineImagePattern = new RegExp(`[^\\r\\n|<>"'“”‘’]+?\\.(${IMAGE_EXT_PATTERN})(?=\\s*(?:$|[|,，。；;！!？?）)】\\]]))`, 'gim');
  for (const match of filenameSource.matchAll(lineImagePattern)) {
    const relativeStart = match[0].search(/[A-Za-z0-9._\u4e00-\u9fff]/);
    const valueStart = match.index + Math.max(0, relativeStart);
    const value = match[0]
      .slice(Math.max(0, relativeStart))
      .replace(/^\s*(?:[-*+]|\d+[\s.)、]|[|])\s*/, '')
      .replace(/^\s*\d+\s+/, '')
      .trim();
    add(value, [valueStart, match.index + match[0].length]);
  }

  const remainingFilenameSource = filenameSource.split('').map((char, index) =>
    claimedRanges.some(([start, end]) => index >= start && index < end) ? ' ' : char
  ).join('');

  const filenamePattern = new RegExp(`(?:[A-Za-z]:[\\\\/])?\\.?\\/?[^\\s*<>"'“”‘’|：:，。；;！!？?（）()【】\\[\\]]+?\\.(${IMAGE_EXT_PATTERN})`, 'gi');
  for (const match of remainingFilenameSource.matchAll(filenamePattern)) add(match[0]);

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
    renderedPaths.add(path.toLowerCase());
  });

  const paths = extractProjectImagePaths(content).filter(path => !renderedPaths.has(path.toLowerCase()));
  if (!paths.length) return;

  const panel = document.createElement('div');
  panel.className = 'project-image-preview-panel';
  const isExpanded = bubble.dataset.projectImagesExpanded === '1';
  panel.classList.toggle('expanded', isExpanded);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'project-image-toggle';
  toggle.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');

  const label = document.createElement('span');
  label.className = 'project-image-toggle-label';
  label.textContent = `识别到 ${paths.length} 张图片`;

  const hint = document.createElement('span');
  hint.className = 'project-image-toggle-hint';
  hint.textContent = isExpanded ? '收起预览' : '展开预览';

  const chevron = document.createElement('span');
  chevron.className = 'project-image-toggle-chevron';
  chevron.setAttribute('aria-hidden', 'true');

  toggle.appendChild(label);
  toggle.appendChild(hint);
  toggle.appendChild(chevron);

  const gallery = document.createElement('div');
  gallery.className = 'project-image-gallery';
  gallery.hidden = !isExpanded;
  paths.forEach(path => {
    const figure = document.createElement('figure');
    figure.className = 'project-image-card';

    const imageUrl = projectImageUrl(path, meta.projectId);
    const image = document.createElement('img');
    if (isExpanded) image.src = imageUrl;
    else image.dataset.src = imageUrl;
    image.alt = path;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.onerror = () => figure.classList.add('load-error');

    const link = document.createElement('a');
    link.href = imageUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.appendChild(image);

    const caption = document.createElement('figcaption');
    caption.textContent = path;

    figure.appendChild(link);
    figure.appendChild(caption);
    gallery.appendChild(figure);
  });

  if (isExpanded) loadDeferredProjectImages(gallery);

  toggle.addEventListener('click', () => {
    const previousScrollTop = messagesEl.scrollTop;
    const expanded = !panel.classList.contains('expanded');
    panel.classList.toggle('expanded', expanded);
    gallery.hidden = !expanded;
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    hint.textContent = expanded ? '收起预览' : '展开预览';
    bubble.dataset.projectImagesExpanded = expanded ? '1' : '0';
    if (expanded) {
      loadDeferredProjectImages(gallery);
    }
    restoreMessagesScrollTop(previousScrollTop);
    requestAnimationFrame(() => restoreMessagesScrollTop(previousScrollTop));
  });

  panel.appendChild(toggle);
  panel.appendChild(gallery);
  bubble.appendChild(panel);
}

function setBubbleContent(bubble, role, content, renderRich = role !== 'user', renderMath = true, meta = {}) {
  if (role === 'user' || !renderRich) {
    bubble.textContent = content;
    return;
  }
  bubble.innerHTML = renderMarkdown(content);
  if (renderMath && window.MathJax?.typesetPromise) typesetMath(bubble);
  else applyMathFallback(bubble);
  addTableCopyButtons(bubble);
  appendProjectImagePreviews(bubble, content, meta);
  /* General image enhancements: lazy loading & click-to-open for non-project images */
  bubble.querySelectorAll('img:not(.project-inline-image)').forEach(img => {
    img.loading = 'lazy';
    img.decoding = 'async';
    if (!img.closest('a')) {
      const link = document.createElement('a');
      link.href = img.getAttribute('src') || '';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      img.parentNode.insertBefore(link, img);
      link.appendChild(img);
    }
  });
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

  // 创建 meta 行容器（meta + 复制按钮）
  const metaRow = document.createElement('div');
  metaRow.className = 'msg-meta-row';
  metaRow.appendChild(metaEl);

  // 添加复制按钮（仅 AI 回复）
  if (role !== 'user') {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-copy-btn';
    copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    copyBtn.title = '复制内容';
    copyBtn.onclick = () => {
      const text = bubbleToText(bubble);
      const html = bubbleToHtml(bubble);
      function showOk() {
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
        }, 2000);
      }
      if (navigator.clipboard.write) {
        const htmlBlob = new Blob([html], { type: 'text/html' });
        const textBlob = new Blob([text], { type: 'text/plain' });
        navigator.clipboard.write([
          new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob })
        ]).then(showOk).catch(() => {
          navigator.clipboard.writeText(text).then(showOk).catch(err => {
            console.error('复制失败:', err);
            showToast('复制失败', 'var(--rose)');
          });
        });
      } else {
        navigator.clipboard.writeText(text).then(showOk).catch(err => {
          console.error('复制失败:', err);
          showToast('复制失败', 'var(--rose)');
        });
      }
    };
    metaRow.appendChild(copyBtn);
  }

  contentWrap.appendChild(metaRow);

  div.appendChild(avatar);
  div.appendChild(contentWrap);
  messagesEl.appendChild(div);
  scrollToBottom();
  return bubble;
}

function scrollToBottom() { requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; }); }

inputEl.addEventListener('input', () => {
  // IME ????? renderPills??? innerHTML ????????
  if (!inputEl.isComposing) {
    renderPills();
  }
  updateReferencePicker();
});

inputEl.addEventListener('compositionstart', () => { inputEl.isComposing = true; });
inputEl.addEventListener('compositionend', () => { inputEl.isComposing = false; });

inputEl.addEventListener('keydown', e => {
  if (handleReferencePickerKeydown(e)) return;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

inputEl.addEventListener('click', () => updateReferencePicker({ force: true }));
inputEl.addEventListener('blur', () => setTimeout(closeReferencePicker, 120));

sendBtn.addEventListener('click', () => { if (isActiveSessionStreaming()) stopStreaming(activeWorkspace, getActiveId()); else sendMessage(); });
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
      modelName: context.modelName || '',
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
  const text = getInputText().trim();
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

  if (session.messages.filter(m => m.role === 'user').length === 1 && !session.customTitle) {
    const title = text.length > 30 ? text.slice(0, 30) + '...' : text;
    updateActiveSession({ title, kind: session.kind, projectId: session.projectId, mode: session.mode, status: session.status, messages: session.messages, created: session.created });
    renderSessionList();
  } else {
    updateActiveSession({ kind: session.kind, projectId: session.projectId, mode: session.mode, status: session.status, messages: session.messages });
  }

  appendBubble('user', text, true, { created: userCreated, kind: responseKind, projectId: responseProjectId });
  setInputText(''); inputEl.style.height = 'auto'; inputEl.focus();

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
  const text = getInputText().trim();
  const requestWorkspace = activeWorkspace;
  const requestIsAgent = requestWorkspace === AGENT_SCOPE;
  if (!text) return;
  if (requestIsAgent && isSkillListRequest(text)) {
    inputEl.focus();
    setCaret(getInputText().length);
    await updateReferencePicker({ force: true });
    return;
  }
  if (isActiveSessionStreaming(requestWorkspace)) return;

  const cfg = getConfig(requestWorkspace);
  if (!cfg || (requestIsAgent ? !isCliConfig(cfg) : isCliConfig(cfg))) {
    document.querySelector('[data-tab=config]')?.click();
    setConfigScope(requestWorkspace);
    return;
  }
  if (requestIsAgent && !isProjectAvailable(getActiveProject())) {
    showToast('请新建项目或恢复项目文件夹', 'var(--rose)');
    document.querySelector('[data-tab=projects]')?.click();
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
  session.status = 'running';

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
  if (session.messages.filter(m => m.role === 'user').length === 1 && !session.customTitle) {
    patch.title = text.length > 30 ? text.slice(0, 30) + '...' : text;
    patch.created = session.created;
  }
  updateSessionById(requestSessionId, patch);
  renderSessionList();

  appendBubble('user', text, true, { created: userCreated, kind: responseKind, projectId: responseProjectId });
  setInputText('');
  inputEl.style.height = 'auto';
  inputEl.focus();

  const controller = new AbortController();

  const thinkingText = requestIsAgent ? 'Agent 正在执行任务' : '模型正在思考';
  const responseStarted = Date.now();
  let firstDeltaAt = null;
  let fullContent = '';
  const responseMeta = { created: responseStarted, kind: responseKind, projectId: responseProjectId, pending: true };
  const botBubble = appendBubble('assistant', thinkingText, true, responseMeta);
  botBubble.classList.add('streaming', 'thinking');
  const renderBotStream = createRichStreamRenderer(botBubble, responseMeta);

  inFlightByScope[requestWorkspace][requestSessionId] = {
    sessionId: requestSessionId,
    controller,
    content: '',
    started: responseStarted,
    firstDeltaAt: null,
    thinkingText,
    kind: responseKind,
    projectId: responseProjectId,
    bubble: botBubble,
    renderer: renderBotStream,
  };
  setWorkspaceStreaming(requestWorkspace);

  try {
    const messages = session.messages
      .filter(shouldRenderMessage)
      .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));

    const onDelta = delta => {
      const flight = getSessionFlight(requestWorkspace, requestSessionId);
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
          modelName: cfg.modelName,
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
      const flight = getSessionFlight(requestWorkspace, requestSessionId);
      if (flight?.bubble?.isConnected) {
        flight.bubble.classList.remove('streaming', 'thinking');
        flight.bubble.closest('.msg')?.classList.add('error');
        flight.bubble.textContent = `请求失败: ${err.message}`;
      }
    }
  }

  const flight = getSessionFlight(requestWorkspace, requestSessionId);
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

  delete inFlightByScope[requestWorkspace][requestSessionId];
  setWorkspaceStreaming(requestWorkspace);
  const finishedAway = activeWorkspace !== requestWorkspace || getActiveId() !== requestSessionId;
  updateSessionById(requestSessionId, { status: 'idle', completedUnread: finishedAway });
  renderSessionList();
  updateSendButtonState();
  if (requestIsAgent) {
    await syncPiProjectFolders(true);
    renderProjectControls();
  }
  if (activeWorkspace === requestWorkspace && getActiveId() === requestSessionId) renderMessages();
  else markWorkspaceUnread(requestWorkspace);
}

function stopStreaming(scope = activeWorkspace, sessionId = getActiveId()) {
  const controller = getSessionFlight(scope, sessionId)?.controller;
  if (controller) controller.abort();
}

function isRippleEligibleTarget(target) {
  if (!target || target === document.documentElement) return false;
  return !target.closest([
    'button',
    'a',
    'input',
    'textarea',
    'select',
    'label',
    '[contenteditable="true"]',
    '.msg',
    '.bubble',
    '.session-item',
    '.project-card',
    '.project-empty',
    '.custom-select',
    '.reference-picker',
    '.modal-overlay',
    '.confirm-overlay',
    '.toast'
  ].join(','));
}

function spawnClickRipple(event) {
  if (event.button !== 0 || !isRippleEligibleTarget(event.target)) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ripple = document.createElement('span');
  ripple.className = 'click-ripple';
  ripple.style.left = `${event.clientX}px`;
  ripple.style.top = `${event.clientY}px`;
  document.body.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
}

document.addEventListener('pointerdown', spawnClickRipple);

/* ── Round Navigator (right side) ── */
let roundNavScrollHandler = null;

function initRoundNav() {
  if (roundNavScrollHandler) {
    messagesEl.removeEventListener('scroll', roundNavScrollHandler);
  }  roundNavScrollHandler = () => updateActiveRound();
  messagesEl.addEventListener('scroll', roundNavScrollHandler, { passive: true });
}

function buildRoundNav() {
  const list = document.getElementById('roundNavList');
  if (!list) return;

  const msgs = messagesEl.querySelectorAll(':scope > .msg.user');
  const count = msgs.length;

  const countEl = document.getElementById('roundNavCount');
  if (countEl) countEl.textContent = count;

  if (count === 0) {
    list.innerHTML = '';
    return;
  }

  let html = '';
  msgs.forEach((msg, i) => {
    const text = (msg.querySelector('.bubble')?.textContent || '').trim().slice(0, 28);
    const preview = text || ('消息 ' + (i + 1));
    const roundNum = i + 1;
    html += '<button class="round-nav-item" data-round="' + roundNum + '" data-index="' + i + '" title="' + escapeHtml(preview) + '" onclick="scrollToRound(' + i + ')">' +
      '<span class="round-nav-dot">' + roundNum + '</span>' +
      '<span class="round-nav-tip">' + escapeHtml(preview) + '</span>' +
      '</button>';
  });
  list.innerHTML = html;
  updateActiveRound();
  list.scrollTop = list.scrollHeight;
}

function scrollToRound(index) {
  const msgs = messagesEl.querySelectorAll(':scope > .msg.user');
  if (index >= 0 && index < msgs.length) {
    const target = msgs[index];
    const top = target.offsetTop - messagesEl.offsetTop - 20;
    messagesEl.scrollTo({ top, behavior: 'smooth' });
  }
}

function updateActiveRound() {
  const items = document.querySelectorAll('.round-nav-item');
  if (items.length === 0) return;

  const msgs = messagesEl.querySelectorAll(':scope > .msg');
  if (msgs.length === 0) return;

  const scrollTop = messagesEl.scrollTop;
  const viewHeight = messagesEl.clientHeight;
  const viewBottom = scrollTop + viewHeight;
  const centerY = scrollTop + viewHeight * 0.4;
  const userMsgs = messagesEl.querySelectorAll(':scope > .msg.user');
  let activeIndex = -1;

  // Find the last user message whose top is at or above center of viewport
  msgs.forEach((msg) => {
    const msgTop = msg.offsetTop - messagesEl.offsetTop;
    if (msgTop <= centerY + 50 && msg.classList.contains('user')) {
      let idx = 0;
      userMsgs.forEach((u) => {
        if (u === msg) activeIndex = idx;
        if (u.offsetTop - messagesEl.offsetTop <= msgTop) idx++;
      });
    }
  });

  // Fallback: last user message visible near bottom
  if (activeIndex < 0) {
    userMsgs.forEach((u, i) => {
      if (u.offsetTop - messagesEl.offsetTop < viewBottom + 100) {
        activeIndex = i;
      }
    });
  }

  if (activeIndex < 0) activeIndex = 0;
  if (activeIndex >= items.length) activeIndex = items.length - 1;
  items.forEach((item, i) => {
    item.classList.toggle('active', i === activeIndex);
  });

  // Scroll nav list to keep active item visible
  const navList = document.getElementById('roundNavList');
  if (navList && items[activeIndex]) {
    items[activeIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
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
  await syncPiProjectFolders();
  renderPresets();
  setConfigScope(CHAT_SCOPE);
  updateModelBadge(); renderProjectControls(); renderProjects(); await refreshChat();
  initRoundNav();

  // 标签页引用计数：注册 → 注销；最后一个标签页关闭时退服
  const tabId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  fetch(`/api/hello?tab=${encodeURIComponent(tabId)}`, { method: 'POST' }).catch(() => {});
  window.addEventListener('pagehide', () => {
    navigator.sendBeacon(`/api/bye?tab=${encodeURIComponent(tabId)}`, '');
  });
}

/* Walk bubble DOM to produce clean copy text (handles math blocks inline) */
function bubbleToText(bubble) {
  const SKIP = new Set(['SCRIPT', 'STYLE']);
  const BLOCK = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TABLE', 'THEAD', 'TBODY', 'TFOOT']);
  const parts = [];
  function walk(node) {
    if (node.nodeType === 3) { parts.push(node.textContent); return; }
    if (node.nodeType !== 1) return;
    if (SKIP.has(node.tagName)) return;
    if (node.classList?.contains('msg-copy-btn') || node.classList?.contains('math-copy-btn') || node.classList?.contains('table-copy-btn')) return;
    if (node.tagName === 'BR') { parts.push('\n'); return; }
    if (node.classList?.contains('math-block')) {
      parts.push(node.getAttribute('data-latex') || '');
      return;
    }
    if (node.classList?.contains('math-inline')) {
      parts.push(node.getAttribute('data-latex') || '');
      return;
    }
    // Table row → newline separator
    if (node.tagName === 'TR') {
      if (parts.length && parts[parts.length - 1] !== '\n') parts.push('\n');
      const cells = Array.from(node.children).filter(c => c.tagName === 'TD' || c.tagName === 'TH');
      cells.forEach((cell, i) => {
        if (i > 0) parts.push('\t');
        walk(cell);
      });
      if (parts.length && parts[parts.length - 1] !== '\n') parts.push('\n');
      return;
    }
    // Skip standalone table cell (handled by TR above)
    if (node.tagName === 'TD' || node.tagName === 'TH') {
      node.childNodes.forEach(walk);
      return;
    }
    const isBlock = BLOCK.has(node.tagName) || getComputedStyle(node).display === 'block';
    if (isBlock && parts.length && parts[parts.length - 1] !== '\n') parts.push('\n');
    node.childNodes.forEach(walk);
    if (isBlock && parts.length && parts[parts.length - 1] !== '\n') parts.push('\n');
  }
  walk(bubble);
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

/** 克隆 bubble 并清理 UI 元素，返回可用于剪贴板的干净 HTML */
function bubbleToHtml(bubble) {
  const clone = bubble.cloneNode(true);
  clone.querySelectorAll('.msg-copy-btn, .math-copy-btn, .table-copy-btn').forEach(el => el.remove());
  // 公式块 → 替换为 LaTeX 源码
  clone.querySelectorAll('.math-block').forEach(el => {
    const latex = el.getAttribute('data-latex') || '';
    const p = document.createElement('p');
    p.textContent = latex;
    el.replaceWith(p);
  });
  clone.querySelectorAll('.math-inline').forEach(el => {
    const latex = el.getAttribute('data-latex') || '';
    el.replaceWith(document.createTextNode(latex));
  });
  // 给 table 加上 border 属性确保粘贴时有边框
  clone.querySelectorAll('table').forEach(t => {
    t.setAttribute('border', '1');
    t.setAttribute('cellpadding', '6');
    t.setAttribute('cellspacing', '0');
    t.style.borderCollapse = 'collapse';
    t.style.border = '1px solid #999';
  });
  return clone.innerHTML;
}

/* Copy handler: prepend list markers (bullets/numbers) to clipboard text */
document.addEventListener('copy', e => {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const bubble = range.commonAncestorContainer.parentElement?.closest?.('.msg.bot .bubble')
    || (range.commonAncestorContainer.nodeType === 1
      && range.commonAncestorContainer.closest?.('.msg.bot .bubble'));
  if (!bubble) return;

  // Build ordered list index map
  const olMap = new Map();
  bubble.querySelectorAll('ol > li').forEach(li => {
    const ol = li.parentElement;
    if (!olMap.has(ol)) olMap.set(ol, []);
    olMap.get(ol).push(li);
  });

  function getMarker(li) {
    const parent = li.parentElement;
    if (parent.tagName === 'OL') {
      const idx = (olMap.get(parent) || []).indexOf(li) + 1;
      return idx + '. ';
    }
    return '- ';
  }

  // Tag the first text node of each selected LI with a marker prefix
  bubble.querySelectorAll('li').forEach(li => {
    if (!range.intersectsNode(li)) return;
    const tw = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
    const first = tw.nextNode();
    if (first && first.textContent.trim()) first._listPrefix = getMarker(li);
  });

  // Build final text — check if selection truly covers the entire bubble
  const isFullCopy = (() => {
    const full = document.createRange();
    full.selectNodeContents(bubble);
    if (!bubble.textContent.trim()) return true;
    return range.compareBoundaryPoints(Range.START_TO_START, full) <= 0
      && range.compareBoundaryPoints(Range.END_TO_END, full) >= 0;
  })();

  if (isFullCopy) {
    const lines = [];
    function walk(node) {
      if (node.nodeType === 3) {
        lines.push({ text: node.textContent, prefix: node._listPrefix || '' });
        return;
      }
      if (node.nodeType !== 1) return;
      if (['SCRIPT', 'STYLE'].includes(node.tagName)) return;
      if (node.classList?.contains('msg-copy-btn') || node.classList?.contains('math-copy-btn') || node.classList?.contains('table-copy-btn')) return;
      if (node.tagName === 'BR') { lines.push({ text: '\n', prefix: '' }); return; }
      if (node.classList?.contains('math-block')) {
        lines.push({ text: node.getAttribute('data-latex') || '', prefix: '' });
        return;
      }
      if (node.classList?.contains('math-inline')) {
        lines.push({ text: node.getAttribute('data-latex') || '', prefix: '' });
        return;
      }
      // Table row → cells joined by tabs, rows by newlines
      if (node.tagName === 'TR') {
        if (lines.length && lines[lines.length - 1].text !== '\n') lines.push({ text: '\n', prefix: '' });
        const cells = Array.from(node.children).filter(c => c.tagName === 'TD' || c.tagName === 'TH');
        cells.forEach((cell, i) => {
          if (i > 0) lines.push({ text: '\t', prefix: '' });
          walk(cell);
        });
        if (lines.length && lines[lines.length - 1].text !== '\n') lines.push({ text: '\n', prefix: '' });
        return;
      }
      if (node.tagName === 'TD' || node.tagName === 'TH') {
        node.childNodes.forEach(walk);
        return;
      }
      const blockTags = ['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TABLE', 'THEAD', 'TBODY', 'TFOOT'];
      if (blockTags.includes(node.tagName) && lines.length && lines[lines.length - 1].text !== '\n') {
        lines.push({ text: '\n', prefix: '' });
      }
      node.childNodes.forEach(walk);
      if (blockTags.includes(node.tagName) && lines.length && lines[lines.length - 1].text !== '\n') {
        lines.push({ text: '\n', prefix: '' });
      }
    }
    walk(bubble);
    let result = lines.map(l => l.prefix + l.text).join('');
    result = result.replace(/\n{3,}/g, '\n\n').trim();
    e.clipboardData.setData('text/plain', result);
    e.preventDefault();
  } else {
    // Partial selection — use original nodes with _listPrefix
    const parts = [];
    const tw = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tw.nextNode())) {
      if (range.intersectsNode(n)) parts.push((n._listPrefix || '') + n.textContent);
    }
    e.clipboardData.setData('text/plain', parts.join(''));
    e.preventDefault();
  }

  // Cleanup _listPrefix markers to avoid stale data on next copy
  bubble.querySelectorAll('li').forEach(li => {
    const tw = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
    const first = tw.nextNode();
    if (first) delete first._listPrefix;
  });
});

initApp();
