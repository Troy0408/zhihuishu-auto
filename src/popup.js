/**
 * 扩展弹窗：开关 + 选项 + 当前页面状态 + 统计。
 */

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
};

const FIELDS = ['enabled', 'mute', 'autoNext', 'skipCompleted', 'keepPlaying', 'quiz', 'showBadge'];
const EMPTY_STATS = { quizAnswered: 0, nextClicked: 0, resumeClicked: 0, since: Date.now() };

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
  for (const key of FIELDS) {
    const el = $(key);
    if (el) el.checked = settings[key] !== false;
  }
  const sel = $('answerStrategy');
  if (sel) sel.value = settings.answerStrategy || 'first';
}

function readForm() {
  const next = { ...settings };
  for (const key of FIELDS) {
    const el = $(key);
    if (el) next[key] = el.checked;
  }
  const sel = $('answerStrategy');
  if (sel) next.answerStrategy = sel.value;
  return next;
}

function persist() {
  settings = readForm();
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

async function init() {
  try {
    const { settings: s } = await chrome.storage.local.get('settings');
    settings = { ...DEFAULTS, ...(s || {}) };
  } catch (e) {}

  render();
  await loadStats();
  await refreshStatus();

  for (const key of [...FIELDS, 'answerStrategy']) {
    const el = $(key);
    if (!el) continue;
    el.addEventListener('change', persist);
  }

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
