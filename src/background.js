/**
 * 后台 Service Worker（MV3，v0.5.0）
 * 职责：
 *  1. 首次安装时写入默认配置
 *  2. 给工具栏图标显示开关状态
 *  3. 维护与内容脚本的长连接（zhs-keepalive），每 1.5s 发送一次不受后台标签页节流影响的心跳，
 *     驱动后台标签页按 1x 真实时间触发学习时长计时器与完课状态检测
 *  4. 为安全验证（网易易盾 3D 立体字点选验证码）提供跨域背景图读取与 AI 视觉大模型（OpenAI 兼容接口）调用服务
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
  // 安全验证自动过（AI 视觉识别）配置
  autoCaptcha: true,
  aiProvider: 'siliconflow', // siliconflow | deepseek | dashscope | zhipu | openai_custom
  aiBaseUrl: 'https://api.siliconflow.cn/v1',
  aiApiKey: '',
  aiModel: 'Qwen/Qwen2.5-VL-72B-Instruct',
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
  } else {
    await chrome.storage.local.set({ settings: { ...DEFAULTS, ...settings } });
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

// ==================== 易盾安全验证：图片拉取与 AI 视觉坐标识别 ====================

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fetchImageAsDataUrl(imageUrl) {
  if (!imageUrl) throw new Error('图片地址为空');
  if (imageUrl.startsWith('data:image/')) return imageUrl;
  const resp = await fetch(imageUrl, { credentials: 'omit', cache: 'no-store' });
  if (!resp.ok) {
    throw new Error(`拉取验证码图片失败 (${resp.status})`);
  }
  const contentType = resp.headers.get('content-type') || 'image/jpeg';
  const buf = await resp.arrayBuffer();
  const b64 = arrayBufferToBase64(buf);
  return `data:${contentType};base64,${b64}`;
}

function normalizeEndpoint(baseUrl) {
  const raw = String(baseUrl || 'https://api.siliconflow.cn/v1').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(raw)) return raw;
  if (/\/v\d+$/i.test(raw) || /\/compatible-mode\/v\d+$/i.test(raw)) {
    return `${raw}/chat/completions`;
  }
  return `${raw}/chat/completions`;
}

/**
 * 解析大模型返回的坐标文本，兼容 JSON（含 x/y 或 x_norm/y_norm 或 bbox）及纯数字。
 */
function parsePointFromAiText(content, width = 320, height = 160) {
  if (!content) return null;
  const text = String(content).trim();

  // 1) 优先提取 JSON 对象
  const jsonMatch = text.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      // 支持 bbox: [xmin, ymin, xmax, ymax]
      if (Array.isArray(obj.bbox) && obj.bbox.length === 4) {
        let cx = (Number(obj.bbox[0]) + Number(obj.bbox[2])) / 2;
        let cy = (Number(obj.bbox[1]) + Number(obj.bbox[3])) / 2;
        if (cx <= 1 && cy <= 1) {
          cx *= width;
          cy *= height;
        } else if (cx > width || cy > height) {
          cx = (cx / 1000) * width;
          cy = (cy / 1000) * height;
        }
        return clampCoord(cx, cy, width, height);
      }

      let x = Number(obj.x ?? obj.left ?? obj.cx);
      let y = Number(obj.y ?? obj.top ?? obj.cy);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        // 判断是像素坐标(320x160)、归一化(0~1)还是千分比(0~1000)
        if (x > 0 && x <= 1 && y > 0 && y <= 1) {
          x *= width;
          y *= height;
        } else if (x > width + 10 || y > height + 10) {
          x = (x / 1000) * width;
          y = (y / 1000) * height;
        }
        return clampCoord(x, y, width, height);
      }
    } catch (e) {}
  }

  // 2) 兜底正则提取两个数字 (x, y)
  const nums = [...text.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  if (nums.length >= 2) {
    let [x, y] = nums;
    if (x > 0 && x <= 1 && y > 0 && y <= 1) {
      x *= width;
      y *= height;
    } else if (x > width + 10 || y > height + 10) {
      x = (x / 1000) * width;
      y = (y / 1000) * height;
    }
    return clampCoord(x, y, width, height);
  }
  return null;
}

function clampCoord(x, y, width = 320, height = 160) {
  const cx = Math.max(8, Math.min(width - 8, Math.round(x)));
  const cy = Math.max(8, Math.min(height - 8, Math.round(y)));
  return { x: cx, y: cy };
}

