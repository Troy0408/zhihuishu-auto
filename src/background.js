/**
 * 后台 Service Worker（MV3）
 * 只做三件事：
 *  1. 首次安装时写入默认配置
 *  2. 给工具栏图标显示开关状态
 *  3. 转发“设置已变更”的消息（内容脚本自己也会监听 storage 变化）
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
