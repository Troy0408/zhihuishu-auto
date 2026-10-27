/**
 * 后台 Service Worker（MV3，v0.4.3）
 * 职责：
 *  1. 首次安装时写入默认配置
 *  2. 给工具栏图标显示开关状态
 *  3. 维护与内容脚本的长连接（zhs-keepalive），每 1.5s 发送一次不受后台标签页节流影响的心跳，
 *     驱动后台标签页按 1x 真实时间触发学习时长计时器与完课状态检测
 */

const DEFAULTS = {
  enabled: true,
  mute: true,
  speed: 1,
  autoNext: true,
  skipCompleted: true,
  keepPlaying: true,
  quiz: true,
  answerStrategy: 'first', // first | random
  showBadge: false,
  debug: true,
};

const activePorts = new Set();
let heartbeatTimer = null;

function ensureHeartbeat() {
  if (activePorts.size > 0 && !heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      const ts = Date.now();
      for (const port of [...activePorts]) {
        try {
          port.postMessage({ type: 'heartbeat', ts });
        } catch (e) {
          activePorts.delete(port);
        }
      }
      if (activePorts.size === 0 && heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }, 1500);
  } else if (activePorts.size === 0 && heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== 'zhs-keepalive') return;
  activePorts.add(port);
  ensureHeartbeat();

  port.onMessage.addListener((msg) => {
    if (msg && msg.type === 'ping') {
      try {
        port.postMessage({ type: 'heartbeat', ts: Date.now() });
      } catch (e) {}
    }
  });

  port.onDisconnect.addListener(() => {
    activePorts.delete(port);
    ensureHeartbeat();
  });
});

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) {
    await chrome.storage.local.set({ settings: DEFAULTS });
  }
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(refreshBadge);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) refreshBadge();
});

async function refreshBadge() {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    const on = settings ? settings.enabled !== false : true;
    await chrome.action.setBadgeText({ text: on ? 'ON' : 'OFF' });
    await chrome.action.setBadgeBackgroundColor({ color: on ? '#2f9e44' : '#868e96' });
  } catch (e) {
    // 忽略
  }
}
