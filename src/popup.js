/**
 * 扩展弹窗：开关 + 选项 + AI 安全验证配置 + 当前页面状态 + 统计。
 */

const PROVIDER_PRESETS = {
  siliconflow: {
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-VL-72B-Instruct',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
  },
  dashscope: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-max',
  },
  zhipu: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4v-flash',
  },
};

const DEFAULTS = {
  enabled: true,
  mute: true,
  speed: 1,
  autoNext: true,
  skipCompleted: true,
  keepPlaying: true,
  quiz: true,
  answerStrategy: 'first',
  showBadge: false,
  debug: true,
  autoCaptcha: true,
  aiProvider: 'siliconflow',
  aiBaseUrl: 'https://api.siliconflow.cn/v1',
  aiApiKey: '',
  aiModel: 'Qwen/Qwen2.5-VL-72B-Instruct',
};

const CHECKBOX_FIELDS = [
  'enabled',
  'mute',
  'autoNext',
  'skipCompleted',
  'keepPlaying',
  'quiz',
  'showBadge',
  'autoCaptcha',
];
const EMPTY_STATS = {
  quizAnswered: 0,
  captchaSolved: 0,
  nextClicked: 0,
  resumeClicked: 0,
  since: Date.now(),
};

let settings = { ...DEFAULTS };
let refreshTimer = 0;

const $ = (id) => document.getElementById(id);

function fmt(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function render() {
  for (const key of CHECKBOX_FIELDS) {
    const el = $(key);
    if (el) el.checked = settings[key] !== false;
  }
  const sel = $('answerStrategy');
  if (sel) sel.value = settings.answerStrategy || 'first';

  const prov = $('aiProvider');
  if (prov) prov.value = settings.aiProvider || 'siliconflow';
  const base = $('aiBaseUrl');
  if (base) base.value = settings.aiBaseUrl || DEFAULTS.aiBaseUrl;
  const model = $('aiModel');
  if (model) model.value = settings.aiModel || DEFAULTS.aiModel;
  const key = $('aiApiKey');
  if (key) key.value = settings.aiApiKey || '';

  const wrap = $('aiConfigWrap');
  if (wrap) {
    wrap.style.display = settings.autoCaptcha !== false ? 'flex' : 'none';
  }
}

function readForm() {
  const next = { ...settings };
  for (const key of CHECKBOX_FIELDS) {
    const el = $(key);
    if (el) next[key] = el.checked;
  }
  const sel = $('answerStrategy');
  if (sel) next.answerStrategy = sel.value;

  const prov = $('aiProvider');
  if (prov) next.aiProvider = prov.value;
  const base = $('aiBaseUrl');
  if (base) next.aiBaseUrl = base.value.trim();
  const model = $('aiModel');
  if (model) next.aiModel = model.value.trim();
  const key = $('aiApiKey');
  if (key) next.aiApiKey = key.value.trim();

  return next;
}

function persist() {
  settings = readForm();
  const wrap = $('aiConfigWrap');
  if (wrap) {
    wrap.style.display = settings.autoCaptcha !== false ? 'flex' : 'none';
  }
  try {
    chrome.storage.local.set({ settings });
  } catch (e) {}
}

function setStatus(kind, text) {
  const dot = $('dot');
  const t = $('statusText');
  if (!dot || !t) return;
  dot.className = `dot ${kind}`;
  t.textContent = text;
  t.title = text;
}

function renderStats(stats) {
  $('quizAnswered').textContent = stats.quizAnswered || 0;
  if ($('captchaSolved')) $('captchaSolved').textContent = stats.captchaSolved || 0;
  $('nextClicked').textContent = stats.nextClicked || 0;
  $('resumeClicked').textContent = stats.resumeClicked || 0;
}

function renderStatus(resp) {
  if (!resp || !resp.ok) {
    setStatus('warn', '当前标签页不是智慧树课程页');
    return;
  }
  const progTag = resp.curDone
    ? ' · 已完成✓'
    : typeof resp.curPercentage === 'number'
      ? ` · 结算进度 ${resp.curPercentage}%${resp.replaying ? `(重播第${resp.replayCount || 1}次)` : ''}`
      : '';
  if (!resp.enabled) {
    setStatus('off', '总开关已关闭');
  } else if (resp.blocked) {
    setStatus('off', '检测到平台拦截，已停止；关闭插件并重新进入页面');
  } else if (resp.captchaOpen) {
    const tip = resp.captchaErrorHint
      ? `安全验证：${resp.captchaErrorHint}`
      : `正在自动识别安全验证（${resp.captchaPrompt || '点选字符'}）…`;
    setStatus('warn', tip);
  } else if (!resp.hasVideo) {
    setStatus('warn', '已连接页面，但还没找到视频（请进入课程并点播放）');
  } else if (resp.quizOpen) {
    setStatus('warn', `检测到弹题，正在作答… ${fmt(resp.time)} / ${fmt(resp.duration)}${progTag}`);
  } else if (resp.paused) {
    setStatus('warn', `视频暂停中 ${fmt(resp.time)} / ${fmt(resp.duration)}${progTag}`);
  } else {
    setStatus('on', `播放中 ${fmt(resp.time)} / ${fmt(resp.duration)}${progTag}`);
  }
  if (resp.stats) renderStats(resp.stats);
}

async function refreshStatus() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) {
      setStatus('off', '没有活动标签页');
      return;
    }
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'ZHS_GET_STATUS' });
    renderStatus(resp);
  } catch (e) {
    setStatus('warn', '当前标签页不是智慧树课程页');
  }
}

