/**
 * 智慧树共享课自动刷课 —— 内容脚本主体（v0.4.2）。
 *
 * 核心机制：
 *   - 通过同步桥接调用 src/main-world.js 中已接管的 stuStudy Vue 实例（vm）：
 *     1) 弹题作答：直接调用 vm.topicClickQot(opt, 1) 并选取 result===1 的正确项（兼容单选/多选/判断/多题连弹）
 *     2) 关闭弹题：直接调用 vm.closeTest({ isTrusted: true })，彻底避开合成 DOM 点击导致的 notTrustScript() 拦截
 *     3) 未完成检测与重播：视频播到底时检查当前小节是否真正出现完成对勾（isStudiedLesson===1 / .time_icofinish）；
 *        若未完成（如卡在 48%/61%/74%），自动从 00:00 重新播放当前视频，直到拿到完成对勾后再切换到下一集
 *     4) 后台防节流双保险：
 *        - 通过与 MV3 后台 Service Worker 建立长连接（zhs-keepalive）接收每 2s 一次的不受后台节流影响的心跳
 *        - 结合真实挂钟时间（Wall-Clock）多步补偿 totalStudyTimeFun 与 learningTimeRecord，彻底解决后台刷课进度折半问题
 *     5) 严格按序补刷：若检测到当前小节之前存在未完成小节（如已跳到 3.3 但 3.1/3.2 仍未出对勾），自动切回最早未完成小节逐个刷满
 */
