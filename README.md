# 智慧树自动刷课 (zhihuishu-auto)

一款轻量、纯净、无需配置题库的 **Chrome / Edge 浏览器扩展（Manifest V3）**，专为智慧树（知到）共享课学习页（`studyvideoh5.zhihuishu.com`）设计。

所有逻辑均在本地浏览器运行，不联网、不收集任何个人数据，仅使用 `chrome.storage.local` 保存开关配置与本地统计。

---

## ✨ 功能特性

- **自动播放与静音**：进入课程页后自动静音并开始播放，遇到缓冲、意外暂停或习惯提醒弹窗时自动恢复。
- **弹题自动满分作答**：直接从页面 Vue 实例数据中读取标准答案（`result === 1`），支持单选题、多选题、判断题及多题连弹，作答后安全关闭弹窗并继续播放。
- **未满进度自动重播补刷**：当视频播放到末尾但实际结算进度未达标（例如只结算到 `74%`、右侧目录未出现蓝色完成对勾 `.time_icofinish`）时，自动从 `00:00` 重新播放当前小节，直到拿到完成对勾并落库保存后再切换下一集。
- **自动切换未完成章节**：当前小节完成后自动切换到下一未完成小节；打开页面时若默认停留在已完成小节，自动跳转到第一个未完成小节（自动跳过「平时测试」等非视频项）。
- **后台 / 最小化防暂停与计时补偿**：伪装页面前台可见与焦点状态，并利用媒体线程 `timeupdate` 事件补偿后台标签页 `setInterval` 节流，防止后台挂机时学习时长少记。
- **内置反检测保护**：接管页面 `stuStudy` Vue 组件实例与原生函数自检，彻底规避「检测到异常脚本」拦截。

---

## 📦 安装方法

> **环境要求**：Chrome 111+ 或 Edge 111+（依赖 Manifest V3 的 `world: "MAIN"` 内容脚本支持）。

### 1. 获取源码

克隆本仓库，或在页面右上角点击 **Code → Download ZIP** 下载并解压到本地任意目录：

```bash
git clone https://github.com/Troy0408/zhihuishu-auto.git
```

### 2. 加载扩展

#### Chrome 浏览器
1. 地址栏输入 `chrome://extensions` 并回车。
2. 打开右上角的「**开发者模式**」。
3. 点击左上角「**加载已解压的扩展程序**」，选择解压后的 `zhihuishu-auto` 文件夹。
4. 点击浏览器右上角拼图图标，将「**智慧树自动刷课**」固定到工具栏。

#### Edge 浏览器
1. 地址栏输入 `edge://extensions` 并回车。
2. 打开左侧或左下角的「**开发人员模式**」。
3. 点击「**加载解压缩的扩展**」，选择解压后的 `zhihuishu-auto` 文件夹。
4. 将扩展图标固定到工具栏。

---

## 🚀 使用说明

1. 登录智慧树，进入共享课视频学习页（网址形如 `https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=...`）。
2. 插件会自动接管播放器与章节状态；点击工具栏上的扩展图标可查看当前运行状态（如 `播放中 3:20 / 11:14 · 结算进度 74%` 或 `· 已完成✓`）。
3. 挂机期间可自由切换到其他标签页或最小化浏览器窗口。

### 面板配置项

| 选项 | 默认值 | 说明 |
| :--- | :---: | :--- |
| **总开关** | 开启 | 关闭后插件暂停一切自动操作 |
| **自动静音** | 开启 | 自动将视频设为静音，防止挂机声音打扰并确保浏览器允许自动播放 |
| **播完自动下一节** | 开启 | 当前小节结算完成（出现对勾）后自动切换到下一节 |
| **跳过已完成章节** | 开启 | 自动跳过已带对勾图标（`.time_icofinish`）的小节 |
| **切后台/最小化继续播** | 开启 | 伪装页面可见性与焦点，并自动关闭「学前必读」「弹图」「学习习惯提醒」等阻断弹窗 |
| **自动答弹题** | 开启 | 自动作答播放期间弹出的测验题并安全关闭弹窗 |
| **答题策略** | 自动选正解 | 「自动选正解（推荐）」直接读取选项 `result === 1` 满分作答；「随机选」在无标记时随机选择 |
| **页面右下角状态角标** | 关闭 | 开启后在视频页右下角显示小型运行状态提示 |

---

## 🛠️ 技术原理与防检测机制

