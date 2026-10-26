/**
 * 番茄钟 —— 页面模板（独立项目）
 * ============================================================================
 * 纯字符串拼接，无模板引擎，零第三方依赖。
 *
 * 这个文件只负责产出 HTML 字符串；它不依赖任何外部数据文件 ——
 * 全部文案与默认值都集中在下面的 SITE / POMO 常量里，改文案只改这里。
 *
 * ⚠️ 两处必须与 assets/pomodoro.js 保持一致：
 *   - POMO.defaults  ←→  DEFAULTS   （默认时长 / 周期）
 *   - field(...) 的 min/max  ←→  LIMITS  （合法区间）
 *   不一致会导致「无 JS 时显示 25、有 JS 后变 30」这类错位。
 *
 * 三条纪律：
 *   1. 只吐类名与样式片段，绝不吐引号（引号混进 class 会产出脏属性）
 *   2. 用户可见文本一律经 esc() 转义
 *   3. 无 JS 时页面仍是一份可读、可理解的静态说明
 */

/* ------------------------------------------------------------------ 站点 --- */
/**
 * 站点级信息。这是独立项目，不从任何外部文件读数据。
 * 想改标题 / 页脚 / 导航，改这里。
 */
const SITE = {
  locale: "zh-CN",
  brand: "番茄钟",
  title: "番茄钟 · 专注计时器",
  description:
    "一个极简的番茄钟：专注 25 分钟，休息 5 分钟。带任务清单、今日统计与暗色模式。无需登录，数据只存在本地浏览器。",
  themeColorLight: "#ffffff",
  themeColorDark: "#141416",
  // 导航：单页项目，只留页内锚点
  nav: [
    { label: "计时器", href: "#top" },
    { label: "设置", href: "#settings" },
  ],
  footer: {
    copyright: "© 2026 番茄钟",
    note: "原生 HTML / CSS / JS 手写，零依赖。",
  },
};

/* ------------------------------------------------------------------ 文案 --- */
const POMO = {
  eyebrow: "POMODORO",
  title: "番茄钟",
  lead: "专注 25 分钟，休息 5 分钟。四个番茄之后，休息久一点。",
  defaults: { focus: 25, short: 5, long: 15, cycle: 4 },
  labels: { focus: "专注中", short: "短休息", long: "长休息" },
  hint:
    "空格开始 / 暂停，R 重置，S 跳过。任务、设置与统计只存在这台设备的浏览器里，不上传任何数据；换设备或清理浏览器数据会丢失。",
  noJs: "计时器需要 JavaScript。当前显示的是默认时长，开启脚本后即可使用。",
  tasks: {
    title: "这轮要做什么",
    placeholder: "加一件事…",
    submit: "添加",
    empty: "还没有任务。写一件要专注完成的事。",
    // 空输入点「添加」时的提示（不是错误，只是提醒）
    emptyHint: "先在上面写一件事，再点「添加」。",
  },
  stats: {
    done: "今日番茄",
    minutes: "专注分钟",
    streak: "连续天数",
  },
  theme: {
    label: "外观",
    options: [
      { value: "auto", label: "跟随系统" },
      { value: "light", label: "亮色" },
      { value: "dark", label: "暗色" },
    ],
  },
};

/* ---------------------------------------------------------------- 小工具 --- */
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const num = (n) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? String(Math.round(v)) : "0";
};

/* ------------------------------------------------------------ 头 / 页脚 --- */
const renderHeader = () => {
  const links = SITE.nav
    .map((l) => `<a class="header__link" href="${esc(l.href)}">${esc(l.label)}</a>`)
    .join("\n      ");

  return `<header class="header" id="site-header">
  <div class="wrap header__inner">
    <a class="header__brand" href="#top">${esc(SITE.brand)}</a>
    <nav class="header__nav" id="site-nav" aria-label="主导航">
      ${links}
    </nav>
    <button class="header__toggle" type="button" aria-label="打开菜单" aria-expanded="false" aria-controls="site-nav"><span></span></button>
  </div>
  <div class="header__progress" id="progress" aria-hidden="true"></div>
</header>`;
};

