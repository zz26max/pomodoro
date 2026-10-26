/**
 * 番茄钟 —— 计时状态机（完整版）
 * ============================================================================
 * 零依赖。与首页 main.js 同一套约定：
 *   - 立即执行函数 + "use strict"
 *   - 只在 <html class="js"> 时接管（无 JS 时页面显示静态默认值）
 *   - 无 JS 时内容一字不少
 *
 * 相对占位版的增量：
 *   - 任务列表（增删改、完成勾选）
 *   - 今日统计（番茄数 / 专注分钟 / 连续天数，按自然日归档）
 *   - 主题切换（自动 / 亮 / 暗）
 *   - 键盘快捷键 R / S
 *   - 存储升到 pomodoro:v2（不迁移旧数据，见 README）
 *
 * 四个设计要点，都是踩过的坑：
 *
 * 1. 不用 setInterval 累减计数。
 *    后台标签页里 setInterval 会被节流到 ≥1s 甚至暂停，累减必然走慢。
 *    这里用「记录目标时间戳 + rAF 只负责刷新显示」，
 *    切回前台时读 Date.now() 一次就自动追平，不会累计误差。
 *
 * 2. 阶段切换走 settle() 单一入口。
 *    任何路径（计时归零、点跳过）都走它，避免状态散落。
 *
 * 3. 「今日」以本地自然日为准（YYYY-MM-DD），不用 UTC。
 *    用 toISOString 会在东八区把凌晨 0–8 点的番茄算到前一天。
 *
 * 4. 所有写入 localStorage 的路径都包 try/catch。
 *    隐私模式下 setItem 会抛异常，不能让整个计时器挂掉。
 */