async function loadStats() {
  try {
    const { stats } = await chrome.storage.local.get('stats');
    renderStats({ ...EMPTY_STATS, ...(stats || {}) });
  } catch (e) {}
}

function setAiHint(text, cls = '') {
  const hint = $('aiHint');
  if (!hint) return;
  hint.textContent = text;
  hint.className = `ai-hint ${cls}`.trim();
}

async function init() {
  try {
    const { settings: s } = await chrome.storage.local.get('settings');
    settings = { ...DEFAULTS, ...(s || {}) };
  } catch (e) {}

  render();
  await loadStats();
  await refreshStatus();

  for (const key of [...CHECKBOX_FIELDS, 'answerStrategy']) {
    const el = $(key);
    if (!el) continue;
    el.addEventListener('change', persist);
  }

  $('aiProvider').addEventListener('change', (ev) => {
    const preset = PROVIDER_PRESETS[ev.target.value];
    if (preset) {
      $('aiBaseUrl').value = preset.baseUrl;
      $('aiModel').value = preset.model;
    }
    persist();
  });

  for (const id of ['aiBaseUrl', 'aiModel', 'aiApiKey']) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('input', persist);
    el.addEventListener('change', persist);
  }

  $('testAi').addEventListener('click', async () => {
    persist();
    const btn = $('testAi');
    btn.disabled = true;
    btn.textContent = '测试中…';
    setAiHint('正在测试视觉模型连通性…');
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'ZHS_TEST_AI_KEY',
        payload: {
          aiBaseUrl: settings.aiBaseUrl,
          aiApiKey: settings.aiApiKey,
          aiModel: settings.aiModel,
        },
      });
      if (res && res.ok) {
        setAiHint(`✓ 连接成功！模型 ${settings.aiModel} 支持图像识别`, 'ok');
      } else {
        setAiHint(`✗ 失败：${(res && res.error) || '未知错误'}`, 'err');
      }
    } catch (e) {
      setAiHint(`✗ 调用异常：${String(e && e.message ? e.message : e)}`, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '测试';
    }
  });

  $('scan').addEventListener('click', async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      if (tab && tab.id) await chrome.tabs.sendMessage(tab.id, { type: 'ZHS_SCAN_NOW' });
    } catch (e) {}
    await refreshStatus();
  });

  $('reset').addEventListener('click', async () => {
    try {
      await chrome.storage.local.set({ stats: { ...EMPTY_STATS, since: Date.now() } });
    } catch (e) {}
    renderStats(EMPTY_STATS);
  });

  refreshTimer = setInterval(refreshStatus, 1500);
  window.addEventListener('unload', () => clearInterval(refreshTimer));
}

init();