const renderFooter = () => `<footer class="footer">
  <div class="wrap footer__inner">
    <p>${esc(SITE.footer.copyright)}</p>
    <p>${esc(SITE.footer.note)}</p>
  </div>
</footer>`;

/* ---------------------------------------------------------------- 计时环 --- */
/**
 * 进度环。
 *
 * ⚠️ viewBox 必须留出描边宽度的一半，否则圆会被裁成方形。
 * 这是踩过的真 bug：原写法 viewBox="0 0 100 100" + r=52 + stroke-width=4，
 *   描边外沿 = 52 + 4/2 = 54，而 viewBox 中心到边只有 50 —— 超出 4 个单位。
 *   SVG 默认 overflow:hidden，超出的部分被直接切掉，
 *   渲染出来是「四边被削平的方形」，不是圆（实测外围 291px vs 容器 280px）。
 *
 * 现在 viewBox 放大到 116：半径 52 + 描边 2 + 余量 4 = 58，仍在 58 以内。
 * 圆心随之移到 58,58。JS 里的 RADIUS 常量要与此处的 r 保持一致。
 */
const RING_R = 52;
const RING_BOX = 116;
const RING_C = RING_BOX / 2;

const renderRing = () => `<svg class="pomo__ring" viewBox="0 0 ${RING_BOX} ${RING_BOX}" aria-hidden="true" focusable="false">
        <circle class="is-track" cx="${RING_C}" cy="${RING_C}" r="${RING_R}"></circle>
        <circle class="is-progress" cx="${RING_C}" cy="${RING_C}" r="${RING_R}"></circle>
      </svg>`;

/* ------------------------------------------------------------ 阶段进度点 --- */
/**
 * 一圈小点，表示当前 cycle 里走到第几个番茄。
 * 构建期渲染 N 个空点，JS 按进度加 .is-done / .is-now。
 * 无 JS 时就是 N 个空心点 —— 不假装已完成任何番茄。
 */
const renderSteps = (cycle) => {
  const dots = Array.from(
    { length: Math.max(1, Math.round(cycle)) },
    () => `<li class="pomo__step"></li>`
  ).join("");
  return `<ul class="pomo__steps" data-steps aria-hidden="true">${dots}</ul>`;
};

/* ------------------------------------------------------------ 今日统计 --- */
/**
 * 三个数字。无 JS 时显示 0 —— 这是诚实的兜底：
 * 没有脚本就读不到 localStorage，展示不了真实累计值。
 */
const renderStats = () => `<div class="pomo__stats reveal" style="--i:4">
        <div class="pomo__stat">
          <b data-stat="done">0</b>
          <span>${esc(POMO.stats.done)}</span>
        </div>
        <div class="pomo__stat">
          <b data-stat="minutes">0</b>
          <span>${esc(POMO.stats.minutes)}</span>
        </div>
        <div class="pomo__stat">
          <b data-stat="streak">0</b>
          <span>${esc(POMO.stats.streak)}</span>
        </div>
      </div>`;

/* ---------------------------------------------------------------- 任务 --- */
/**
 * 任务列表。初始只渲染空状态；条目全部由 JS 从 localStorage 渲染
 * （任务内容是用户输入，构建期不可能知道）。
 */