(function () {
  "use strict";

  var root = document.documentElement;
  if (!root.classList.contains("js")) return;

  /* ------------------------------------------------------------ 常量 ------ */

  var STORE_KEY = "pomodoro:v2";

  // 阶段定义。id 同时是 DOM 上的 data-phase 值，CSS 靠它配色。
  var PHASES = {
    focus: { label: "专注中" },
    short: { label: "短休息" },
    long: { label: "长休息" }
  };

  // 默认设置（分钟）。改这里等于改「无 JS 时的静态展示值」。
  var DEFAULTS = {
    focus: 25,
    short: 5,
    long: 15,
    // 每完成多少个番茄进入一次长休息
    cycle: 4,
    // 自动开始下一阶段：默认关（自用场景更希望自己掌控节奏）
    autoNext: false,
    sound: true,
    // auto | light | dark
    theme: "auto"
  };

  // 各设置项的合法区间。手输也会被钳到这里。
  var LIMITS = {
    focus: [1, 180],
    short: [1, 60],
    long: [1, 120],
    cycle: [1, 12]
  };

  // 任务名长度上限（与模板里的 maxlength 一致）
  var TASK_MAX = 120;

  // 统计保留天数：只留最近 60 天，避免 localStorage 无限膨胀
  var HISTORY_DAYS = 60;

  /* ------------------------------------------------------------ 工具 ------ */

  var $ = function (sel) {
    return document.querySelector(sel);
  };

  var clamp = function (n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  };

  // 秒 → mm:ss（超过 100 分钟也能正确显示，不截断）
  var fmt = function (totalSec) {
    var s = Math.max(0, Math.ceil(totalSec));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return (m < 10 ? "0" : "") + m + ":" + (r < 10 ? "0" : "") + r;
  };

  /**
   * 本地自然日的 YYYY-MM-DD。
   * 不能用 toISOString().slice(0,10) —— 那是 UTC，
   * 东八区凌晨 0–8 点会被算成前一天。
   */
  var today = function () {
    var d = new Date();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return (
      d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day
    );
  };

  // 生成唯一 id。不用 crypto.randomUUID（老浏览器没有）
  var uid = function () {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  };

  /* -------------------------------------------------------- 状态与存储 --- */

  var state = {
    phase: "focus",
    duration: DEFAULTS.focus * 60,
    endAt: null,
    remain: DEFAULTS.focus * 60,
    running: false,
    // 本轮 cycle 内已完成的番茄数（0..cycle）
    cycleDone: 0
  };

  var settings = Object.assign({}, DEFAULTS);

  // 历史：{ "2026-10-15": { done: 3, seconds: 4500 }, ... }
  var history = {};

  // 任务：[{ id, text, done, createdAt }]
  var tasks = [];

  var loadAll = function () {
    var raw;
    try {
      raw = localStorage.getItem(STORE_KEY);
    } catch (e) {
      return; // 隐私模式下读不了，用默认值
    }
    if (!raw) return;

    var saved;
    try {
      saved = JSON.parse(raw);
    } catch (e) {
      return; // 内容损坏：整份丢弃，用默认值（比崩掉好）
    }
    if (!saved || typeof saved !== "object") return;

    /* —— 设置：逐项校验 ——
       类型不对或超范围的回落默认值，但**不整份丢弃**，
       其他项的有效设置应当保留。 */
    Object.keys(DEFAULTS).forEach(function (k) {
      var v = saved.settings ? saved.settings[k] : undefined;

      if (typeof DEFAULTS[k] === "number") {
        if (typeof v === "number" && isFinite(v)) {
          settings[k] = clamp(Math.round(v), LIMITS[k][0], LIMITS[k][1]);
        }
      } else if (typeof DEFAULTS[k] === "boolean") {
        if (typeof v === "boolean") settings[k] = v;
      } else if (k === "theme") {
        if (v === "auto" || v === "light" || v === "dark") settings.theme = v;
      }
    });

    // 主题引导脚本已经把 data-theme 写在 <html> 上了，这里保持一致

    /* —— 历史：只收形状正确的条目 —— */
    if (saved.history && typeof saved.history === "object") {
      Object.keys(saved.history).forEach(function (day) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
        var e = saved.history[day];
        if (!e || typeof e !== "object") return;
        var done = typeof e.done === "number" && isFinite(e.done) && e.done >= 0
          ? Math.floor(e.done) : 0;
        var secs = typeof e.seconds === "number" && isFinite(e.seconds) && e.seconds >= 0
          ? Math.floor(e.seconds) : 0;
        history[day] = { done: done, seconds: secs };
      });
    }

    /* —— 任务 —— */
    if (Array.isArray(saved.tasks)) {
      tasks = saved.tasks
        .filter(function (t) {
          return t && typeof t.text === "string" && t.text.trim();
        })
        .slice(0, 200) // 上限，防脏数据
        .map(function (t) {
          return {
            id: typeof t.id === "string" && t.id ? t.id : uid(),
            text: t.text.trim().slice(0, TASK_MAX),
            done: !!t.done,
            createdAt: typeof t.createdAt === "number" ? t.createdAt : Date.now()
          };
        });
    }

    // 本轮 cycle 进度也存，刷新页面不丢
    if (typeof saved.cycleDone === "number" && isFinite(saved.cycleDone) && saved.cycleDone >= 0) {
      state.cycleDone = Math.floor(saved.cycleDone) % Math.max(1, settings.cycle);
    }
  };

  var save = function () {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          v: 2,
          settings: settings,
          history: history,
          tasks: tasks,
          cycleDone: state.cycleDone
        })
      );
    } catch (e) {
      /* 存不进去（隐私模式 / 配额满）也不影响本次使用 */
    }
  };

  /* ---------------------------------------------------------- DOM 引用 --- */

  var el = {
    page: $(".pomo"),
    time: $(".pomo__time"),
    label: $(".pomo__label"),
    ring: $(".pomo__ring .is-progress"),
    statusLine: $(".pomo__status-line"),
    steps: $("[data-steps]"),
    primary: $('[data-action="toggle"]'),
    reset: $('[data-action="reset"]'),
    skip: $('[data-action="skip"]'),
    // 用 data-notify 精确定位：.pomo__notify 这个类名同时被
    // 「清空已完成任务」按钮复用，靠 $(".pomo__notify") 取首个太脆弱
    notify: $("[data-notify]"),
    stats: {
      done: $('[data-stat="done"]'),
      minutes: $('[data-stat="minutes"]'),
      streak: $('[data-stat="streak"]')
    },
    task: {
      form: $("[data-task-form]"),
      input: $("[data-task-input]"),
      list: $("[data-task-list]"),
      empty: $("[data-task-empty]"),
      count: $("[data-tasks-count]"),
      clear: $("[data-clear-tasks]"),
      // 空输入时的提示（默认隐藏，仅在有反馈需要时露出）
      hint: $("[data-task-hint]")
    },
    fields: {
      focus: $('[data-set="focus"]'),
      short: $('[data-set="short"]'),
      long: $('[data-set="long"]'),
      cycle: $('[data-set="cycle"]')
    }
  };

  if (!el.page || !el.time) return;

  /* 环半径，必须与 src/index.mjs 里 RING_R 一致。
     周长按它实算 —— 写死数字会在改半径时错位（进度环就会走不到头）。 */
  var RADIUS = 52;
  var CIRC = 2 * Math.PI * RADIUS;

  // 环的周长按 SVG 实际半径算，写死会在改尺寸时错位
  if (el.ring) el.ring.setAttribute("stroke-dasharray", String(CIRC));

  /* -------------------------------------------------------- 渲染：计时 --- */

  var render = function () {
    var remain = state.running
      ? Math.max(0, (state.endAt - Date.now()) / 1000)
      : state.remain;

    el.time.textContent = fmt(remain);

    // 进度：已走过的比例（0 → 1）
    var ratio = state.duration > 0 ? clamp(1 - remain / state.duration, 0, 1) : 0;

    if (el.ring) {
      // dashoffset 从 0 到 CIRC：0 = 整圈，CIRC = 空
      el.ring.style.strokeDashoffset = String(CIRC * ratio);
    }
    el.page.style.setProperty("--p", String(ratio));

    el.label.textContent = PHASES[state.phase].label;

    if (el.primary) {
      el.primary.textContent = state.running
        ? "暂停"
        : remain < state.duration
        ? "继续"
        : "开始";
    }

    // 标签页标题：切到别的标签时也能瞄一眼进度
    document.title = state.running
      ? fmt(remain) + " · " + PHASES[state.phase].label + " · 番茄钟"
      : "番茄钟";
  };

  /* ------------------------------------------------------ 渲染：进度点 --- */

  var renderSteps = function () {
    if (!el.steps) return;

    var total = Math.max(1, settings.cycle);
    var kids = el.steps.children;

    // 设置里改了 cycle 之后点数要对得上：多退少补
    while (kids.length > total) el.steps.removeChild(el.steps.lastChild);
    while (kids.length < total) {
      var li = document.createElement("li");
      li.className = "pomo__step";
      el.steps.appendChild(li);
    }

    // cycleDone 可能因为调小 cycle 而超出范围，取模兜底
    var done = state.cycleDone % total;

    for (var i = 0; i < total; i++) {
      var node = kids[i];
      node.classList.toggle("is-done", i < done);
      node.classList.toggle("is-now", i === done && state.phase === "focus");
    }
  };

  /* ------------------------------------------------------ 渲染：统计 ----- */

  /**
   * 连续天数：从今天（或昨天）往前数，连续有番茄记录的天数。
   *
   * 「今天还没开始」不该把连续记录清零 —— 所以起点允许是昨天：
   * 今天有记录就从今天数，没有就从昨天数。都没有则是 0。
   */
  var calcStreak = function () {
    var d = new Date();
    var key = function (dt) {
      var m = dt.getMonth() + 1;
      var day = dt.getDate();
      return dt.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
    };

    var has = function (dt) {
      var e = history[key(dt)];
      return !!(e && e.done > 0);
    };

    // 今天没有记录，就从昨天起算；昨天也没有则为 0
    if (!has(d)) {
      d.setDate(d.getDate() - 1);
      if (!has(d)) return 0;
    }

    var n = 0;
    // 上限 365，防脏数据造成死循环
    for (var i = 0; i < 365; i++) {
      if (!has(d)) break;
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  };

  var renderStats = function () {
    var todayEntry = history[today()] || { done: 0, seconds: 0 };

    if (el.stats.done) el.stats.done.textContent = String(todayEntry.done);

    if (el.stats.minutes) {
      // 只显示整分钟；不足 1 分钟显示 0
      el.stats.minutes.textContent = String(Math.floor(todayEntry.seconds / 60));
    }

    if (el.stats.streak) el.stats.streak.textContent = String(calcStreak());
  };

  /* ------------------------------------------------------ 渲染：任务 ----- */

  var renderTasks = function () {
    if (!el.task.list) return;

    el.task.list.textContent = "";

    tasks.forEach(function (t) {
      var li = document.createElement("li");
      li.className = "pomo__task-item" + (t.done ? " is-done" : "");
      li.setAttribute("data-id", t.id);

      var check = document.createElement("input");
      check.type = "checkbox";
      check.className = "pomo__task-check";
      check.checked = t.done;
      // 读屏需要知道这个勾选框对应哪件事
      check.setAttribute("aria-label", t.text);
      check.addEventListener("change", function () {
        t.done = check.checked;
        li.classList.toggle("is-done", t.done);
        save();
        renderTaskMeta();
      });

      var span = document.createElement("span");
      span.className = "pomo__task-text";
      // 用 textContent 而不是 innerHTML —— 任务名是用户输入，必须转义
      span.textContent = t.text;

      var del = document.createElement("button");
      del.type = "button";
      del.className = "pomo__task-del";
      del.textContent = "×";
      del.setAttribute("aria-label", "删除任务：" + t.text);
      del.addEventListener("click", function () {
        tasks = tasks.filter(function (x) {
          return x.id !== t.id;
        });
        save();
        renderTasks();
      });

      li.appendChild(check);
      li.appendChild(span);
      li.appendChild(del);
      el.task.list.appendChild(li);
    });

    renderTaskMeta();
  };

  var renderTaskMeta = function () {
    var total = tasks.length;
    var left = tasks.filter(function (t) {
      return !t.done;
    }).length;

    if (el.task.empty) {
      // 有任务时藏掉空状态（用 hidden 属性，CSS 里有对应规则）
      el.task.empty.hidden = total > 0;
    }

    if (el.task.count) {
      el.task.count.textContent = total ? left + " / " + total + " 待办" : "";
    }

    if (el.task.clear) {
      // 没有已完成任务时禁用，避免点了没反应
      el.task.clear.disabled = !tasks.some(function (t) {
        return t.done;
      });
    }
  };

  /* ------------------------------------------------------ 主题 ---------- */

  var applyTheme = function () {
    if (settings.theme === "auto") {
      // 移除属性 → 回落到 CSS 的 prefers-color-scheme
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", settings.theme);
    }

    // 同步 radio 选中态（加载时用）
    var radios = document.querySelectorAll("[data-theme-choice]");
    Array.prototype.forEach.call(radios, function (r) {
      r.checked = r.value === settings.theme;
    });
  };

  /* -------------------------------------------------------- 计时循环 ----- */

  var raf = 0;
  var tick = function () {
    if (!state.running) return;

    var left = (state.endAt - Date.now()) / 1000;

    if (left <= 0) {
      // 归零：先落终态再切换，避免负值闪一帧
      state.running = false;
      state.remain = 0;
      render();
      settle(true);
      return;
    }

    render();
    // rAF 驱动显示刷新；后台标签页 rAF 会被暂停，
    // 但那只影响显示 —— 计时依据是时间戳，切回来立刻正确。
    raf = window.requestAnimationFrame(tick);
  };

  var startLoop = function () {
    window.cancelAnimationFrame(raf);
    tick();
  };

  /* -------------------------------------------------------- 状态切换 ----- */

  var phaseSeconds = function (phase) {
    return settings[phase] * 60;
  };

  /**
   * 切到指定阶段。
   * @param {string} phase  focus | short | long
   * @param {boolean} auto  是否自动开始（结算完成时按 autoNext 决定）
   */
  var goPhase = function (phase, auto) {
    state.phase = phase;
    state.duration = phaseSeconds(phase);
    state.remain = state.duration;
    state.running = false;
    state.endAt = null;
    el.page.setAttribute("data-phase", phase);
    renderSteps();

    if (auto) {
      state.running = true;
      state.endAt = Date.now() + state.remain * 1000;
      startLoop();
    } else {
      render();
    }
  };

  /**
   * 单一结算入口：计时归零或手动跳过都走这里。
   * @param {boolean} completed 是否自然走完（区别于手动跳过）
   */
  var settle = function (completed) {
    window.cancelAnimationFrame(raf);

    var finished = state.phase;

    if (finished === "focus") {
      if (completed) {
        // 记账：今天的番茄数 +1，专注秒数加上本阶段时长
        var day = today();
        if (!history[day]) history[day] = { done: 0, seconds: 0 };
        history[day].done += 1;
        history[day].seconds += state.duration;

        state.cycleDone += 1;
        trimHistory();
        save();
        renderStats();
      }

      // 满 cycle 个番茄 → 长休息，否则短休息
      var isLong =
        completed && state.cycleDone > 0 && state.cycleDone % settings.cycle === 0;

      // 走完一轮 cycle 后把进度点归零，进入新的一轮
      if (isLong) {
        state.cycleDone = 0;
        save();
      }

      goPhase(isLong ? "long" : "short", settings.autoNext);
    } else {
      // 休息结束 → 回到专注
      goPhase("focus", settings.autoNext);
    }

    notify(finished, state.phase);
  };

  // 只保留最近 HISTORY_DAYS 天，避免 localStorage 无限膨胀
  var trimHistory = function () {
    var keys = Object.keys(history).sort();
    if (keys.length <= HISTORY_DAYS) return;
    keys.slice(0, keys.length - HISTORY_DAYS).forEach(function (k) {
      delete history[k];
    });
  };

  /* -------------------------------------------------------- 通知与声音 --- */

  var audioCtx = null;

  // 用 WebAudio 合成一声短音，避免额外的音频文件请求
  var beep = function () {
    if (!settings.sound) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === "suspended") audioCtx.resume();

      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = 660;

      var t = audioCtx.currentTime;
      // 淡入淡出，避免爆音
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);

      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 1);
    } catch (e) {
      /* 浏览器未授权音频等：静默失败 */
    }
  };

  var notify = function (from, to) {
    beep();

    if (typeof Notification === "undefined" || Notification.permission !== "granted") {
      return;
    }
    var body = from === "focus" ? "专注结束，去休息一下。" : "休息结束，回来继续。";
    try {
      new Notification(PHASES[to].label + " · 番茄钟", {
        body: body,
        // 同 tag 覆盖上一条，避免通知堆积
        tag: "pomodoro"
      });
    } catch (e) {
      /* 部分环境禁止页面构造通知 */
    }
  };

  /* -------------------------------------------------------- 可见性补偿 --- */

  // 从后台切回前台时立刻校正一次显示。
  // 计时本身不依赖定时器，这里只是让界面马上追上真实剩余时间。
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") return;
    if (!state.running) return;

    if (Date.now() >= state.endAt) {
      state.running = false;
      state.remain = 0;
      render();
      settle(true);
    } else {
      render();
      startLoop();
    }
  });

  /* -------------------------------------------------------- 交互 --------- */

  var toggle = function () {
    if (state.running) {
      // 暂停：把剩余时间固化下来
      state.remain = Math.max(0, (state.endAt - Date.now()) / 1000);
      state.running = false;
      state.endAt = null;
      window.cancelAnimationFrame(raf);
      render();
    } else {
      // 从头开始 或 继续
      if (state.remain <= 0) state.remain = state.duration;
      state.running = true;
      state.endAt = Date.now() + state.remain * 1000;
      startLoop();
    }
  };

  var doReset = function () {
    window.cancelAnimationFrame(raf);
    state.running = false;
    state.remain = state.duration;
    state.endAt = null;
    render();
  };

  if (el.primary) el.primary.addEventListener("click", toggle);
  if (el.reset) el.reset.addEventListener("click", doReset);
  if (el.skip) {
    el.skip.addEventListener("click", function () {
      // 手动跳过不计入完成数
      settle(false);
    });
  }

  /* 键盘快捷键：空格 / R / S。
     焦点在输入控件上时一律不拦截，否则会吃掉正常输入。 */
  document.addEventListener("keydown", function (e) {
    var t = e.target;
    var tag = t && t.tagName;
    if (tag === "INPUT" || tag === "BUTTON" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) {
      return;
    }
    // 带修饰键的组合留给浏览器（Ctrl+R 刷新等）
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      toggle();
    } else if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      doReset();
    } else if (e.key === "s" || e.key === "S") {
      e.preventDefault();
      settle(false);
    }
  });

  /* -------------------------------------------------------- 任务交互 ----- */

  /**
   * 输入框为空时的可见反馈。
   *
   * 为什么要有：早先「空输入点添加」是**彻底静默的** —— 没有新任务、
   * 没有提示、焦点也不动。用户唯一能得到的结论就是「点了没反应」。
   * 现在改为：聚焦输入框 + 输入框抖一下 + 显示一行提示。
   */
  var nudgeTimer = 0;

  var nudgeEmptyInput = function () {
    var input = el.task.input;
    if (!input) return;

    input.focus();

    // 抖动动画：加类 → 400ms 后移除，方便下次再触发
    var form = el.task.form;
    if (form) {
      form.classList.remove("is-nudge");
      // 强制重排，否则连续两次空点击时动画不会重播
      void form.offsetWidth;
      form.classList.add("is-nudge");
      window.setTimeout(function () {
        form.classList.remove("is-nudge");
      }, 420);
    }

    /* 提示文字写进 live region。
       用 textContent 而不是切换 hidden —— 见模板里的说明。 */
    var hint = el.task.hint;
    if (hint) {
      window.clearTimeout(nudgeTimer);
      hint.textContent = hint.getAttribute("data-hint-text") || "先写一件事再添加。";
      nudgeTimer = window.setTimeout(function () {
        if (hint) hint.textContent = "";
      }, 3200);
    }
  };

  /** 把当前输入框内容加成一条任务。返回是否添加成功。 */
  var addTask = function () {
    if (!el.task.input) return false;

    var text = el.task.input.value.trim().slice(0, TASK_MAX);
    if (!text) {
      nudgeEmptyInput();
      return false;
    }

    tasks.push({ id: uid(), text: text, done: false, createdAt: Date.now() });
    el.task.input.value = "";

    // 提示条在成功添加后不再需要
    if (el.task.hint) {
      window.clearTimeout(nudgeTimer);
      el.task.hint.textContent = "";
    }

    save();
    renderTasks();
    el.task.input.focus();

    // 新任务可能落在视野外，滚到可视区
    var last = el.task.list && el.task.list.lastElementChild;
    if (last && last.scrollIntoView) {
      last.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    return true;
  };

  if (el.task.form) {
    el.task.form.addEventListener("submit", function (e) {
      // 阻止表单默认提交（会让页面刷新、计时丢失）
      e.preventDefault();
      addTask();
    });
  }

  /* 回车提交。
     ------------------------------------------------------------------------
     单独处理而不是只靠表单的隐式提交，原因有二：
       1. 部分浏览器/场景下隐式提交不触发（实测 CDP 合成按键就不触发）
       2. 中文输入法里回车是「确认候选词」，不能当成提交
          —— 用 isComposing / 组合状态把它们分开，否则打「重点」时
          按回车选词会误加任务。 */
  var composing = false;

  if (el.task.input) {
    el.task.input.addEventListener("compositionstart", function () {
      composing = true;
    });
    el.task.input.addEventListener("compositionend", function () {
      composing = false;
    });

    el.task.input.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      // 输入法正在组词：这一次回车属于输入法，放行
      if (e.isComposing || composing || e.keyCode === 229) return;

      e.preventDefault();
      addTask();
    });
  }

  if (el.task.clear) {
    el.task.clear.addEventListener("click", function () {
      tasks = tasks.filter(function (t) {
        return !t.done;
      });
      save();
      renderTasks();
    });
  }

  /* -------------------------------------------------------- 设置同步 ----- */

  var pushSettingsToInputs = function () {
    Object.keys(el.fields).forEach(function (k) {
      var input = el.fields[k];
      if (input) input.value = String(settings[k]);
    });
    var auto = $('[data-set="autoNext"]');
    if (auto) auto.checked = settings.autoNext;
    var snd = $('[data-set="sound"]');
    if (snd) snd.checked = settings.sound;
  };

  Object.keys(el.fields).forEach(function (key) {
    var input = el.fields[key];
    if (!input) return;

    var commit = function () {
      var n = parseInt(input.value, 10);
      if (!isFinite(n)) n = DEFAULTS[key];

      var lim = LIMITS[key];
      n = clamp(n, lim[0], lim[1]);
      // 回写钳制后的值，让用户看到实际生效的数字
      input.value = String(n);
      settings[key] = n;
      save();

      // cycle 改了要重画进度点
      if (key === "cycle") {
        state.cycleDone = state.cycleDone % Math.max(1, settings.cycle);
        renderSteps();
      }

      // 改动当前阶段时长时，若计时未开始，立即同步显示
      if (key === state.phase && !state.running) {
        state.duration = phaseSeconds(state.phase);
        state.remain = state.duration;
        render();
      }
    };

    input.addEventListener("change", commit);
    input.addEventListener("blur", commit);
  });

  var autoBox = $('[data-set="autoNext"]');
  if (autoBox) {
    autoBox.addEventListener("change", function () {
      settings.autoNext = !!autoBox.checked;
      save();
    });
  }

  var soundBox = $('[data-set="sound"]');
  if (soundBox) {
    soundBox.addEventListener("change", function () {
      settings.sound = !!soundBox.checked;
      save();
    });
  }

  /* 主题单选 */
  Array.prototype.forEach.call(document.querySelectorAll("[data-theme-choice]"), function (radio) {
    radio.addEventListener("change", function () {
      if (!radio.checked) return;
      settings.theme = radio.value;
      applyTheme();
      save();
    });
  });

  /* -------------------------------------------------------- 通知授权 ----- */

  var syncNotifyButton = function () {
    if (!el.notify) return;
    if (typeof Notification === "undefined") {
      el.notify.hidden = true;
      return;
    }
    if (Notification.permission === "granted") {
      el.notify.hidden = true;
      el.notify.textContent = "已开启通知";
    } else if (Notification.permission === "denied") {
      // 已被拒绝：浏览器不允许再次弹窗，只能提示去手动改
      el.notify.hidden = false;
      el.notify.textContent = "通知被浏览器阻止，需在站点设置里恢复";
      el.notify.disabled = true;
    } else {
      el.notify.hidden = false;
      el.notify.textContent = "开启桌面通知";
      el.notify.disabled = false;
    }
  };

  if (el.notify) {
    el.notify.addEventListener("click", function () {
      if (typeof Notification === "undefined") return;
      Notification.requestPermission().then(syncNotifyButton).catch(syncNotifyButton);
    });
  }

  /* -------------------------------------------------------- 启动 --------- */

  loadAll();
  pushSettingsToInputs();
  applyTheme();
  syncNotifyButton();

  el.page.setAttribute("data-phase", state.phase);
  state.duration = phaseSeconds("focus");
  state.remain = state.duration;

  render();
  renderSteps();
  renderStats();
  renderTasks();

  /* 告诉页面的启动自检：脚本确实跑到了最后。
     没有这一行，index.html 的报警条会在 1.5 秒后误报"脚本没运行"。 */
  window.__POMO_BOOTED = true;
})();
