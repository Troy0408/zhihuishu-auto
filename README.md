# 智慧树自动刷课（自用扩展）v0.4.1

一个只在本机运行的 Chrome / Edge 扩展（MV3），针对 **studyvideoh5.zhihuishu.com** 的共享课播放页：

- 自动播放、自动静音，卡住/被暂停时自动恢复
- 播放中弹出「弹题」时自动识别正确选项（`result === 1`，支持单选/多选/判断/多题连弹），答完安全关闭弹窗继续播放
- 一节播完自动切下一节，自动跳过已完成（`100%`）的章节；打开页面若当前节已完成，自动切到未完成章节
- **未满重播补刷**：若某节视频播到底但实际结算未完成（如只算了 `74%` 未出现蓝色完成对勾），自动从 `00:00` 重新播放该节，直到出现完成对勾并落库后再切下一节
- 切到后台 / 最小化时，保持视频继续播放，并通过媒体 `timeupdate` 事件补偿后台标签页计时器节流

v0.2 已用真实保存的课程页 HTML 校准过选择器，不再是猜测。

v0.4.0 针对 `stuStudy.js` 与 `app.js` 的全部 5 处反脚本检测做了完整逆向与彻底绕过（详见第七节）。

> 只操作你自己的浏览器和账号；不联网、不上传数据，仅申请了 `storage` 权限。
> 课程页自己的弹题提示写着「弹题是为了帮助同学们巩固知识点，不会影响到大家作业和考试的成绩」，
> 但平台仍可能对自动化行为做风控，是否用于重要课程/主账号请自行判断。

---

## 一、安装

> 需要 Chrome 111+ 或 Edge 111+（用了 content script 的 `world: "MAIN"`）。

### Chrome

1. 打开 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」
4. 选择本文件夹 `zhihuishu-auto`
5. 工具栏出现拼图图标 → 固定「智慧树自动刷课」

### Edge

1. 打开 `edge://extensions`
2. 左下角打开「开发人员模式」
3. 点「加载解压缩的扩展」
4. 选择本文件夹
5. 固定到工具栏

---

## 二、使用

1. 打开课程学习页（形如 `https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=...`）
2. 点一下播放，让播放器加载出视频
3. 点扩展图标，确认状态是「播放中 x:xx / y:yy」
4. 之后可以切到别的标签页或最小化

| 选项 | 说明 |
| --- | --- |
| 总开关 | 关闭后扩展什么都不做 |
| 自动静音 | 每 0.9s 检查一次 `video.muted`，被平台改回来会重新静音 |
| 播完自动下一节 | 播完 4 秒后，若视频仍停在结尾，就点章节列表里的下一节 |
| 跳过已完成章节 | 已完成的节（有对勾图标 `.time_icofinish`）自动跳过；打开页面时若当前节已完成，会跳到后面第一个未完成节 |
| 切后台/最小化继续播 | 伪装页面可见 + 有焦点，并自动点「继续观看」类提示 |
| 自动答弹题 | 检测 `#playTopic-dialog`，点选项、等判定、点关闭 |
| 答题策略 | 「顺序尝试」每次换一个选项 / 「随机选」 |
| 右下角状态角标 | 可选，方便确认在运行 |

统计（已答弹题 / 切换章节 / 恢复播放）存在 `chrome.storage.local`，可点「重置统计」清零。

---

## 三、实测页面结构（v0.2 依据）

保存的页面是 `https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=...`，关键结构：

**播放器**：video.js
```html
<video id="vjs_container_html5_api" class="vjs-tech" src="https://wsvideo.zhihuishu.com/...mp4">
```

**弹题弹窗**
```html
<div id="playTopic-dialog" class="el-dialog__wrapper dialog-test">
  <div class="el-dialog">
    <p class="topic-title">...【单选题】题干...</p>
    <ul class="topic-list">
      <li class="topic-item"><span class="topic-option-item">A.</span><div class="item-topic">...</div></li>
    </ul>
    <p class="answer">正确答案：C</p>      <!-- 作答后出现 -->
    <div class="dialog-footer"><div class="btn">关闭</div></div>
  </div>
</div>
```
点选项即判分（错误会显示「错误」并给出正确答案），再点「关闭」继续。扩展按这个流程做。

**章节列表**（在右侧 `.box-right` 的 `.chapterScrollbar` 里）
```html
<li class="clearfix video current_play">   <!-- 当前节 -->
  <b class="pl5 hour">2.1</b>
  <span class="catalogue_title">...</span>
  <div class="el-progress" aria-valuenow="60">...</div>  <!-- 在看的进度 -->
</li>
<li class="clearfix video">                 <!-- 已完成 -->
  ...
  <b class="time_icofinish"></b>            <!-- 有对勾 = 已完成 -->
</li>
<li class="chapter-test">平时测试</li>        <!-- 不点 -->
```
完成判定用「有没有 `.time_icofinish`」，当前节用 `.current_play`，章节测试 `li.chapter-test` 永远不点。

---

## 四、调试

打开课程页按 F12：

- Console 搜 `[ZHS]`：所有动作日志（绑定视频、作答、切节、跳过）
- `__ZHS_STATUS__()`：当前状态对象（是否有视频、是否暂停、弹题是否被识别、统计）
- 弹题没被识别时，在弹题打开的状态下执行：
  ```js
  document.querySelector('#playTopic-dialog')?.outerHTML
  ```
  复制结果发我，我按新结构改 `src/config.js`。