const renderTasks = () => `<section class="pomo__tasks reveal" style="--i:5" aria-labelledby="pomo-tasks-title">
        <p class="pomo__tasks-head">
          <span class="pomo__tasks-title" id="pomo-tasks-title">${esc(POMO.tasks.title)}</span>
          <span class="pomo__tasks-count" data-tasks-count></span>
        </p>

        <!-- onsubmit="return false" 是第二道保险，不是主要逻辑：
             正常路径由 pomodoro.js 的 submit 监听负责。
             但如果脚本没成功运行（加载失败 / 早期报错），表单会走**原生提交**
             把页面刷掉 —— 表现为「点了没反应，输入也没了」。
             有这一行，最坏情况也只是"没加上"，不会丢输入、不会刷新。 -->
        <form class="pomo__task-add" data-task-form onsubmit="return false">
          <input class="pomo__task-input" id="pomo-task-input" data-task-input type="text"
                 aria-label="${esc(POMO.tasks.title)}"
                 placeholder="${esc(POMO.tasks.placeholder)}" autocomplete="off"
                 maxlength="120">
          <button class="pomo__task-submit" type="submit">${esc(POMO.tasks.submit)}</button>
        </form>

        <!-- 空输入点「添加」时的反馈。
             刻意做成「始终存在的 live region，只改文字」，而不是 hidden 切换：
             display:none 的元素不在无障碍树里，取消 hidden 时读屏不一定播报，
             结果就是视力正常用户有反馈、读屏用户仍然「没反应」。
             提示文案放 data-hint-text，JS 负责搬进这个区域（内容与行为分离）。 -->
        <p class="pomo__task-hint" data-task-hint
           data-hint-text="${esc(POMO.tasks.emptyHint)}"
           role="status" aria-live="polite"></p>

        <p class="pomo__task-empty" data-task-empty>${esc(POMO.tasks.empty)}</p>
        <ul class="pomo__task-list" data-task-list></ul>
      </section>`;

/* ---------------------------------------------------------------- 设置项 --- */
const field = (key, label, value, min, max, unit = "分钟") => `<div class="pomo__field">
          <label for="set-${key}">${esc(label)}</label>
          <input id="set-${key}" data-set="${key}" type="number" inputmode="numeric"
                 min="${min}" max="${max}" step="1" value="${num(value)}"
                 aria-describedby="set-${key}-unit">
          <span id="set-${key}-unit" hidden>${esc(unit)}</span>
        </div>`;

/**
 * 主题单选：三个 radio，name 相同即互斥。
 * ⚠️ 属性名用 data-theme-choice，不要用 data-theme ——
 * 主题值最终写在 <html data-theme="..."> 上，若两者同名，
 * document.querySelectorAll("[data-theme]") 会把 <html> 也选中，
 * 同步 radio 选中态时就会误改根元素。
 */
const renderTheme = () => `<div class="pomo__theme">
          <span class="pomo__theme-label">${esc(POMO.theme.label)}</span>
          ${POMO.theme.options
            .map(
              (o, i) => `<label class="pomo__radio">
            <input type="radio" name="pomo-theme" value="${esc(o.value)}" data-theme-choice${
                i === 0 ? " checked" : ""
              }>
            <span>${esc(o.label)}</span>
          </label>`
            )
            .join("\n          ")}
        </div>`;