智慧树课程学习页（`stuStudy.js` + `app.js`）包含 5 处针对自动化脚本的检测：

1. **弹题选项点击检测（`topicClick`）**：检查点击事件对象的 `e.isTrusted && e.clientX && e.clientY`，普通脚本派发的合成 `MouseEvent`（`isTrusted: false`）会被静默忽略。
2. **弹题关闭按钮检测（`closeTest`）**：检查 `false !== e.isTrusted`，一旦用合成事件点击「关闭」按钮，立即触发 `this.notTrustScript()`，弹出「检测到异常脚本」警告并强制跳回首页。
3. **章节列表点击检测（`videoClick`）**：检查末尾参数是否为 `PointerEvent` 且 `isTrusted === false`。
4. **播放器容器捕获监听（`#container`）**：在捕获阶段监听 `click` 事件，发现 `!e.isTrusted` 即报警拦截。
5. **定时环境自检（`checkout`）与倍速检测（`onTime`）**：每 60 秒利用页面头部冻结的 `window.originFunction.FunctionToString` 校验 `XMLHttpRequest`、`XMLHttpRequest.prototype.open`、`Element.prototype.addEventListener` 是否为原生 `[native code]`、检查 `window.OCS` 是否存在，以及校验 `video.playbackRate <= 1.8`。

### 本扩展的解决方案

- **Vue 实例级原生调用（[src/main-world.js](src/main-world.js)）**：
  - 在页面 `mounted` 钩子抹除 `.video-study.__vue__` 之前拦截并保存 `stuStudy` Vue 组件实例（同时支持从 `#app.__vue__.$children` 递归检索）。
  - 将实例上的 `notTrustScript`、`collectLog`、`checkout`、`checkoutNotTrustScript` 置空并清理 `checkTimer` 定时器。
  - **弹题作答与关窗零合成事件**：直接读取 `vm.topicInfo.lessonTestQuestionUseInterfaceDtos` 中的题目选项，调用 `vm.topicClickQot(opt, 1)` 完成作答，随后调用 `vm.closeTest({ isTrusted: true })` 关闭弹窗。
  - **章节切换零合成事件**：直接调用 `vm.videoClick(...)` 切换小节（与平台自带的 `videoNext()` 完全一致）。
- **`document_start` 原生函数保护**：
  - 在页面内联 `<script>` 冻结 `window.originFunction` 之前保护 `Function.prototype.toString` 与 `window.OCS`，即使浏览器同时安装了沉浸式翻译、篡改猴等会改写 `XMLHttpRequest` 或 `addEventListener` 的扩展，也不会误触平台的 60 秒环境自检。
- **`#container` 捕获阶段护栏**：
  - 在 `window` 捕获阶段拦截一切落入 `#container` 内部的非可信点击，先于播放器容器自身的监听器执行。

---

## 📂 目录结构

```text
zhihuishu-auto/
├─ manifest.json        # Chrome / Edge MV3 扩展清单
├─ src/
│  ├─ background.js     # Service Worker：默认配置初始化与图标角标状态
│  ├─ main-world.js     # MAIN world (document_start)：防检测护栏与 Vue 实例接管
│  ├─ config.js         # 页面 DOM 选择器与匹配规则配置
│  ├─ app.js            # ISOLATED world：播放控制、弹题调度、未完重播与章节切换
│  ├─ popup.html        # 扩展弹出面板结构
│  ├─ popup.css         # 扩展弹出面板样式
│  └─ popup.js          # 扩展弹出面板交互逻辑
└─ README.md            # 项目说明文档
```

---

## 🔍 调试与排错

在课程学习页按 `F12` 打开开发者工具（Console）：

- 过滤 `[ZHS]` 或 `[ZHS-MW]` 可查看扩展的详细运行日志（Vue 实例接管、弹题作答、重播补刷、章节切换等）。
- 在控制台输入 `__ZHS_STATUS__()` 回车，可查看当前视频状态、Vue 接管状态、当前小节结算百分比及统计数据。
- 若平台前端改版导致部分选择器变化，可修改 [src/config.js](src/config.js)，随后在浏览器扩展管理页点击刷新按钮即可生效。

---

## ⚠️ 免责声明

1. 本项目仅供个人学习与浏览器扩展技术交流使用，请勿用于任何商业用途。
2. 自动化脚本可能违反所在院校或智慧树平台的相关规定，使用本扩展产生的一切风险与后果（包括但不限于学习进度异常、账号风控等）由使用者自行承担。