扩展代码里所有 DOM 线索都在 [src/config.js](src/config.js)，改完在 `chrome://extensions` 点扩展卡片上的刷新按钮即可，不用重装。

---

## 五、已知限制

1. **只做弹题**，不碰章节测验（`li.chapter-test` 的「平时测试」）、作业、考试、直播、讨论区。
2. **1 倍速原速**播放（没有启用倍速）。想加速可以告诉我，但倍速更容易被平台识别。
3. 弹题目前按「点一个选项 → 等判定 → 关闭」处理；如果遇到多选题需要点「提交」，已做了兼容（会找「提交/确定」按钮），但没实测过。
4. 填空、拖拽类弹题不会做，会等 1.5 秒后直接关掉，保证视频能继续。
5. 「切后台继续播」是页面层伪装：`document.hidden`/`visibilityState`/`hasFocus` 全部伪装成前台。
   Chrome 仍会对后台标签页的定时器节流（最低 1 分钟一次），所以另外挂了 `MutationObserver`：
   弹题 DOM 一出现就立即处理，不依赖定时器。
6. 平台改版后选择器可能失效，改 [src/config.js](src/config.js) 即可。

---

## 六、目录结构

```
zhihuishu-auto/
├─ manifest.json           # MV3 清单
├─ src/
│  ├─ background.js        # 默认配置 + 图标角标
│  ├─ main-world.js        # document_start：防检测 + Vue 实例接管
│  ├─ config.js            # 所有选择器/文案
│  ├─ app.js               # 播放控制 + 弹题作答 + 补刷重播 + 章节切换
│  ├─ popup.html/.css/.js  # 扩展面板
└─ README.md
```

---

## 七、关于「检测到异常脚本」（v0.4.0 已彻底解决）

逆向课程页 `stuStudy.js` 与 `app.js` 后，平台共有 **5 处**反脚本检测：

1. **弹题选项点击（`topicClick`）**：
   ```js
   'isTrusted' in e ? e.isTrusted && e.clientX && e.clientY && this.topicClickQot(opt, 1) : this.topicClickQot(opt, 2)
   ```
   合成 `MouseEvent` 的 `'isTrusted' in e` 为 `true` 且 `e.isTrusted === false`，导致合成点击选不上任何选项。
2. **弹题关闭按钮（`closeTest`）—— v0.3 被拦截的直接原因**：
   ```js
   false !== e.isTrusted ? ... : this.notTrustScript()
   ```
   只要用合成事件点弹题的「关闭」按钮（`e.isTrusted === false`），会**100% 立即触发** `this.notTrustScript()`，弹出「检测到异常脚本，为保证您的正常学习进度，请您关闭插件后，回到学堂重新进入视频学习页正常学习」并跳转回首页。
3. **章节列表点击（`videoClick`）**：最后一个参数是 `PointerEvent` 且 `isTrusted === false` 时触发 `notTrustScript()`。
4. **播放器容器点击（`#container`）**：挂了捕获阶段 `click` 监听，`!e.isTrusted` 直接报错并跳走。
5. **每 60 秒环境自检（`checkout`）与倍速检测（`onTime`）**：
   - 使用页面头部冻结的 `window.originFunction.FunctionToString` 检查 `XMLHttpRequest`、`XMLHttpRequest.prototype.open`、`Element.prototype.addEventListener` 是否为 `[native code]`，以及 `!window.OCS`。
   - 检查 `video.playbackRate > 1.8`。

### v0.4.0 的解决方式

1. **接管 `stuStudy` Vue 组件实例（`src/main-world.js`）**：
   - 在页面 `mounted` 钩子抹除 `.video-study.__vue__` 之前拦截并捕获 Vue 实例（同时支持从 `#app.__vue__.$children` 递归查找）。
   - 直接将实例上的 `notTrustScript`、`collectLog`、`checkout`、`checkoutNotTrustScript` 置空并清除 `checkTimer` 定时器。
   - **弹题作答与关窗不再派发任何合成 DOM 事件**：直接读取 `vm.topicInfo.lessonTestQuestionUseInterfaceDtos` 中带有 `result === 1` 的正确选项调用 `vm.topicClickQot(opt, 1)`，作答完毕后调用 `vm.closeTest({ isTrusted: true })` 安全关闭。
   - **章节切换**：直接调用 `vm.videoClick(...)`（与平台自带的 `videoNext()` 一致），不产生合成事件。
2. **在 `document_start` 保护 `Function.prototype.toString` 与 `window.OCS`**：
   - 在页面内联 `<script>` 创建并冻结 `window.originFunction` 之前包装 `Function.prototype.toString`，即使浏览器里同时开启了沉浸式翻译、篡改猴等会改写 `XMLHttpRequest.prototype.open` 或 `addEventListener` 的扩展，平台自检也始终读到原生的 `[native code]`。
3. **`window` 捕获阶段护栏**：
   - 在 `window` 捕获阶段拦截一切落入 `#container` 的非可信点击（`stopImmediatePropagation`），先于 `#container` 自身的捕获监听器执行。

## 八、风险提示

这类自动化本质上是替你“看课”，可能违反智慧树平台规则或学校的学术诚信要求，平台也有检测异常播放/答题的手段。
本扩展做了保守处理（真实鼠标事件、随机延迟、不倍速、不加显眼 DOM），但不承诺不被检测。
建议先用一门不重要的课试跑，确认进度正常后再考虑主账号。