(() => {
  'use strict';
  if (window.__ZHS_APP__) return;
  window.__ZHS_APP__ = true;

  const CFG = window.ZHS_CONFIG || {};
  const SEL = CFG.selectors || {};
  const TXT = CFG.text || {};

  const REQ_EVENT = '__zhs_mw_req__';
  const REQ_ATTR = 'data-zhs-req';
  const RES_ATTR = 'data-zhs-res';

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

  const S = {
    settings: { ...DEFAULTS },
    stats: { quizAnswered: 0, nextClicked: 0, resumeClicked: 0, since: Date.now() },
    video: null,
    boundVideo: null,
    quizOpen: false,
    quizBusy: false,
    quiz: { q: '', clicks: 0 },
    advancePending: false,
    advanceTimer: 0,
    nextLockUntil: 0,
    lastHref: location.href,
    endedSrc: '',
    lastTime: 0,
    lastAdvanceAt: Date.now(),
    lastTimeupdateSyncAt: 0,
    replayingVideoId: '',
    replayCount: 0,
    replayDoneAdvancePending: false,
    resumeAt: 0,
    startAt: Date.now(),
    jumpTried: false,
    blocked: false,
    badge: null,
  };

  // ---------- 基础工具 ----------

  const now = () => Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const toArr = (v) => (Array.isArray(v) ? v : v ? [v] : []);

  function log(...args) {
    if (S.settings.debug) console.log('%c[ZHS]', 'color:#2f9e44;font-weight:700', ...args);
  }
  function warn(...args) {
    console.warn('[ZHS]', ...args);
  }
  function textOf(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function isVisible(el) {
    if (!el || !el.isConnected || el.nodeType !== 1) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    return true;
  }

  /**
   * 同步调用 MAIN world 的 Vue 桥接命令。
   */
  function callMainWorld(cmd, payload = {}) {
    const host = document.head || document.documentElement;
    if (!host) return null;
    try {
      host.setAttribute(REQ_ATTR, JSON.stringify({ cmd, payload }));
      window.dispatchEvent(new Event(REQ_EVENT));
      const raw = host.getAttribute(RES_ATTR);
      if (raw) {
        host.removeAttribute(RES_ATTR);
        return JSON.parse(raw);
      }
    } catch (e) {}
    return null;
  }

  /**
   * 兜底合成点击（仅当 Vue 实例不可用时使用）。
   */
  function clickEl(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest('#container')) return false;
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2) || 100;
    const y = Math.round(r.top + r.height / 2) || 100;
    const mouseInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      buttons: 1,
    };
    try { el.dispatchEvent(new MouseEvent('mousedown', mouseInit)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mouseup', { ...mouseInit, buttons: 0 })); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('click', { ...mouseInit, buttons: 0 })); } catch (e) {}
    if (S.settings.debug) {
      log(`DOM 兜底点击 <${String(el.tagName).toLowerCase()}> "${textOf(el).slice(0, 24)}"`);
    }
    return true;
  }

  function queryFirst(selectors, root = document, mustVisible = true) {
    for (const sel of toArr(selectors)) {
      let nodes = [];
      try { nodes = root.querySelectorAll(sel); } catch (e) { continue; }
      for (const el of nodes) {
        if (!mustVisible || isVisible(el)) return el;
      }
    }
    return null;
  }

  // ---------- 配置 / 统计 ----------

  async function loadState() {
    try {
      const got = await chrome.storage.local.get(['settings', 'stats']);
      S.settings = { ...DEFAULTS, ...(got.settings || {}) };
      if (got.stats) S.stats = { ...S.stats, ...got.stats };
    } catch (e) {
      warn('读取配置失败，使用默认值', e);
    }
  }

  let saveTimer = 0;
  function saveStats() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { chrome.storage.local.set({ stats: S.stats }); } catch (e) {}
    }, 800);
  }

  function bindStorage() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.settings) return;
        S.settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
        log('设置已更新', S.settings);
      });
    } catch (e) {}
  }

  // ---------- 章节完成度判定 ----------

  function chapterItems() {
    for (const sel of toArr(SEL.chapterList)) {
      let nodes = [];
      try { nodes = [...document.querySelectorAll(sel)]; } catch (e) { continue; }
      if (nodes.length) return nodes;
    }
    return [];
  }

  function isActiveChapter(el) {
    return el.classList.contains(SEL.chapterActiveClass || 'current_play');
  }

  function isDoneChapter(el) {
    for (const sel of toArr(SEL.chapterDone)) {
      try { if (el.querySelector(sel)) return true; } catch (e) {}
    }
    return false;
  }

  function isCurrentChapterDoneInDom() {
    const items = chapterItems();
    const active = items.find(isActiveChapter);
    return active ? isDoneChapter(active) : false;
  }

  /**
   * 判断当前正在播放的小节是否真正结算为“已完成”（出现对勾 .time_icofinish 或 Vue isStudiedLesson === 1）。
   */
  function isCurrentLessonDone(st) {
    if (st && st.hasVm) {
      return Boolean(st.curDone);
    }
    return isCurrentChapterDoneInDom();
  }

  // ---------- 视频控制 ----------

  function ensureVideo() {
    if (S.video && S.video.isConnected) return S.video;
    for (const sel of toArr(SEL.video)) {
      let v = null;
      try { v = document.querySelector(sel); } catch (e) {}
      if (v) {
        S.video = v;
        S.boundVideo = null;
        S.lastTime = v.currentTime || 0;
        S.lastAdvanceAt = now();
        return v;
      }
    }
    S.video = null;
    return null;
  }

  function bindVideo(v) {
    if (S.boundVideo === v) return;
    S.boundVideo = v;

    v.addEventListener('ended', () => {
      S.endedSrc = v.currentSrc || v.src || '';
      scheduleEndCheck(rand(2800, 4800));
    });

    v.addEventListener('pause', () => {
      if (!S.settings.keepPlaying || !S.settings.enabled) return;
      setTimeout(() => {
        if (!S.video || S.video !== v) return;
        if (!v.paused) return;
        // 如果是在视频结尾处暂停（相当于播到底），走结尾完成度检测
        if (v.ended || (v.duration > 10 && v.currentTime >= v.duration - 1.5)) {
          scheduleEndCheck(rand(2000, 3500));
          return;
        }
        const st = callMainWorld('getState');
        if (S.quizOpen || (st && (st.testDialog || st.faceVisible)) || findQuizDialog()) return;
        tryPlay(v);
      }, 1200);
    });

    v.addEventListener('timeupdate', () => {
      S.lastTime = v.currentTime;
      S.lastAdvanceAt = now();
      // 利用媒体线程触发的 timeupdate 驱动后台标签页的计时器补偿（每秒最多检查一次）
      const t = now();
      if (S.settings.enabled && t - S.lastTimeupdateSyncAt >= 1000) {
        S.lastTimeupdateSyncAt = t;
        callMainWorld('ensurePlay');
        checkReplayCompletedMidway();
      }
    });

    v.addEventListener('waiting', () => {
      setTimeout(() => {
        if (S.video === v && v.paused && !S.quizOpen) tryPlay(v);
      }, 3000);
    });

    v.addEventListener('error', () => warn('video error', v.error));
    log('已绑定 video', v.currentSrc || v.src || '');
  }

  function tryPlay(v) {
    if (!v) return;
    if (S.settings.mute && !v.muted) {
      try { v.muted = true; } catch (e) {}
    }
    try {
      callMainWorld('ensurePlay');
    } catch (e) {}
    try {
      if (v.paused && !v.ended) {
        const p = v.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch (e) {}
  }

  function checkStall(v) {
    if (!v || v.paused || v.ended) return;
    const t = v.currentTime || 0;
    if (t > S.lastTime + 0.05) {
      S.lastTime = t;
      S.lastAdvanceAt = now();
      return;
    }
    const stuckFor = now() - S.lastAdvanceAt;
    if (stuckFor < 12000) return;

    S.lastAdvanceAt = now();
    warn(`视频 ${Math.round(stuckFor / 1000)}s 未前进，尝试恢复`);
    tryPlay(v);
    if (stuckFor > 25000) {
      try { v.currentTime = Math.min((v.duration || 1e9) - 0.5, t + 1); } catch (e) {}
    }
  }

  function clickResumePrompt() {
    if (!S.settings.keepPlaying) return false;
    if (now() - S.resumeAt < 2500) return false;
    S.resumeAt = now();

    const closed = callMainWorld('closeOtherDialogs');
    if (closed && Array.isArray(closed.closed) && closed.closed.length) {
      S.stats.resumeClicked++;
      saveStats();
      log('已通过 Vue 关闭拦截弹窗：', closed.closed.join(', '));
      return true;
    }

    const re = TXT.resumeRe || /^(继续观看|继续播放|继续学习|我知道了)$/;
    for (const el of document.querySelectorAll('button, a, [role="button"], [class*="btn"], [class*="button"]')) {
      if (!isVisible(el)) continue;
      if (el.closest('#container')) continue;
      if (el.closest('#playTopic-dialog')) continue;
      const t = textOf(el);
      if (!t || t.length > 8) continue;
      if (re.test(t)) {
        clickEl(el);
        S.stats.resumeClicked++;
        saveStats();
        log('点击提示：', t);
        return true;
      }
    }
    return false;
  }

  // ---------- 弹题处理 ----------

  function findQuizDialog() {
    for (const sel of toArr(SEL.quizDialog)) {
      let nodes = [];
      try { nodes = document.querySelectorAll(sel); } catch (e) { continue; }
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        if (el.querySelector('li.topic-item, .topic-list')) return el;
      }
    }
    return null;
  }

  function isQuizActive() {
    const st = callMainWorld('getState');
    if (st && st.hasVm && st.testDialog) return true;
    return Boolean(findQuizDialog());
  }

  async function handleQuiz() {
    if (!S.settings.enabled || !S.settings.quiz) return;
    if (S.quizBusy) return;

    if (!isQuizActive()) {
      S.quizOpen = false;
      S.quiz = { q: '', clicks: 0 };
      return;
    }

    S.quizBusy = true;
    S.quizOpen = true;
    renderBadge();

    try {
      await sleep(rand(2500, 4800));

      for (let round = 0; round < 10; round++) {
        if (!S.settings.enabled || !S.settings.quiz) break;
        const st = callMainWorld('getState');
        const dialog = findQuizDialog();

        if ((!st || !st.testDialog) && !dialog) {
          break;
        }

        if (st && st.hasVm && st.testDialog) {
          if (st.allQuizChecked) {
            await sleep(rand(800, 1400));
            callMainWorld('closeQuiz');
            log('弹题已全部作答，安全关闭弹题窗口');
            await sleep(rand(700, 1200));
            if (S.video && S.settings.keepPlaying) tryPlay(S.video);
            break;
          }

          const ans = callMainWorld('answerQuiz', {
            strategy: S.settings.answerStrategy || 'first',
          });

          if (ans && ans.ok) {
            if (ans.answered) {
              S.stats.quizAnswered += ans.answered;
              saveStats();
              log(
                `弹题作答（第 ${ans.questionIndex || 1}/${ans.totalQuestions || 1} 题）：选 ${ans.label || '默认项'}`
              );
            }

            if (ans.done) {
              await sleep(rand(1200, 2000));
              callMainWorld('closeQuiz');
              log('已安全关闭弹题窗口');
              await sleep(rand(700, 1200));
              if (S.video && S.settings.keepPlaying) tryPlay(S.video);
              break;
            }

            await sleep(rand(1400, 2400));
            continue;
          }
        }

        if (!dialog || !dialog.isConnected || !isVisible(dialog)) break;
        const opts = [...dialog.querySelectorAll('li.topic-item, .topic-list li')].filter(isVisible);
        const ansEl = queryFirst(SEL.quizAnswer, dialog, false);
        const answered = Boolean(ansEl && isVisible(ansEl));

        if (!opts.length || answered || S.quiz.clicks >= 2) {
          await sleep(rand(800, 1300));
          const closeRes = callMainWorld('closeQuiz');
          if (!closeRes || !closeRes.ok) {
            const btn = dialog.querySelector('.dialog-footer .btn, .el-dialog__headerbtn');
            if (btn) clickEl(btn);
          }
          break;
        }

        const pick = opts[S.quiz.clicks % opts.length];
        S.quiz.clicks++;
        clickEl(pick);
        S.stats.quizAnswered++;
        saveStats();
        await sleep(rand(1200, 1800));
      }
    } catch (e) {
      warn('答题流程出错', e);
    } finally {
      S.quizBusy = false;
      S.quizOpen = isQuizActive();
      renderBadge();
    }
  }

  // ---------- 平台拦截检测 ----------

  function findBlockDialog() {
    try {
      for (const el of document.querySelectorAll('.el-message-box, .el-dialog__wrapper, .el-dialog')) {
        if (!isVisible(el)) continue;
        if (textOf(el).includes('异常脚本')) return el;
      }
    } catch (e) {}
    return null;
  }

  function checkBlocked() {
    if (S.blocked) return true;
    if (findBlockDialog()) {
      S.blocked = true;
      warn('检测到平台拦截弹窗，已暂停自动操作');
      return true;
    }
    return false;
  }

  // ---------- 视频结尾完成度检测、未完成重播与切集 ----------

  /**
   * 从头重新播放当前未完成的小节。
   */
  function replayCurrentVideo(st) {
    const vid = (st && st.lastViewVideoId) || 'current';
    if (S.replayingVideoId !== vid) {
      S.replayingVideoId = vid;
      S.replayCount = 1;
    } else {
      S.replayCount++;
    }
    S.replayDoneAdvancePending = false;
    S.nextLockUntil = now() + 8000;

    const pct = st && typeof st.curPercentage === 'number' ? `${st.curPercentage}%` : '未满';
    const name = (st && st.curName) || vid;
    log(`当前小节「${name}」播放完毕但尚未结算完成（进度 ${pct}，未出对勾），第 ${S.replayCount} 次从头重新播放直至完成`);

    const res = callMainWorld('replayCurrent');
    if (!res || !res.ok) {
      const v = ensureVideo();
      if (v) {
        try { v.currentTime = 0; } catch (e) {}
        tryPlay(v);
      }
    }
    S.stats.resumeClicked++;
    saveStats();
    renderBadge();
  }

  /**
   * 在重播补时长期间，一旦检测到当前小节已经变成“已完成”（出现对勾），
   * 先触发一次进度入库保存，随后自动切到下一集。
   */
  function checkReplayCompletedMidway() {
    if (!S.replayingVideoId || S.replayDoneAdvancePending) return;
    const st = callMainWorld('getState');
    if (st && st.lastViewVideoId && S.replayingVideoId !== 'current' && st.lastViewVideoId !== S.replayingVideoId) {
      S.replayingVideoId = '';
      S.replayCount = 0;
      return;
    }

    if (isCurrentLessonDone(st)) {
      S.replayDoneAdvancePending = true;
      callMainWorld('flushProgress');
      log(`重播补时长成功：当前小节「${(st && st.curName) || ''}」已显示完成对勾，即将切换下一集`);

      setTimeout(() => {
        S.replayingVideoId = '';
        S.replayCount = 0;
        S.replayDoneAdvancePending = false;
        renderBadge();
        if (S.settings.enabled && S.settings.autoNext) {
          advance();
        }
      }, rand(5000, 8000));
    }
  }

  function advance() {
    if (!S.settings.enabled || !S.settings.autoNext) return;
    if (now() < S.nextLockUntil) return;

    const st = callMainWorld('getState');
    // 切换下一集前再次确认当前集是否已完成；若仍未完成，改为从头重播当前集
    if (!isCurrentLessonDone(st)) {
      replayCurrentVideo(st);
      return;
    }

    callMainWorld('flushProgress');
    S.replayingVideoId = '';
    S.replayCount = 0;

    // 1) 优先通过 Vue 实例切换章节（若前面有遗漏未完成的节如 3.1/3.2，会自动切回最早未完成的那一节）
    const res = callMainWorld('switchLesson', {
      mode: 'next',
      skipCompleted: S.settings.skipCompleted !== false,
    });

    if (res && res.ok) {
      S.nextLockUntil = now() + 18000;
      S.stats.nextClicked++;
      saveStats();
      log('已切换到下一未完成节：', res.name);
      setTimeout(() => {
        if (S.settings.enabled && S.settings.keepPlaying && !S.quizOpen) {
          const v = ensureVideo();
          if (v) tryPlay(v);
        }
      }, 3000);
      return;
    }

    if (res && res.reason === 'current_not_done') {
      replayCurrentVideo(st);
      return;
    }

    if (res && res.reason === 'all_finished') {
      log('全部章节均已完成！');
      return;
    }

    // 2) DOM 兜底
    const items = chapterItems();
    if (!items.length) return;
    const idx = items.findIndex(isActiveChapter);
    if (idx < 0) return;

    if (S.settings.skipCompleted !== false) {
      const firstUnfinishedDom = items.find((el, i) => i !== idx && !isDoneChapter(el));
      if (firstUnfinishedDom) {
        S.nextLockUntil = now() + 18000;
        clickEl(firstUnfinishedDom);
        S.stats.nextClicked++;
        saveStats();
        log('切到未完成节（DOM）：', (textOf(firstUnfinishedDom) || '').slice(0, 40));
        return;
      }
    }

    for (let i = idx + 1; i < items.length; i++) {
      if (S.settings.skipCompleted && isDoneChapter(items[i])) continue;
      S.nextLockUntil = now() + 18000;
      clickEl(items[i]);
      S.stats.nextClicked++;
      saveStats();
      log('切到下一节（DOM）：', (textOf(items[i]) || '').slice(0, 40));
      return;
    }
  }

  /**
   * 视频播放到末尾时的统一调度：
   *  - 若当前节未完成（如只算了 48%/61%/74% 没有对勾），无论是否开启 autoNext，都从 00:00 重新播放当前节直至完成
   *  - 若当前节已完成（有对勾）且开启了 autoNext，则切换到下一节
   */
  function scheduleEndCheck(delay) {
    if (S.advancePending) return;
    if (now() < S.nextLockUntil) return;
    S.advancePending = true;
    clearTimeout(S.advanceTimer);
    S.advanceTimer = setTimeout(() => {
      S.advancePending = false;
      if (!S.settings.enabled) return;

      const v = ensureVideo();
      if (!v) return;
      const atEnd = v.ended || (v.duration > 10 && v.currentTime >= v.duration - 2);
      if (!atEnd) return;

      const st = callMainWorld('getState');
      if (!isCurrentLessonDone(st)) {
        replayCurrentVideo(st);
        return;
      }

      const src = v.currentSrc || v.src || '';
      if (S.endedSrc && src && src !== S.endedSrc) return;
      if (S.settings.autoNext) {
        advance();
      }
    }, delay);
  }

  /**
   * 检查并跳转到最早未完成的章节：
   *  1. 打开页面时，若当前默认加载的那一节已完成（curDone === true），跳到第一个未完成节
   *  2. 若当前节之前存在尚未完成的小节（hasEarlierUnfinished === true，例如已在播 3.3 但 3.1/3.2 仍是 48%/61% 未出对勾），
   *     自动切回最早未完成的小节（3.1）按顺序补刷完毕
   */
  function maybeJumpToUnfinished() {
    if (!S.settings.enabled || !S.settings.skipCompleted) return;
    if (S.quizOpen || now() < S.nextLockUntil) return;
    const elapsed = now() - S.startAt;
    if (elapsed < 3500) return;

    const st = callMainWorld('getState');
    if (st && st.hasVm && st.lessonCount > 0) {
      if (!st.studyInfoReady && elapsed < 7500) return;

      const needJump =
        Boolean(st.hasEarlierUnfinished) || (!S.jumpTried && Boolean(st.curDone));

      if (!needJump) {
        if (!S.jumpTried) {
          S.jumpTried = true;
          log(`当前已在最早未完成章节：${st.curName || st.lastViewVideoId}（进度 ${st.curPercentage || 0}%）`);
        }
        return;
      }

      S.jumpTried = true;
      const res = callMainWorld('switchLesson', {
        mode: 'unfinished',
        skipCompleted: true,
      });
      if (res && res.ok) {
        S.nextLockUntil = now() + 15000;
        S.replayingVideoId = '';
        S.replayCount = 0;
        S.stats.nextClicked++;
        saveStats();
        if (st.hasEarlierUnfinished) {
          log(`检测到前面仍有未完成小节，自动切回补刷：${res.name}`);
        } else {
          log('当前章节已完成，自动跳转到未完成章节：', res.name);
        }
        setTimeout(() => {
          const v = ensureVideo();
          if (v && S.settings.keepPlaying) tryPlay(v);
        }, 3000);
      }
      return;
    }

    // DOM 兜底
    if (!S.jumpTried && elapsed >= 6500) {
      const items = chapterItems();
      if (items.length) {
        S.jumpTried = true;
        const activeIdx = items.findIndex(isActiveChapter);
        const firstUnfinishedIdx = items.findIndex((el) => !isDoneChapter(el));
        if (
          firstUnfinishedIdx >= 0 &&
          activeIdx >= 0 &&
          firstUnfinishedIdx !== activeIdx &&
          (isDoneChapter(items[activeIdx]) || activeIdx > firstUnfinishedIdx)
        ) {
          S.nextLockUntil = now() + 15000;
          clickEl(items[firstUnfinishedIdx]);
          S.stats.nextClicked++;
          saveStats();
          log('自动跳转到最早未完成章节（DOM）：', (textOf(items[firstUnfinishedIdx]) || '').slice(0, 40));
        }
      }
    }
  }

  // ---------- MutationObserver 快速响应 ----------

  function fastTick() {
    if (!S.settings.enabled) return;
    if (checkBlocked()) return;

    if (isQuizActive()) {
      S.quizOpen = true;
      void handleQuiz();
    }
  }

  function bindObserver() {
    try {
      let last = 0;
      const mo = new MutationObserver(() => {
        const t = performance.now();
        if (t - last < 400) return;
        last = t;
        fastTick();
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  }

  // ---------- 右下角状态角标 ----------

  function renderBadge() {
    if (!S.settings.showBadge) {
      if (S.badge) { S.badge.remove(); S.badge = null; }
      return;
    }
    if (!S.badge) {
      S.badge = document.createElement('div');
      S.badge.id = 'zhs-badge';
      S.badge.style.cssText = [
        'position:fixed', 'right:14px', 'bottom:14px', 'z-index:2147483647',
        'background:rgba(33,37,41,.82)', 'color:#d3f9d8',
        'font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'padding:4px 10px', 'border-radius:999px', 'pointer-events:none',
        'box-shadow:0 2px 8px rgba(0,0,0,.25)',
      ].join(';');
      document.documentElement.appendChild(S.badge);
    }
    let extra = '';
    if (S.quizOpen) extra = ' · 答题中';
    else if (S.replayingVideoId) extra = ` · 补播重刷中(第${S.replayCount}次)`;
    S.badge.textContent = S.blocked
      ? '智慧树助手 已暂停'
      : `智慧树助手 ON${extra}`;
  }

  // ---------- 主循环 ----------

  function tick() {
    if (!S.settings.enabled) {
      renderBadge();
      return;
    }
    if (checkBlocked()) {
      renderBadge();
      return;
    }

    if (location.href !== S.lastHref) {
      log('页面地址变化，重置状态');
      S.lastHref = location.href;
      S.video = null;
      S.boundVideo = null;
      S.quizOpen = false;
      S.quiz = { q: '', clicks: 0 };
      S.replayingVideoId = '';
      S.replayCount = 0;
      S.replayDoneAdvancePending = false;
      S.jumpTried = false;
      S.startAt = now();
    }

    const st = callMainWorld('getState');
    if (st && (st.imgDialog || st.lookHabitDialog || st.readDialog)) {
      clickResumePrompt();
    }

    maybeJumpToUnfinished();
    checkReplayCompletedMidway();

    const v = ensureVideo();
    if (!v) {
      renderBadge();
      return;
    }
    bindVideo(v);

    if (S.settings.mute && !v.muted) {
      try { v.muted = true; } catch (e) {}
    }

    const speed = Math.min(1.8, Math.max(0.5, Number(S.settings.speed) || 1));
    if (v.playbackRate !== speed) {
      try { v.playbackRate = speed; } catch (e) {}
    }

    const quizActive = Boolean((st && st.testDialog) || findQuizDialog());
    S.quizOpen = quizActive;
    renderBadge();

    if (quizActive) {
      void handleQuiz();
      return;
    }

    if (st && st.faceVisible) {
      return;
    }

    // 视频播到底（或打开时就停在末尾）：检查是否真正完成，未完成则从 00:00 重播，已完成则切下一集
    const atEnd = v.ended || (v.duration > 10 && v.currentTime >= v.duration - 1.5 && v.paused);
    if (atEnd) {
      scheduleEndCheck(rand(2500, 4500));
      return;
    }

    if (v.paused) {
      clickResumePrompt();
      if (S.settings.keepPlaying) tryPlay(v);
      return;
    }

    callMainWorld('ensurePlay');
    checkStall(v);
  }

  function statusPayload() {
    const st = callMainWorld('getState');
    return {
      ok: true,
      href: location.href,
      enabled: S.settings.enabled,
      hasVideo: !!S.video,
      hasVm: Boolean(st && st.hasVm),
      paused: S.video ? S.video.paused : null,
      time: S.video ? Math.round(S.video.currentTime || 0) : 0,
      duration: S.video && Number.isFinite(S.video.duration) ? Math.round(S.video.duration) : 0,
      curPercentage: st ? st.curPercentage : null,
      curDone: st ? st.curDone : isCurrentChapterDoneInDom(),
      replaying: Boolean(S.replayingVideoId),
      replayCount: S.replayCount || 0,
      quizOpen: S.quizOpen,
      blocked: S.blocked,
      stats: { ...S.stats },
    };
  }

  function bindMessaging() {
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg) return false;
        if (msg.type === 'ZHS_GET_STATUS' || msg.type === 'ZHS_SCAN_NOW') {
          if (msg.type === 'ZHS_SCAN_NOW') tick();
          sendResponse(statusPayload());
          return false;
        }
        return false;
      });
    } catch (e) {}
  }

  /**
   * 与后台 Service Worker 建立长连接，接收每 2s 一次的不受后台节流影响的心跳，
   * 确保标签页在后台时依然能准时驱动计时补偿与状态检测。
   */
  function connectKeepAlivePort() {
    let port = null;
    function connect() {
      try {
        port = chrome.runtime.connect({ name: 'zhs-keepalive' });
        port.onMessage.addListener((msg) => {
          if (msg && msg.type === 'heartbeat') {
            tick();
          }
        });
        port.onDisconnect.addListener(() => {
          port = null;
          setTimeout(connect, 2000);
        });
      } catch (e) {
        setTimeout(connect, 5000);
      }
    }
    connect();
  }

  async function init() {
    await loadState();
    bindStorage();
    bindMessaging();
    connectKeepAlivePort();
    bindObserver();
    window.__ZHS_STATUS__ = () => statusPayload();
    setInterval(tick, 900);
    tick();
    log('已启动，enabled =', S.settings.enabled, 'version =', CFG.version);
  }

  init();
})();
