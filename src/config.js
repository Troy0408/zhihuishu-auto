/**
 * 选择器 / 文案配置 —— 已按 2026-10 实测页面校准（v0.4.0）。
 *
 * 页面来源：studyvideoh5.zhihuishu.com 共享课播放页
 *   - 播放器：video.js，<video id="vjs_container_html5_api" class="vjs-tech">
 *   - 弹题：  <div id="playTopic-dialog" class="el-dialog__wrapper dialog-test">
 *            选项 <li class="topic-item">，答完出现 <p class="answer">正确答案：X</p>
 *            底部按钮「关闭」
 *   - 章节：  <li class="clearfix video">，当前节带 current_play，
 *            已看完的节里有 <b class="time_icofinish">，在看的节里有 .el-progress + .progress-num
 *   - 「平时测试」是 <li class="chapter-test">，不要点
 *
 * 平台改版时优先改这里。
 */
window.ZHS_CONFIG = {
  version: '0.4.3',

  selectors: {
    video: ['#container video', 'video.vjs-tech', 'video'],

    // 弹题弹窗
    quizDialog: [
      '#playTopic-dialog',
      '.el-dialog__wrapper.dialog-test',
    ],
    quizOption: ['li.topic-item', '.topic-list li'],
    quizTitle: ['.topic-title'],
    quizAnswer: ['.answer'],
    quizPager: ['.el-pager li.number'],
    quizFooter: ['.dialog-footer .btn', '.el-dialog__footer .btn', '.el-dialog__footer button'],
    quizCloseBtn: ['.el-dialog__headerbtn', '.el-dialog__close'],

    // 章节列表
    chapterList: [
      '.box-right .chapterScrollbar li.clearfix.video',
      '.box-right li.clearfix.video',
      'li.clearfix.video',
    ],
    chapterDone: ['.time_icofinish'],
    chapterTest: ['li.chapter-test'],
    chapterActiveClass: 'current_play',
  },

  text: {
    // 提交/关闭类按钮（弹题底部）
    footerBtnRe: /^(关闭|提交|确定|确认|下一题|我知道了|知道了)$/,
    closeRe: /^(关闭|我知道了|确定|确认)$/,

    // “继续播放”类提示
    resumeRe: /^(继续观看|继续播放|继续学习|继续|我知道了|知道了)$/,

    // “下一节”按钮
    nextRe: /下一[节章个课]|下一节|下一章|播放下一个/,
  },
};