async function solveSpaceCaptchaByAI({ imageUrl, imageDataUrl, promptText, width = 320, height = 160, overrideConfig }) {
  const { settings } = await chrome.storage.local.get('settings');
  const cfg = { ...DEFAULTS, ...(settings || {}), ...(overrideConfig || {}) };

  const apiKey = String(cfg.aiApiKey || '').trim();
  if (!apiKey) {
    return {
      ok: false,
      error: '尚未配置 AI API Key，请点击浏览器右上角插件图标填入 API Key',
    };
  }

  const endpoint = normalizeEndpoint(cfg.aiBaseUrl);
  const model = String(cfg.aiModel || 'Qwen/Qwen2.5-VL-72B-Instruct').trim();
  const dataUrl = imageDataUrl || (await fetchImageAsDataUrl(imageUrl));

  const systemPrompt =
    '你是一个高精度的验证码视觉定位助手。用户会给你一张尺寸为 320x160 像素的 3D 立体字符验证码图片（左上角为原点 (0,0)，右下角为 (320,160)，x 范围 0~320，y 范围 0~160）以及一句点击指令（如“请点击灰色大写U”）。' +
    '请仔细辨别图中每个立体字符的【颜色】（灰色/绿色/蓝色/紫色/黄色/红色等）、【大小写】（如大写U顶部平齐无右竖脚，小写u或a带弯钩或竖脚）和【形状】，找到唯一符合指令的目标字符的中心点像素坐标。' +
    '只输出一行严格的 JSON，格式为：{"x": 整数, "y": 整数, "reason": "简短说明"}，不要输出任何多余内容。';

  const userPrompt =
    `图片尺寸为宽 ${width} 像素、高 ${height} 像素（左上角为 (0,0)，右下角为 (${width},${height})）。\n` +
    `验证指令：「${promptText || '请点击目标字符'}」\n` +
    `注意：指令可能是按颜色/大小写找字符（如“请点击灰色大写U”），也可能是按 3D 空间朝向/形状关系找字符（如“请点击与红色小写r朝向一样的数字7”——观察立体字符正面的透视朝向是朝左偏还是朝右偏、俯视还是仰视）。\n` +
    `请找出符合「${promptText}」的唯一目标 3D 字符的中心像素坐标 (x, y)，其中 0 <= x <= ${width}，0 <= y <= ${height}。只返回一行 JSON：{"x": 整数, "y": 整数}`;

  const isDeepSeek = /deepseek\.com/i.test(endpoint) || /^deepseek/i.test(model);
  const body = {
    model,
    temperature: 0.0,
    max_tokens: 1024,
    ...(isDeepSeek ? { thinking: { type: 'disabled' } } : {}),
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: dataUrl },
          },
          {
            type: 'text',
            text: userPrompt,
          },
        ],
      },
    ],
  };

  let resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  // 若部分接口不支持 thinking 字段返回 400，去掉 thinking 重试一次
  if (!resp.ok && resp.status === 400 && body.thinking) {
    delete body.thinking;
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  }

  const rawText = await resp.text();
  if (!resp.ok) {
    let errDetail = rawText.slice(0, 200);
    try {
      const errJson = JSON.parse(rawText);
      errDetail = (errJson.error && (errJson.error.message || errJson.error.code)) || errDetail;
    } catch (e) {}
    return {
      ok: false,
      error: `API 请求失败 (${resp.status}): ${errDetail}`,
    };
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    return { ok: false, error: 'API 返回非 JSON 格式' };
  }

  const msgObj = (data && data.choices && data.choices[0] && data.choices[0].message) || {};
  const content = String(msgObj.content || '').trim();
  const reasoning = String(msgObj.reasoning_content || '').trim();
  const combinedText = content || reasoning;

  let pt = parsePointFromAiText(content, width, height);
  if (!pt && reasoning) {
    // 若 content 为空（被 thinking 占满），从 reasoning_content 末尾提取最后出现的坐标
    const jsonMatches = [...reasoning.matchAll(/\{[^{}]*"x"\s*:\s*\d+[^{}]*"y"\s*:\s*\d+[^{}]*\}/g)];
    if (jsonMatches.length) {
      pt = parsePointFromAiText(jsonMatches[jsonMatches.length - 1][0], width, height);
    }
    if (!pt) {
      const coordMatches = [...reasoning.matchAll(/\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)/g)];
      if (coordMatches.length) {
        const last = coordMatches[coordMatches.length - 1];
        pt = clampCoord(Number(last[1]), Number(last[2]), width, height);
      }
    }
  }

  if (!pt) {
    return {
      ok: false,
      error: `未能从 AI 回复中解析出坐标: ${String(combinedText || '(空回复)').slice(0, 80)}`,
      raw: combinedText,
    };
  }

  return {
    ok: true,
    x: pt.x,
    y: pt.y,
    raw: content || reasoning.slice(-160),
    model,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'ZHS_SOLVE_CAPTCHA') {
    solveSpaceCaptchaByAI(msg.payload || {})
      .then((res) => sendResponse(res))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: String(err && err.message ? err.message : err),
        })
      );
    return true; // 异步响应
  }

  if (msg.type === 'ZHS_TEST_AI_KEY') {
    const p = msg.payload || {};
    const endpoint = normalizeEndpoint(p.aiBaseUrl);
    const apiKey = String(p.aiApiKey || '').trim();
    const model = String(p.aiModel || '').trim();
    if (!apiKey) {
      sendResponse({ ok: false, error: '请先填写 API Key' });
      return false;
    }
    const isDeepSeek = /deepseek\.com/i.test(endpoint) || /^deepseek/i.test(model);
    // 使用一张 1x1 最小透明 PNG 测试该模型是否支持 image_url 多模态输入且能正常返回 content
    const tinyPng =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        temperature: 0,
        ...(isDeepSeek ? { thinking: { type: 'disabled' } } : {}),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: tinyPng } },
              { type: 'text', text: '请直接回复 {"x":160,"y":80}' },
            ],
          },
        ],
      }),
    })
      .then(async (r) => {
        const t = await r.text();
        if (!r.ok) {
          let detail = t.slice(0, 160);
          try {
            const j = JSON.parse(t);
            detail = (j.error && (j.error.message || j.error.code)) || detail;
          } catch (e) {}
          sendResponse({ ok: false, error: `HTTP ${r.status}: ${detail}` });
          return;
        }
        sendResponse({ ok: true });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  return false;
});
