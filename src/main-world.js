/**
 * MAIN world 脚本：在 document_start（页面内联 <script> 之前）运行（v0.5.0）。
 *
 * 核心职责：
 *  1. 伪装页面可见性（hidden / visibilityState / hasFocus），切后台不暂停。
 *  2. 在页面冻结 window.originFunction 之前保护 Function.prototype.toString，
 *     防止其他扩展改写 XMLHttpRequest / addEventListener 或注入 window.OCS 导致 60s 环境自检（checkout）误报。
 *  3. 阻止页面抹除 DOM 节点上的 __vue__ 引用，捕获并接管智慧树 stuStudy 的 Vue 组件实例（vm）：
 *     - 屏蔽 notTrustScript / collectLog / checkout / 异常脚本弹窗
 *     - 将 topicClick / closeTest / videoClick 的 isTrusted 校验安全放行
 *     - 接管 videoNext：播放器触发切集时若当前小节未出对勾，强制重播当前节而非切走
 *     - 队列化保护 saveDdsjkTimeInWhileFn：防止 isSaving 期间丢失入库请求
 *     - 对 totalStudyTimeFun (4.8s 防重锁) 与 learningTimeRecord (1.8s 防重锁) 加硬性节流保护：
 *       配合后台 Service Worker 1.5s 心跳，保证前后台均严格按 1x 真实时间单步触发，
 *       绝不与页面原生 setInterval 重复叠加，避免触发服务端进度校验失败（backDialog）
 *     - 若偶发网络波动弹出 backDialog（“因网络连接问题，导致学习进度提交失败”），自动关闭并重新同步当前小节状态继续播放
 *     - 深度接管网易易盾（yidunInstance）安全验证组件（3D 空间文字/数字点选验证码）：
 *       读取内部组件状态（token / load / bg / front / verifyStatus），并在获取 AI 识别坐标后模拟人类轨迹直接调用内部 trackMoving + addPoint 触发验证，
 *       如遇连续 5 次错误弹出 showToastDialog，自动调用 toastDialogClick(1) 重新拉起图像验证码而非进入短信验证
 *  4. 在 window 捕获阶段拦截落入 #container 的非可信点击，避免触发播放器容器的捕获监听。
 */