/* ---------------------------------------------------------------- 整页 ----- */
export function renderPage() {
  const d = POMO.defaults;

  return `<!doctype html>
<html lang="${esc(SITE.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(SITE.title)}</title>
<meta name="description" content="${esc(SITE.description)}">
<meta name="theme-color" content="${esc(SITE.themeColorLight)}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${esc(SITE.themeColorDark)}" media="(prefers-color-scheme: dark)">
<!-- 内联 SVG 图标，避免额外请求 -->
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='13' fill='none' stroke='%23c0392b' stroke-width='3'/%3E%3C/svg%3E">
<!-- 先于样式表做两件事，避免闪烁：
     1. 标记「JS 可用」—— 入场动效的初始态只挂在 .js 下
     2. 把已保存的主题写到 <html> 上 —— 否则暗色用户会看到一瞬白屏 -->
<script>
document.documentElement.classList.add("js");
(function () {
  try {
    var saved = localStorage.getItem("pomodoro:v2");
    var t = saved ? (JSON.parse(saved) || {}).theme : null;
    if (t === "dark" || t === "light") {
      document.documentElement.setAttribute("data-theme", t);
    }
  } catch (e) {}
})();
</script>
<link rel="stylesheet" href="assets/pomodoro.css">
</head>
<body>
<a class="skip" href="#main">跳到主要内容</a>
${renderHeader()}
<main id="main">
  <section class="pomo" id="top" data-phase="focus" aria-labelledby="pomo-title">
    <div class="wrap pomo__inner">

      <p class="pomo__eyebrow reveal" style="--i:0">${esc(POMO.eyebrow)}</p>
      <h1 class="pomo__title reveal" id="pomo-title" style="--i:1">${esc(POMO.title)}</h1>
      <p class="pomo__lead reveal" style="--i:1">${esc(POMO.lead)}</p>

      <div class="pomo__dial reveal" style="--i:2">
        ${renderRing()}
        <p class="pomo__time" role="timer" aria-live="off">${String(d.focus).padStart(2, "0")}:00</p>
      </div>

      <p class="pomo__label" aria-live="polite">${esc(POMO.labels.focus)}</p>

      ${renderSteps(d.cycle)}

      <div class="pomo__status-line reveal" style="--i:3" aria-hidden="true"></div>

      <div class="pomo__controls reveal" style="--i:3">
        <button class="pomo__btn pomo__btn--primary" type="button" data-action="toggle">开始</button>
        <button class="pomo__btn" type="button" data-action="reset">重置</button>
        <button class="pomo__btn pomo__btn--ghost" type="button" data-action="skip">跳过</button>
      </div>

      ${renderStats()}

      ${renderTasks()}

      <p class="pomo__hint pomo__needs-js reveal" style="--i:6">${esc(POMO.hint)}</p>
      <noscript><p class="pomo__hint">${esc(POMO.noJs)}</p></noscript>

      <details class="pomo__settings reveal" id="settings" style="--i:7">
        <summary>设置</summary>
        <div class="pomo__grid">
          ${field("focus", "专注时长", d.focus, 1, 180)}
          ${field("short", "短休息", d.short, 1, 60)}
          ${field("long", "长休息", d.long, 1, 120)}
          ${field("cycle", "每几个番茄长休息", d.cycle, 1, 12, "个")}
        </div>

        <p class="pomo__hint">${renderTheme()}</p>

        <p class="pomo__hint">
          <label><input type="checkbox" data-set="sound"> 阶段结束播放提示音</label><br>
          <label><input type="checkbox" data-set="autoNext"> 自动进入下一阶段</label>
        </p>

        <button class="pomo__notify" type="button" data-notify hidden>开启桌面通知</button>

        <p class="pomo__hint">
          <button class="pomo__notify" type="button" data-clear-tasks>清空已完成任务</button>
        </p>
      </details>

    </div>
  </section>

  <!-- 启动自检报警条：脚本没成功运行时由下面的内联脚本显示 -->
  <p class="pomo__alert" data-boot-alert role="alert" hidden></p>
</main>
${renderFooter()}
<script src="assets/main.js" defer></script>
<script src="assets/pomodoro.js" defer></script>
<!-- 启动自检。
     目的：脚本加载失败 / 早期抛错时，不要让用户只看到"点了没反应"，
     而是直接说明原因 —— 否则排查要来回好几轮。
     注意这段**必须内联且不 defer**：外部脚本挂了它也照样执行。 -->
<script>
(function () {
  window.setTimeout(function () {
    if (window.__POMO_BOOTED) return;
    var el = document.querySelector("[data-boot-alert]");
    if (!el) return;
    var srcs = [];
    var nodes = document.querySelectorAll("script[src]");
    for (var i = 0; i < nodes.length; i++) srcs.push(nodes[i].getAttribute("src"));
    el.textContent =
      "计时脚本没有成功运行，所以按钮暂时无效。" +
      "常见原因：① assets 目录没有和 index.html 放在同一层；" +
      "② 浏览器拦截了本地脚本（试试用 npm run dev 起本地服务器访问）；" +
      "③ 控制台有红色报错。" +
      "应有的脚本：" + (srcs.join("、") || "(无)");
    el.hidden = false;
  }, 1500);
})();
</script>
</body>
</html>
`;
}

export default renderPage;
export { SITE, POMO };