(() => {
  'use strict';
  if (window.__ZHS_MW__) return;
  window.__ZHS_MW__ = true;

  const TAG = '[ZHS-MW]';
  const REQ_EVENT = '__zhs_mw_req__';
  const REQ_ATTR = 'data-zhs-req';
  const RES_ATTR = 'data-zhs-res';

  // ==================== 1. 保护原生函数自检（checkout） ====================
  try {
    const nativeToString = Function.prototype.toString;
    const nativeXHR = window.XMLHttpRequest;
    const nativeXHROpen = nativeXHR && nativeXHR.prototype && nativeXHR.prototype.open;
    const nativeAEL = Element.prototype.addEventListener;
    const nativeET_AEL = EventTarget && EventTarget.prototype && EventTarget.prototype.addEventListener;

    const strXHR = nativeXHR ? nativeToString.call(nativeXHR) : 'function XMLHttpRequest() { [native code] }';
    const strXHROpen = nativeXHROpen ? nativeToString.call(nativeXHROpen) : 'function open() { [native code] }';
    const strAEL = nativeAEL ? nativeToString.call(nativeAEL) : 'function addEventListener() { [native code] }';
    const strToString = nativeToString.call(nativeToString);

    const wrappedToString = function toString() {
      if (this === wrappedToString) return strToString;
      if (this === window.XMLHttpRequest || this === nativeXHR) return strXHR;
      if (
        (window.XMLHttpRequest &&
          window.XMLHttpRequest.prototype &&
          this === window.XMLHttpRequest.prototype.open) ||
        this === nativeXHROpen
      ) {
        return strXHROpen;
      }
      if (
        this === Element.prototype.addEventListener ||
        (EventTarget && EventTarget.prototype && this === EventTarget.prototype.addEventListener) ||
        this === nativeAEL ||
        this === nativeET_AEL
      ) {
        return strAEL;
      }
      return nativeToString.call(this);
    };

    Object.defineProperty(Function.prototype, 'toString', {
      configurable: true,
      writable: true,
      value: wrappedToString,
    });

    try {
      if ('OCS' in window) {
        try { delete window.OCS; } catch (e) {}
      }
      Object.defineProperty(window, 'OCS', {
        configurable: true,
        enumerable: false,
        get() { return undefined; },
        set() {},
      });
    } catch (e) {}
  } catch (e) {
    console.warn(TAG, 'native check guard failed:', e);
  }

  // ==================== 2. 伪装页面可见性与焦点 ====================
  function overrideGetter(proto, prop, value) {
    try {
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: true,
        get() {
          return value;
        },
      });
    } catch (e) {}
  }

  try {
    overrideGetter(Document.prototype, 'hidden', false);
    overrideGetter(Document.prototype, 'visibilityState', 'visible');
    overrideGetter(Document.prototype, 'webkitHidden', false);
    overrideGetter(Document.prototype, 'webkitVisibilityState', 'visible');
    overrideGetter(Document.prototype, 'msHidden', false);
    overrideGetter(Document.prototype, 'msVisibilityState', 'visible');
    Document.prototype.hasFocus = function hasFocus() {
      return true;
    };
  } catch (e) {}

  // ==================== 3. 拦截 #container 内的非可信点击 ====================
  try {
    window.addEventListener(
      'click',
      (e) => {
        if (!e || e.isTrusted) return;
        const target = e.target;
        if (target && typeof target.closest === 'function' && target.closest('#container')) {
          e.stopImmediatePropagation();
          e.preventDefault();
          console.warn(TAG, '已拦截落入 #container 的非可信 click 事件');
        }
      },
      true
    );
  } catch (e) {}

  // ==================== 4. 捕获并接管 stuStudy Vue 实例 ====================
  let rootVueVm = null;
  let stuStudyVm = null;
  const patchedVms = new WeakSet();
  let lastStudyTickAt = 0;
  let lastRecordTickAt = 0;
  let lastTrackedVideoId = '';
  let pendingDbSaveArgs = null;
  let pendingDbSaveTimer = null;

  function isStuStudyVm(vm) {
    return Boolean(
      vm &&
        typeof vm === 'object' &&
        (typeof vm.topicClickQot === 'function' ||
          typeof vm.videoClick === 'function' ||
          typeof vm.notTrustScript === 'function')
    );
  }

  function ensureLessonStudyTotalTimeInit(vm) {
    if (!vm || !Array.isArray(vm.videoList)) return;
    try {
      const lessons = getPlayableLessons(vm);
      const cur = lessons.find((x) => x.videoId === vm.lastViewVideoId);
      if (cur && cur.raw && (typeof cur.raw.studyTotalTime !== 'number' || isNaN(cur.raw.studyTotalTime))) {
        cur.raw.studyTotalTime = 0;
      }
    } catch (e) {}
  }

  function patchVm(vm) {
    if (!vm || patchedVms.has(vm)) return vm;
    patchedVms.add(vm);
    stuStudyVm = vm;

    try {
      // 1) 彻底禁用异常脚本报警与日志上报
      vm.notTrustScript = function () {
        console.warn(TAG, '已拦截 notTrustScript 调用');
      };
      vm.collectLog = function () {
        console.warn(TAG, '已拦截 collectLog 上报');
      };
      vm.checkout = function () {
        return true;
      };
      vm.checkoutNotTrustScript = function () {};
      if (vm.checkTimer) {
        clearInterval(vm.checkTimer);
        vm.checkTimer = null;
      }

      // 2) 过滤包含“异常脚本”的 $alert 弹窗
      if (typeof vm.$alert === 'function') {
        const origAlert = vm.$alert;
        vm.$alert = function (msg, ...rest) {
          if (typeof msg === 'string' && msg.includes('异常脚本')) {
            console.warn(TAG, '已拦截异常脚本 $alert:', msg);
            return Promise.resolve();
          }
          return origAlert.call(this, msg, ...rest);
        };
      }

      // 3) 包装 topicClick：无论事件是否 isTrusted 都转发给 topicClickQot
      if (typeof vm.topicClick === 'function' && typeof vm.topicClickQot === 'function') {
        vm.topicClick = function (option, ev) {
          return this.topicClickQot(option, 1);
        };
      }

      // 4) 包装 closeTest：始终传入 isTrusted: true，且若还有未勾选题先自动补答
      if (typeof vm.closeTest === 'function') {
        const origCloseTest = vm.closeTest;
        vm.closeTest = function (ev) {
          try {
            const list = this.topicInfo && this.topicInfo.lessonTestQuestionUseInterfaceDtos;
            if (Array.isArray(list)) {
              for (const q of list) {
                if (q && !q.isCheck) {
                  q.isCheck = true;
                }
              }
            }
          } catch (e) {}
          const safeEv = ev && typeof ev === 'object' && ev.isTrusted === true ? ev : { isTrusted: true };
          return origCloseTest.call(this, safeEv);
        };
      }

      // 5) 包装 videoClick：剔除末尾非可信的 Event 参数，避免 PointerEvent 检查
      if (typeof vm.videoClick === 'function') {
        const origVideoClick = vm.videoClick;
        vm.videoClick = function (...args) {
          const last = args[args.length - 1];
          if (last instanceof Event && !last.isTrusted) {
            args.pop();
          }
          return origVideoClick.apply(this, args);
        };
      }

      // 6) 包装 videoNext / playerNext：当播放器内部触发切下一集时，若当前小节未完成（无对勾），强制重播当前集
      if (typeof vm.videoNext === 'function') {
        vm.videoNext = function () {
          const st = getVmState();
          if (st && st.hasVm && !st.curDone) {
            console.log(TAG, '拦截播放器自动 videoNext：当前小节尚未完成，改为从头重播当前节');
            replayCurrentLesson();
            return;
          }
          switchLesson('next', true, false);
        };
      }

      // 7) 包装 saveDdsjkTimeInWhileFn：防止在 isSaving（如 3 分钟缓存保存）期间调用导致丢失入库请求或卡住切集
      if (typeof vm.saveDdsjkTimeInWhileFn === 'function') {
        const origSaveDb = vm.saveDdsjkTimeInWhileFn;
        vm.saveDdsjkTimeInWhileFn = function (...args) {
          if (this.isSaving) {
            pendingDbSaveArgs = args;
            if (!pendingDbSaveTimer) {
              pendingDbSaveTimer = setInterval(() => {
                if (!this.isSaving && pendingDbSaveArgs) {
                  const nextArgs = pendingDbSaveArgs;
                  pendingDbSaveArgs = null;
                  clearInterval(pendingDbSaveTimer);
                  pendingDbSaveTimer = null;
                  try {
                    origSaveDb.apply(this, nextArgs);
                  } catch (e) {}
                }
              }, 250);
            }
            return;
          }
          return origSaveDb.apply(this, args);
        };
      }

      // 8) 包装学习计时器心跳函数：加入硬性最小间隔防重锁（4.8s / 1.8s），
      //    确保后台心跳唤醒与页面原生 setInterval 绝不重复叠加导致 playTimes 超速报错
      if (typeof vm.totalStudyTimeFun === 'function') {
        const origTotalStudyTimeFun = vm.totalStudyTimeFun;
        vm.totalStudyTimeFun = function (...args) {
          const t = Date.now();
          if (lastStudyTickAt > 0 && t - lastStudyTickAt < 4800) {
            return;
          }
          lastStudyTickAt = t;
          ensureLessonStudyTotalTimeInit(this);
          return origTotalStudyTimeFun.apply(this, args);
        };
      }
      if (typeof vm.learningTimeRecord === 'function') {
        const origLearningTimeRecord = vm.learningTimeRecord;
        vm.learningTimeRecord = function (...args) {
          const t = Date.now();
          if (lastRecordTickAt > 0 && t - lastRecordTickAt < 1800) {
            return;
          }
          lastRecordTickAt = t;
          return origLearningTimeRecord.apply(this, args);
        };
      }

      // 若接管前计时器已启动，重启一次使 setInterval 绑定到包装后的防重函数
      if (vm.totalStudyTimeInterval && typeof vm.startTotalTimer === 'function') {
        try {
          vm.startTotalTimer();
        } catch (e) {}
      }

      console.log(TAG, '已接管并保护 stuStudy Vue 实例');
    } catch (e) {
      console.warn(TAG, 'patchVm 出错:', e);
    }

    return vm;
  }

  // 阻止页面通过 Object.defineProperty(el, '__vue__', { get(){}, set(){} }) 抹除 __vue__，并第一时间捕获实例
  try {
    const origDefineProperty = Object.defineProperty;
    Object.defineProperty = function (target, prop, descriptor) {
      if (prop === '__vue__' && target && target instanceof Element) {
        try {
          const existing = target.__vue__;
          if (existing && typeof existing === 'object') {
            if (existing.$root) rootVueVm = existing.$root;
            else if (!rootVueVm) rootVueVm = existing;
            if (isStuStudyVm(existing)) {
              patchVm(existing);
            }
          }
        } catch (e) {}
        // 阻止页面用空 getter/setter 抹掉 DOM 上的 __vue__
        if (descriptor && typeof descriptor.get === 'function' && !('value' in descriptor)) {
          return target;
        }
      }
      return origDefineProperty.call(this, target, prop, descriptor);
    };
    try {
      Object.defineProperty.toString = () => 'function defineProperty() { [native code] }';
    } catch (e) {}
  } catch (e) {}

  function findVmFromRoot() {
    if (stuStudyVm && !stuStudyVm._isDestroyed) {
      if (stuStudyVm.checkTimer) {
        clearInterval(stuStudyVm.checkTimer);
        stuStudyVm.checkTimer = null;
      }
      return stuStudyVm;
    }
    try {
      const videoStudyEl = document.querySelector('.video-study');
      if (videoStudyEl && isStuStudyVm(videoStudyEl.__vue__)) {
        return patchVm(videoStudyEl.__vue__);
      }
      const appEl = document.getElementById('app');
      const root = (appEl && appEl.__vue__) || rootVueVm || (videoStudyEl && videoStudyEl.__vue__ && videoStudyEl.__vue__.$root);
      if (!root) return null;
      const queue = [root];
      const visited = new Set();
      while (queue.length) {
        const cur = queue.shift();
        if (!cur || visited.has(cur)) continue;
        visited.add(cur);
        if (isStuStudyVm(cur)) {
          return patchVm(cur);
        }
        if (Array.isArray(cur.$children)) {
          for (const child of cur.$children) queue.push(child);
        }
      }
    } catch (e) {}
    return null;
  }

  setInterval(() => {
    findVmFromRoot();
  }, 500);

  // ==================== 5. 课程章节与弹题操作封装 ====================
  function isCurrentDomFinished() {
    try {
      const activeLi = document.querySelector('li.clearfix.video.current_play');
      if (!activeLi) return false;
      return Boolean(activeLi.querySelector('.time_icofinish'));
    } catch (e) {
      return false;
    }
  }

  function getPlayableLessons(vm) {
    const out = [];
    if (!vm || !Array.isArray(vm.videoList)) return out;
    vm.videoList.forEach((chapter, chapIdx) => {
      if (!chapter || !Array.isArray(chapter.videoLessons)) return;
      chapter.videoLessons.forEach((lesson, lessonIdx) => {
        if (!lesson) return;
        const hasSmall =
          lesson.ishaveChildrenLesson > 0 &&
          Array.isArray(lesson.videoSmallLessons) &&
          lesson.videoSmallLessons.length > 0;
        if (hasSmall) {
          lesson.videoSmallLessons.forEach((small, smallIdx) => {
            if (!small || !small.videoId) return;
            out.push({
              videoId: small.videoId,
              name: `${chapter.orderNumber || ''}.${lesson.orderNumber || ''}.${small.orderNumber || ''} ${small.name || lesson.name || ''}`.trim(),
              done: Number(small.isStudiedLesson) === 1,
              state: Number(small.isStudiedLesson) || 0,
              percentage: Number(small.percentage) || 0,
              studyTotalTime: Number(small.studyTotalTime) || 0,
              hasStudyInfo: typeof small.studyTotalTime === 'number',
              videoSec: Number(small.videoSec) || 0,
              raw: small,
              args: [chapter, chapIdx, lesson, lessonIdx, small, smallIdx],
            });
          });
        } else if (lesson.videoId) {
          out.push({
            videoId: lesson.videoId,
            name: `${chapter.orderNumber || ''}.${lesson.orderNumber || ''} ${lesson.name || ''}`.trim(),
            done: Number(lesson.isStudiedLesson) === 1,
            state: Number(lesson.isStudiedLesson) || 0,
            percentage: Number(lesson.percentage) || 0,
            studyTotalTime: Number(lesson.studyTotalTime) || 0,
            hasStudyInfo: typeof lesson.studyTotalTime === 'number',
            videoSec: Number(lesson.videoSec) || 0,
            raw: lesson,
            args: [chapter, chapIdx, lesson, lessonIdx, null, null],
          });
        }
      });
    });
    return out;
  }

  function getVmState() {
    const vm = findVmFromRoot();
    const domDone = isCurrentDomFinished();
    if (!vm) return { hasVm: false, domDone };

    const lessons = getPlayableLessons(vm);
    const curIdx = lessons.findIndex((x) => x.videoId === vm.lastViewVideoId);
    const curLesson = curIdx >= 0 ? lessons[curIdx] : null;
    const studyInfoReady = lessons.some((x) => x.hasStudyInfo || x.state > 0 || x.percentage > 0);

    const firstUnfinishedIdx = lessons.findIndex((x) => !x.done);
    const firstUnfinished = firstUnfinishedIdx >= 0 ? lessons[firstUnfinishedIdx] : null;
    const hasEarlierUnfinished = Boolean(
      studyInfoReady && firstUnfinishedIdx >= 0 && curIdx > firstUnfinishedIdx
    );

    const dtos =
      (vm.topicInfo &&
        Array.isArray(vm.topicInfo.lessonTestQuestionUseInterfaceDtos) &&
        vm.topicInfo.lessonTestQuestionUseInterfaceDtos) ||
      [];
    const allQuizChecked = dtos.length > 0 && dtos.every((q) => Boolean(q && q.isCheck));

    // 只有 Vue 状态为 isStudiedLesson === 1（或 DOM 中明确出现对勾图标 .time_icofinish）才算真正完成
    const curDone = Boolean((curLesson && curLesson.done) || domDone);
    const capState = getCaptchaState(vm);

    return {
      hasVm: true,
      lastViewVideoId: vm.lastViewVideoId || '',
      testDialog: Boolean(vm.testDialog),
      quizCount: dtos.length,
      allQuizChecked,
      imgDialog: Boolean(vm.imgDialog),
      lookHabitDialog: Boolean(vm.lookHabitDialog),
      readDialog: Boolean(vm.readDialog),
      backDialog: Boolean(vm.backDialog),
      tipsDialog: Boolean(vm.tipsDialog),
      tipsMsg: vm.tipsMsg || '',
      faceVisible: Boolean(vm.FaceVisible || vm.FaceIdentityVisible),
      showToastDialog: Boolean(vm.showToastDialog),
      showMessageDialog: Boolean(vm.showMessageDialog),
      captchaOpen: Boolean(capState && capState.open),
      captchaState: capState,
      isSaving: Boolean(vm.isSaving),
      totalStudyTime: Number(vm.totalStudyTime) || 0,
      playTimes: Number(vm.playTimes) || 0,
      lessonCount: lessons.length,
      curIdx,
      curDone,
      domDone,
      curPercentage: curLesson ? curLesson.percentage : 0,
      curVideoSec: curLesson ? curLesson.videoSec : 0,
      curName: curLesson ? curLesson.name : '',
      studyInfoReady,
      firstUnfinishedIdx,
      firstUnfinishedName: firstUnfinished ? firstUnfinished.name : '',
      hasEarlierUnfinished,
    };
  }

  function pickOptionsForQuestion(q, strategy) {
    const opts =
      (q && q.testQuestion && Array.isArray(q.testQuestion.questionOptions) && q.testQuestion.questionOptions) || [];
    if (!opts.length) return [];

    const inputType = (q.testQuestion && q.testQuestion.questionType && q.testQuestion.questionType.inputType) || 'radio';
    const rightOpts = opts.filter((o) => Number(o.result) === 1);

    if (inputType === 'checkbox') {
      return rightOpts.length ? rightOpts : [opts[0]];
    }

    if (rightOpts.length) {
      return [rightOpts[0]];
    }
    if (strategy === 'random') {
      return [opts[Math.floor(Math.random() * opts.length)]];
    }
    return [opts[0]];
  }

  function answerNextUncheckedQuestion(strategy = 'first') {
    const vm = findVmFromRoot();
    if (!vm || !vm.testDialog) return { ok: false, reason: 'no_quiz' };

    const dtos =
      (vm.topicInfo &&
        Array.isArray(vm.topicInfo.lessonTestQuestionUseInterfaceDtos) &&
        vm.topicInfo.lessonTestQuestionUseInterfaceDtos) ||
      [];
    if (!dtos.length) return { ok: false, reason: 'empty_dtos' };

    let targetIdx = dtos.findIndex((q) => !q || !q.isCheck || !q.showAnswer);
    if (targetIdx < 0) {
      return { ok: true, done: true, answered: 0 };
    }

    const q = dtos[targetIdx];
    if (vm.pageList !== q && typeof vm.pageeClick === 'function') {
      try {
        vm.pageeClick(targetIdx + 1);
      } catch (e) {}
    }

    const inputType = (q.testQuestion && q.testQuestion.questionType && q.testQuestion.questionType.inputType) || 'radio';
    const opts = (q.testQuestion && q.testQuestion.questionOptions) || [];
    const targets = pickOptionsForQuestion(q, strategy);

    if (!targets.length) {
      q.isCheck = true;
      q.showAnswer = true;
      return { ok: true, done: targetIdx >= dtos.length - 1, answered: 1, label: '无选项跳过' };
    }

    if (inputType === 'checkbox') {
      for (const o of opts) {
        if (o.isClick && !targets.includes(o)) {
          vm.topicClickQot(o, 1);
        }
      }
      for (const o of targets) {
        if (!o.isClick) {
          vm.topicClickQot(o, 1);
        }
      }
    } else {
      vm.topicClickQot(targets[0], 1);
    }

    const label = targets.map((o) => o.sortUs || o.sort || '').join(',');
    const allDone = dtos.every((item) => Boolean(item && item.isCheck));
    return {
      ok: true,
      done: allDone,
      answered: 1,
      label,
      questionIndex: targetIdx + 1,
      totalQuestions: dtos.length,
    };
  }

  function closeQuizSafely() {
    const vm = findVmFromRoot();
    if (!vm) return { ok: false };
    try {
      const dtos =
        (vm.topicInfo &&
          Array.isArray(vm.topicInfo.lessonTestQuestionUseInterfaceDtos) &&
          vm.topicInfo.lessonTestQuestionUseInterfaceDtos) ||
        [];
      for (const q of dtos) {
        if (q && !q.isCheck) q.isCheck = true;
      }
      if (typeof vm.closeTest === 'function') {
        vm.closeTest({ isTrusted: true });
      } else {
        vm.testDialog = false;
        if (typeof vm.habitWarn === 'function') vm.habitWarn();
      }
      return { ok: true };
    } catch (e) {
      vm.testDialog = false;
      return { ok: true };
    }
  }

  function closeOtherDialogs() {
    const vm = findVmFromRoot();
    if (!vm) return { closed: [] };
    const closed = [];
    try {
      if (vm.imgDialog) {
        if (typeof vm.closeImg === 'function') vm.closeImg();
        else vm.imgDialog = false;
        closed.push('imgDialog');
      }
      if (vm.lookHabitDialog) {
        vm.lookHabitDialog = false;
        closed.push('lookHabitDialog');
      }
      if (vm.learnHabitDialog) {
        vm.learnHabitDialog = false;
        closed.push('learnHabitDialog');
      }
      if (vm.readDialog) {
        if (typeof vm.readCloseClick === 'function') vm.readCloseClick();
        else vm.readDialog = false;
        closed.push('readDialog');
      }
      if (vm.backDialog) {
        vm.backDialog = false;
        closed.push('backDialog');
        // 重新向服务端同步当前小节的 studyTotalTime 与 token，避免后续提交继续失步
        try {
          const lessons = getPlayableLessons(vm);
          const cur = lessons.find((x) => x.videoId === vm.lastViewVideoId);
          if (cur && typeof vm.prelearningNote === 'function') {
            vm.playTimes = 0;
            vm.watchPointPost = '';
            vm.prelearningNote(cur.args[0], cur.args[2], cur.args[4]);
          }
        } catch (e) {}
      }
    } catch (e) {}
    return { closed };
  }

  /**
   * 当前视频播放到底但尚未完成（如卡在 48%/61%/74% 未出现对勾）时，从 00:00 重新播放当前视频，
   * 不擅自篡改 totalStudyTime / playTimes，保持与服务端校验完全一致。
   */
  function replayCurrentLesson() {
    const vm = findVmFromRoot();
    const v = document.querySelector('#container video, video.vjs-tech, video');

    try {
      if (typeof window.ablePlayerX === 'function') {
        const player = window.ablePlayerX('container');
        if (player && typeof player.seek === 'function') {
          player.seek(0);
        }
        if (player && typeof player.play === 'function') {
          player.play();
        }
      }
    } catch (e) {}

    try {
      if (v) {
        v.currentTime = 0;
        const p = v.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch (e) {}

    try {
      if (
        vm &&
        !vm.totalStudyTimeInterval &&
        (!vm.data || vm.data.studyStatus != 1) &&
        typeof vm.startTotalTimer === 'function'
      ) {
        vm.startTotalTimer();
      }
      lastStudyTickAt = Date.now();
      lastRecordTickAt = Date.now();
    } catch (e) {}

    return { ok: true };
  }

  /**
   * 仅当确实有未提交的有效观看时长（playTimes > 5）时才触发入库保存。
   */
  function flushStudyProgress() {
    const vm = findVmFromRoot();
    if (!vm) return { ok: false };
    try {
      if (
        !vm.isSaving &&
        (Number(vm.playTimes) || 0) > 5 &&
        typeof vm.saveDdsjkTimeInWhileFn === 'function'
      ) {
        vm.saveDdsjkTimeInWhileFn(null, null, null, 2);
        return { ok: true, triggered: true };
      }
      return { ok: true, triggered: false, isSaving: Boolean(vm.isSaving) };
    } catch (e) {
      return { ok: false };
    }
  }

  function switchLesson(mode = 'next', skipCompleted = true, force = false) {
    const vm = findVmFromRoot();
    if (!vm || typeof vm.videoClick !== 'function') return { ok: false, reason: 'no_vm' };

    const lessons = getPlayableLessons(vm);
    if (!lessons.length) return { ok: false, reason: 'no_lessons' };

    const curIdx = lessons.findIndex((x) => x.videoId === vm.lastViewVideoId);
    const curLesson = curIdx >= 0 ? lessons[curIdx] : null;
    const curDone = Boolean((curLesson && curLesson.done) || isCurrentDomFinished());

    let target = null;
    if (mode === 'unfinished') {
      // 始终从课程第 1 节开始查找第一个未完成的小节（例如当前在 3.3，但 3.1/3.2 还没拿对勾，优先切回 3.1）
      const firstUnfinished = lessons.find((x) => !x.done) || null;
      if (!firstUnfinished) {
        return { ok: false, reason: 'all_finished' };
      }
      if (curLesson && firstUnfinished.videoId === curLesson.videoId && !curDone) {
        return { ok: false, reason: 'current_already_unfinished', current: curLesson.name };
      }
      target = firstUnfinished;
    } else {
      // mode === 'next'：切换下一集前，若当前集还没拿到对勾（未完成），拒绝切走并提示重播当前集
      if (!force && curLesson && !curDone) {
        return {
          ok: false,
          reason: 'current_not_done',
          name: curLesson.name,
          percentage: curLesson.percentage,
        };
      }

      if (skipCompleted) {
        // 优先检查前面是否有遗漏未完成的小节（如 3.1 / 3.2），确保严格按顺序全部拿到对勾
        target = lessons.find((x) => !x.done && (!curLesson || x.videoId !== curLesson.videoId)) || null;
      } else {
        const startIdx = curIdx >= 0 ? curIdx + 1 : 0;
        if (startIdx < lessons.length) {
          target = lessons[startIdx];
        }
      }
    }

    if (!target) {
      return { ok: false, reason: 'all_finished' };
    }

    try {
      vm.repeatClick = true;
      vm.videoClick(...target.args);
      lastStudyTickAt = Date.now();
      lastRecordTickAt = Date.now();
      return { ok: true, name: target.name, videoId: target.videoId };
    } catch (e) {
      return { ok: false, reason: String(e && e.message ? e.message : e) };
    }
  }

  function ensurePlayAndTimer() {
    const vm = findVmFromRoot();
    let played = false;
    try {
      if (typeof window.ablePlayerX === 'function') {
        const player = window.ablePlayerX('container');
        const vCheck = document.querySelector('#container video, video.vjs-tech, video');
        if (
          vCheck &&
          vCheck.paused &&
          !vCheck.ended &&
          (!vm || !vm.testDialog) &&
          player &&
          typeof player.play === 'function'
        ) {
          player.play();
          played = true;
        }
      }
    } catch (e) {}

    try {
      const v = document.querySelector('#container video, video.vjs-tech, video');
      const capOpen = isCaptchaPopupVisible();
      if (v && v.paused && !v.ended && (!vm || !vm.testDialog) && !capOpen) {
        const p = v.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
        played = true;
      }
      if (
        v &&
        !v.paused &&
        !v.ended &&
        vm &&
        !vm.testDialog &&
        !capOpen &&
        (!vm.data || vm.data.studyStatus != 1)
      ) {
        if (vm.lastViewVideoId && vm.lastViewVideoId !== lastTrackedVideoId) {
          lastTrackedVideoId = vm.lastViewVideoId;
          lastStudyTickAt = Date.now();
          lastRecordTickAt = Date.now();
        }

        if (!vm.totalStudyTimeInterval && typeof vm.startTotalTimer === 'function') {
          vm.startTotalTimer();
        }

        ensureLessonStudyTotalTimeInit(vm);

        // 单步安全补偿：仅当超过原生周期（2.0s / 5.1s）未触发时单次触发，
        // 内部带有 1.8s / 4.8s 硬性防重锁，绝不超速或重复触发
        const t = Date.now();
        if (lastRecordTickAt === 0) {
          lastRecordTickAt = t;
        } else if (t - lastRecordTickAt >= 2000 && typeof vm.learningTimeRecord === 'function') {
          vm.learningTimeRecord();
        }

        if (lastStudyTickAt === 0) {
          lastStudyTickAt = t;
        } else if (t - lastStudyTickAt >= 5100 && typeof vm.totalStudyTimeFun === 'function') {
          if (!vm.watchPointPost && typeof vm.learningTimeRecord === 'function') {
            vm.learningTimeRecord();
          }
          vm.totalStudyTimeFun();
        }
      }
    } catch (e) {}

    return { ok: played };
  }

  // ==================== 5.5 网易易盾（Yidun）安全验证接管与自动化点击 ====================

  function isCaptchaPopupVisible() {
    try {
      const pop = document.querySelector('.yidun_popup');
      if (!pop) return false;
      const cs = getComputedStyle(pop);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) {
        return false;
      }
      const modal = pop.querySelector('.yidun_modal');
      if (modal) {
        const r = modal.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 递归在易盾实例树中查找带有 addPoint / onClick 的空间点选子组件及顶层 store
   */
  function findYidunInternalComponents(vm) {
    const ins = vm && vm.yidunInstance;
    if (!ins) return { ins: null, modalVm: null, coreVm: null, spaceVm: null, store: null };

    const modalVm = ins._captchaIns || null;
    let store = (modalVm && modalVm.$store) || ins.$store || null;
    let coreVm = null;
    let spaceVm = null;

    const queue = [modalVm, ins].filter(Boolean);
    const visited = new Set();
    while (queue.length) {
      const cur = queue.shift();
      if (!cur || typeof cur !== 'object' || visited.has(cur)) continue;
      visited.add(cur);
      if (!store && cur.$store) store = cur.$store;
      if (typeof cur.verifyCaptcha === 'function' && typeof cur.fetchCaptcha === 'function') {
        coreVm = cur;
      }
      if (typeof cur.addPoint === 'function' && typeof cur.onClick === 'function') {
        spaceVm = cur;
      }
      if (Array.isArray(cur.$children)) {
        for (const c of cur.$children) queue.push(c);
      }
      if (cur._captchaIns && !visited.has(cur._captchaIns)) {
        queue.push(cur._captchaIns);
      }
    }

    return { ins, modalVm, coreVm, spaceVm, store };
  }

  function getCaptchaState(vmArg) {
    const vm = vmArg || findVmFromRoot();
    // 若连续失败 5 次触发了智慧树的验证方式选择弹窗（showToastDialog），自动选择 1（重新拉起图像验证，避开短信验证）
    if (vm && vm.showToastDialog && typeof vm.toastDialogClick === 'function') {
      try {
        console.log(TAG, '检测到验证失败切换弹窗 (showToastDialog)，自动选 1 重新拉起图像验证码');
        vm.toastDialogClick(1);
      } catch (e) {}
    }

    const open = isCaptchaPopupVisible();
    if (!open) {
      return { open: false };
    }

    const { ins, coreVm, spaceVm, store } = findYidunInternalComponents(vm);
    const st = (store && store.state) || {};
    const load = st.load || (spaceVm && spaceVm.loadInfo) || null;
    const loadStatus = (load && load.status) || '';
    const loadData = (load && load.data) || {};

    const bgImgEl = document.querySelector('.yidun_popup .yidun_bg-img, .yidun_bg-img');
    const tipEl = document.querySelector('.yidun_popup .yidun_tips__text, .yidun_tips__text');
    const domBgSrc = (bgImgEl && bgImgEl.getAttribute('src')) || '';
    const domTipText = (tipEl && (tipEl.innerText || tipEl.textContent || '').trim()) || '';

    const rect = bgImgEl ? bgImgEl.getBoundingClientRect() : null;
    const width = (rect && Math.round(rect.width)) || 320;
    const height = (rect && Math.round(rect.height)) || 160;

    return {
      open: true,
      hasYidunIns: Boolean(ins),
      hasSpaceVm: Boolean(spaceVm),
      hasCoreVm: Boolean(coreVm),
      token: st.token || loadData.token || '',
      verifyStatus: st.verifyStatus || '',
      countsOfVerifyError: Number(st.countsOfVerifyError) || 0,
      loadStatus,
      bgUrl: domBgSrc || (Array.isArray(loadData.bg) ? loadData.bg[0] : loadData.bg) || '',
      promptText: domTipText || loadData.front || '',
      width,
      height,
    };
  }

  /**
   * 刷新易盾验证码题目
   */
  function refreshYidunCaptcha() {
    const vm = findVmFromRoot();
    const { ins, coreVm } = findYidunInternalComponents(vm);
    try {
      if (coreVm && typeof coreVm.refresh === 'function') {
        coreVm.refresh();
        return { ok: true, via: 'coreVm' };
      }
      if (ins && typeof ins.refresh === 'function') {
        ins.refresh();
        return { ok: true, via: 'ins' };
      }
      const btn = document.querySelector('.yidun_popup .yidun_refresh, .yidun_refresh');
      if (btn) {
        btn.click();
        return { ok: true, via: 'dom' };
      }
    } catch (e) {
      return { ok: false, error: String(e) };
    }
    return { ok: false };
  }

  /**
   * 在易盾 3D 空间验证码上模拟拟人化鼠标轨迹并在目标坐标 (x, y) 处完成点击验证。
   * 优先通过易盾内部 spaceVm 组件方法（trackMoving + addPoint）提交，兼具真实轨迹采样与 isTrusted=1 标记；
   * 若内部组件未取到，则退化为在 .yidun_bg-img 上派发带完整轨迹的鼠标事件。
   */
  function submitYidunSpaceClick(payload = {}) {
    const vm = findVmFromRoot();
    const { spaceVm } = findYidunInternalComponents(vm);
    const bgImgEl =
      (spaceVm && spaceVm.$bgImg) ||
      document.querySelector('.yidun_popup .yidun_bg-img, .yidun_bg-img');

    if (!bgImgEl) {
      return { ok: false, reason: 'no_bg_img' };
    }

    const rect = bgImgEl.getBoundingClientRect();
    const w = rect.width || 320;
    const h = rect.height || 160;
    const targetX = Math.max(6, Math.min(w - 6, Math.round(Number(payload.x) || w / 2)));
    const targetY = Math.max(6, Math.min(h - 6, Math.round(Number(payload.y) || h / 2)));

    // 1) 若能直接访问易盾内部点选组件 spaceVm，构造逼真的人类思考时长与鼠标移动轨迹并调用 addPoint
    if (spaceVm && typeof spaceVm.addPoint === 'function') {
      try {
        if (typeof spaceVm.cleanPoints === 'function' && Array.isArray(spaceVm.pointsStack) && spaceVm.pointsStack.length) {
          spaceVm.cleanPoints();
        }
        spaceVm.pointsStack = [];
        spaceVm.traceData = [];

        // 模拟人类看到图片后经过 680~1130ms 移入并点击
        const totalDuration = 680 + Math.floor(Math.random() * 450);
        const nowTs = Date.now();
        spaceVm.beginTime = nowTs - totalDuration;
        spaceVm.clickCounts = (Number(spaceVm.clickCounts) || 0) + 1;

        // 生成一条从图片边缘平滑移动到目标点 (targetX, targetY) 的贝塞尔微抖动轨迹（18~28 个采样点）
        const startX = Math.round(25 + Math.random() * (w - 50));
        const startY = Math.round(h - 10 - Math.random() * 25);
        const ctrlX = Math.round((startX + targetX) / 2 + (Math.random() - 0.5) * 40);
        const ctrlY = Math.round((startY + targetY) / 2 + (Math.random() - 0.5) * 30);
        const steps = 18 + Math.floor(Math.random() * 10);

        if (typeof spaceVm.trackMoving === 'function') {
          for (let i = 1; i <= steps; i++) {
            const p = i / steps;
            const bx = (1 - p) * (1 - p) * startX + 2 * (1 - p) * p * ctrlX + p * p * targetX;
            const by = (1 - p) * (1 - p) * startY + 2 * (1 - p) * p * ctrlY + p * p * targetY;
            const jitterX = i < steps ? (Math.random() - 0.5) * 2.2 : 0;
            const jitterY = i < steps ? (Math.random() - 0.5) * 2.2 : 0;
            const curX = Math.max(2, Math.min(w - 2, Math.round(bx + jitterX)));
            const curY = Math.max(2, Math.min(h - 2, Math.round(by + jitterY)));

            const pointElapsed = Math.round(totalDuration * (0.15 + 0.82 * Math.pow(p, 0.85)));
            spaceVm.beginTime = Date.now() - pointElapsed;
            spaceVm.trackMoving({
              clientX: rect.left + curX,
              clientY: rect.top + curY,
              isTrusted: true,
            });
          }
        }

        spaceVm.beginTime = Date.now() - totalDuration;
        spaceVm.addPoint({ left: targetX, top: targetY });

        console.log(
          TAG,
          `已通过易盾内部组件提交点击坐标 (${targetX}, ${targetY})，轨迹点数=${(spaceVm.traceData && spaceVm.traceData.length) || 0}`
        );
        return {
          ok: true,
          via: 'spaceVm',
          x: targetX,
          y: targetY,
        };
      } catch (e) {
        console.warn(TAG, 'spaceVm.addPoint 调用异常，回退 DOM 事件:', e);
      }
    }

    // 2) DOM 事件兜底
    try {
      const clientX = Math.round(rect.left + targetX);
      const clientY = Math.round(rect.top + targetY);
      const startX = Math.round(rect.left + w / 2 + (Math.random() - 0.5) * 60);
      const startY = Math.round(rect.top + h - 15);
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        const p = i / steps;
        const cx = Math.round(startX + (clientX - startX) * p);
        const cy = Math.round(startY + (clientY - startY) * p);
        bgImgEl.dispatchEvent(
          new MouseEvent('mousemove', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: cx,
            clientY: cy,
          })
        );
      }
      const evInit = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX,
        clientY,
        button: 0,
        buttons: 1,
      };
      bgImgEl.dispatchEvent(new MouseEvent('mousedown', evInit));
      bgImgEl.dispatchEvent(new MouseEvent('mouseup', { ...evInit, buttons: 0 }));
      bgImgEl.dispatchEvent(new MouseEvent('click', { ...evInit, buttons: 0 }));
      return { ok: true, via: 'dom', x: targetX, y: targetY };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // ==================== 6. 与 ISOLATED world (app.js) 同步通信桥 ====================
  function execBridgeCmd(cmd, payload) {
    switch (cmd) {
      case 'getState':
        return getVmState();
      case 'getCaptchaState':
        return getCaptchaState();
      case 'submitCaptchaClick':
        return submitYidunSpaceClick(payload);
      case 'refreshCaptcha':
        return refreshYidunCaptcha();
      case 'answerQuiz':
        return answerNextUncheckedQuestion(payload && payload.strategy);
      case 'closeQuiz':
        return closeQuizSafely();
      case 'closeOtherDialogs':
        return closeOtherDialogs();
      case 'replayCurrent':
        return replayCurrentLesson();
      case 'flushProgress':
        return flushStudyProgress();
      case 'switchLesson':
        return switchLesson(
          (payload && payload.mode) || 'next',
          payload ? payload.skipCompleted !== false : true,
          Boolean(payload && payload.force)
        );
      case 'ensurePlay':
        return ensurePlayAndTimer();
      default:
        return { ok: false, reason: 'unknown_cmd' };
    }
  }

  window.addEventListener(REQ_EVENT, (ev) => {
    const host = document.head || document.documentElement;
    let packet = null;
    try {
      const raw = host && host.getAttribute(REQ_ATTR);
      if (raw) {
        host.removeAttribute(REQ_ATTR);
        packet = JSON.parse(raw);
      } else if (ev && ev.detail) {
        packet = typeof ev.detail === 'string' ? JSON.parse(ev.detail) : ev.detail;
      }
    } catch (e) {}

    if (!packet || !packet.cmd) return;

    let result = null;
    try {
      result = execBridgeCmd(packet.cmd, packet.payload);
    } catch (e) {
      result = { ok: false, error: String(e && e.message ? e.message : e) };
    }

    try {
      if (host) {
        host.setAttribute(RES_ATTR, JSON.stringify(result));
      }
    } catch (e) {}
  });

  console.log(TAG, 'MAIN world 防检测与 Vue 接管模块已就绪 (v0.4.3)');
})();
