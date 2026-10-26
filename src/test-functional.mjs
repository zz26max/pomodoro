/**
 * 番茄钟完整版 —— 功能验收（浏览器实测）
 * ============================================================================
 * 复用网站 dev/audit.mjs 的极简 CDP 客户端思路（零依赖，直连 Chrome）。
 *
 * ⚠️ 必须走 http://，不能用 file://
 *    Chrome 在 file:// 下禁用 localStorage（SecurityError），
 *    而任务/统计/主题全靠 localStorage —— 用 file:// 测会误判成代码有 bug。
 *    所以这里起一个零依赖的静态服务器（就在本文件里，不引入 express）。
 *
 * 覆盖 audit.mjs 测不到的部分：真实交互与状态。
 *   A. 计时：开始 → 数字递减 → 暂停 → 继续 → 重置
 *   B. 阶段：跳过 → 短休息；回专注
 *   C. 任务：新增 / 勾选 / 删除 / 清空已完成 / 持久化
 *   D. 存储结构：pomodoro:v2 字段齐全
 *   E. 主题：切暗色后 <html data-theme="dark">，且颜色真的变了
 *   F. 转义：任务名含 <img onerror> 不被当 HTML 执行
 *   G. 快捷键：R / S，以及输入框内不拦截
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// resolve 而不是字符串拼接：拼接在 Windows 上容易混入重复反斜杠，
// 会让下面的 startsWith 判断失败、所有请求变 403。
// 独立项目：根就是项目目录本身（上一级），页面在 /index.html。
const root = resolve(__dirname, "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** 起一个最小静态服务器，返回 { server, port, close } */
async function serve() {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (p.endsWith("/")) p += "index.html";
      const file = normalize(join(root, p));
      if (!file.startsWith(root)) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      const info = await stat(file);
      if (info.isDirectory()) {
        res.writeHead(301, { Location: p + "/" }).end();
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end("404");
    }
  });

  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const port = server.address().port;
  return {
    port,
    close: () => new Promise((res) => server.close(res)),
  };
}

const CHROME =
  process.env.CHROME_PATH ||
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ].find((p) => existsSync(p));

if (!CHROME) {
  console.error("找不到 Chrome。请设置 CHROME_PATH 环境变量。");
  process.exit(1);
}

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? "  → " + detail : ""}`);
  ok ? pass++ : fail++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withChrome(fn) {
  const dir = await mkdtemp(join(tmpdir(), "pomo-test-"));
  const port = 9300 + Math.floor(Math.random() * 600);
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${dir}`,
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      target = list.find((t) => t.type === "page");
      if (target) break;
    } catch {}
    await sleep(150);
  }
  if (!target) {
    proc.kill();
    throw new Error("Chrome 调试端口未就绪");
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const myId = ++id;
      pending.set(myId, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || "eval 失败");
    }
    return r.result.value;
  };

  try {
    await fn({ send, evaluate });
  } finally {
    try { ws.close(); } catch {}
    proc.kill();
    await sleep(200);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

console.log("\n=== 番茄钟功能验收（浏览器实测）===\n");

const srv = await serve();
const pageUrl = `http://127.0.0.1:${srv.port}/`;
console.log(`页面：${pageUrl}\n`);

try {
  await runTests(pageUrl);
} finally {
  await srv.close();
}

async function runTests(pageUrl) {
await withChrome(async ({ send, evaluate }) => {
  await send("Page.enable");
  await send("Runtime.enable");

  const load = async () => {
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await send("Page.navigate", { url: pageUrl });
    await sleep(600);
    // 清掉上一次的状态，保证每个用例从干净环境开始
    await evaluate(`(() => { try { localStorage.clear(); } catch(e){} return true; })()`);
    await send("Page.navigate", { url: pageUrl });
    await sleep(600);
  };

  /* —— 0. 页面加载无报错 —— */
  await load();

  /* 资源是否真的加载成功 —— 这是最先要断言的：
     路径写错时页面照样能开，但没样式、脚本不执行、按钮全无反应，
     只测 DOM 结构是发现不了的。 */
  const assets = await evaluate(`(async () => {
    const urls = [
      ...Array.from(document.querySelectorAll("link[rel=stylesheet]")).map(l => l.getAttribute("href")),
      ...Array.from(document.querySelectorAll("script[src]")).map(s => s.getAttribute("src"))
    ];
    const results = [];
    for (const u of urls) {
      const r = await fetch(u, { method: "GET" });
      const t = await r.text();
      results.push({ u, status: r.status, len: t.length });
    }
    return results;
  })()`);
  const badAssets = assets.filter((a) => a.status !== 200 || a.len === 0);
  check(
    `全部 ${assets.length} 个样式/脚本加载成功`,
    badAssets.length === 0,
    badAssets.map((a) => `${a.u} → ${a.status}(${a.len}B)`).join(", ")
  );

  const boot = await evaluate(`(() => {
    return {
      hasPage: !!document.querySelector(".pomo"),
      time: (document.querySelector(".pomo__time")||{}).textContent,
      steps: document.querySelectorAll(".pomo__step").length,
      tasks: document.querySelectorAll(".pomo__task-item").length,
      statDone: (document.querySelector('[data-stat="done"]')||{}).textContent,
      key: !!localStorage.getItem("pomodoro:v2") || "未写入(启动时不写)"
    };
  })()`);
  check("初始显示 25:00", boot.time === "25:00", boot.time);
  check("进度点数量 = cycle 默认值 4", boot.steps === 4, String(boot.steps));
  check("初始任务列表为空", boot.tasks === 0, String(boot.tasks));
  check("初始今日番茄为 0", boot.statDone === "0", boot.statDone);

  // 脚本真的执行了的判据：JS 会给环设置 stroke-dasharray（模板里没有）
  const scriptRan = await evaluate(`(() => ({
    dasharray: document.querySelector(".pomo__ring .is-progress").getAttribute("stroke-dasharray"),
    hasP: document.querySelector(".pomo").style.getPropertyValue("--p") !== ""
  }))()`);
  check(
    "脚本已执行（环的 dasharray 由 JS 写入）",
    !!scriptRan.dasharray && scriptRan.hasP,
    `dasharray=${scriptRan.dasharray}, --p=${scriptRan.hasP}`
  );

  /* —— A. 计时：开始 / 暂停 / 继续 / 重置 —— */
  console.log("\n[A] 计时");
  const start = await evaluate(`(() => {
    document.querySelector('[data-action="toggle"]').click();
    return true;
  })()`);
  await sleep(1600);
  const running = await evaluate(`(() => ({
    t: document.querySelector(".pomo__time").textContent,
    btn: document.querySelector('[data-action="toggle"]').textContent
  }))()`);
  check("开始后按钮变「暂停」", running.btn === "暂停", running.btn);
  check("开始后数字在递减（< 25:00）", running.t < "25:00", running.t);

  // 暂停后数字应停住
  await evaluate(`document.querySelector('[data-action="toggle"]').click()`);
  const paused1 = await evaluate(`document.querySelector(".pomo__time").textContent`);
  await sleep(1200);
  const paused2 = await evaluate(`document.querySelector(".pomo__time").textContent`);
  const btnAfterPause = await evaluate(
    `document.querySelector('[data-action="toggle"]').textContent`
  );
  check("暂停后数字不再变", paused1 === paused2, `${paused1} → ${paused2}`);
  check("暂停后按钮变「继续」", btnAfterPause === "继续", btnAfterPause);

  // 继续
  await evaluate(`document.querySelector('[data-action="toggle"]').click()`);
  await sleep(1200);
  const resumed = await evaluate(`document.querySelector(".pomo__time").textContent`);
  check("继续后数字重新递减", resumed < paused2, `${paused2} → ${resumed}`);

  // 重置
  await evaluate(`document.querySelector('[data-action="reset"]').click()`);
  const afterReset = await evaluate(`(() => ({
    t: document.querySelector(".pomo__time").textContent,
    btn: document.querySelector('[data-action="toggle"]').textContent
  }))()`);
  check("重置回到 25:00", afterReset.t === "25:00", afterReset.t);
  check("重置后按钮变「开始」", afterReset.btn === "开始", afterReset.btn);

  /* —— B. 阶段切换 —— */
  console.log("\n[B] 阶段切换");
  const skipped = await evaluate(`(() => {
    document.querySelector('[data-action="skip"]').click();
    return {
      phase: document.querySelector(".pomo").getAttribute("data-phase"),
      label: document.querySelector(".pomo__label").textContent,
      time: document.querySelector(".pomo__time").textContent
    };
  })()`);
  check("跳过 → 短休息", skipped.phase === "short", skipped.phase);
  check("短休息标签正确", skipped.label === "短休息", skipped.label);
  check("短休息默认 05:00", skipped.time === "05:00", skipped.time);

  const backToFocus = await evaluate(`(() => {
    document.querySelector('[data-action="skip"]').click();
    return document.querySelector(".pomo").getAttribute("data-phase");
  })()`);
  check("休息跳过 → 回专注", backToFocus === "focus", backToFocus);

  /* —— C. 任务 —— */
  console.log("\n[C] 任务列表");
  const added = await evaluate(`(() => {
    const input = document.querySelector("[data-task-input]");
    const form = document.querySelector("[data-task-form]");
    input.value = "写番茄钟";
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    input.value = "改网站";
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    return {
      n: document.querySelectorAll(".pomo__task-item").length,
      first: document.querySelector(".pomo__task-text").textContent,
      count: document.querySelector("[data-tasks-count]").textContent,
      emptyHidden: document.querySelector("[data-task-empty]").hidden
    };
  })()`);
  check("提交表单新增 2 条任务", added.n === 2, String(added.n));
  check("任务文本正确", added.first === "写番茄钟", added.first);
  check("计数显示 2/2 待办", added.count === "2 / 2 待办", added.count);
  check("有任务时空状态隐藏", added.emptyHidden === true, String(added.emptyHidden));

  const checked = await evaluate(`(() => {
    const cb = document.querySelector(".pomo__task-check");
    cb.checked = true;
    cb.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      count: document.querySelector("[data-tasks-count]").textContent,
      struck: document.querySelector(".pomo__task-item").classList.contains("is-done"),
      clearDisabled: document.querySelector("[data-clear-tasks]").disabled
    };
  })()`);
  check("勾选后计数变 1/2", checked.count === "1 / 2 待办", checked.count);
  check("已完成条目加 is-done", checked.struck === true, String(checked.struck));
  check("「清空已完成」可点", checked.clearDisabled === false, String(checked.clearDisabled));

  const cleared = await evaluate(`(() => {
    document.querySelector("[data-clear-tasks]").click();
    return {
      n: document.querySelectorAll(".pomo__task-item").length,
      text: document.querySelector(".pomo__task-text").textContent
    };
  })()`);
  check("清空已完成后剩 1 条", cleared.n === 1, String(cleared.n));
  check("剩下的是未完成的「改网站」", cleared.text === "改网站", cleared.text);

  const deleted = await evaluate(`(() => {
    document.querySelector(".pomo__task-del").click();
    return {
      n: document.querySelectorAll(".pomo__task-item").length,
      emptyShown: !document.querySelector("[data-task-empty]").hidden
    };
  })()`);
  check("删除按钮移除任务", deleted.n === 0, String(deleted.n));
  check("删空后空状态重新显示", deleted.emptyShown === true, String(deleted.emptyShown));

  /* —— D. 持久化 + 统计 —— */
  console.log("\n[D] 持久化与统计");
  // 加一条任务，设一个极短专注时长（1 分钟），然后直接改 endAt 逼它立刻结束
  const statAfter = await evaluate(`(() => {
    const input = document.querySelector("[data-task-input]");
    const form = document.querySelector("[data-task-form]");
    input.value = "持久化测试";
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    return document.querySelectorAll(".pomo__task-item").length;
  })()`);
  check("新增持久化测试任务", statAfter === 1, String(statAfter));

  // 重新加载页面，任务应当还在
  await send("Page.navigate", { url: pageUrl });
  await sleep(600);
  const persisted = await evaluate(`(() => ({
    n: document.querySelectorAll(".pomo__task-item").length,
    text: (document.querySelector(".pomo__task-text")||{}).textContent,
    checked: (document.querySelector(".pomo__task-check")||{}).checked
  }))()`);
  check("刷新后任务仍在（localStorage 生效）", persisted.n === 1, String(persisted.n));
  check("任务文本正确还原", persisted.text === "持久化测试", persisted.text);

  /* —— E. 主题 —— */
  console.log("\n[E] 主题");
  const themeDark = await evaluate(`(() => {
    const r = document.querySelector('[data-theme-choice][value="dark"]');
    r.checked = true;
    r.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      attr: document.documentElement.getAttribute("data-theme"),
      bg: getComputedStyle(document.body).backgroundColor,
      fg: getComputedStyle(document.querySelector(".pomo__title")).color
    };
  })()`);
  check("选暗色后 <html data-theme=dark>", themeDark.attr === "dark", String(themeDark.attr));
  // 暗底应当是深色（各通道都低）
  const bgDark = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(themeDark.bg);
  const isDarkBg = bgDark && +bgDark[1] < 60 && +bgDark[2] < 60 && +bgDark[3] < 60;
  check("暗色下 body 底色确实变深", !!isDarkBg, themeDark.bg);
  // 文字应当是浅色
  const fgDark = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(themeDark.fg);
  const isLightFg = fgDark && +fgDark[1] > 180;
  check("暗色下标题文字确实变浅", !!isLightFg, themeDark.fg);

  const themeLight = await evaluate(`(() => {
    const r = document.querySelector('[data-theme-choice][value="light"]');
    r.checked = true;
    r.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      attr: document.documentElement.getAttribute("data-theme"),
      bg: getComputedStyle(document.body).backgroundColor
    };
  })()`);
  check("选亮色后 data-theme=light", themeLight.attr === "light", String(themeLight.attr));
  const bgLight = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(themeLight.bg);
  const isLightBg = bgLight && +bgLight[1] > 200;
  check("亮色下 body 底色确实变浅", !!isLightBg, themeLight.bg);

  const themeAuto = await evaluate(`(() => {
    const r = document.querySelector('[data-theme-choice][value="auto"]');
    r.checked = true;
    r.dispatchEvent(new Event("change", { bubbles: true }));
    return document.documentElement.getAttribute("data-theme");
  })()`);
  check("选「跟随系统」后移除 data-theme", themeAuto === null, String(themeAuto));

  /* —— F. 存储结构 —— */
  console.log("\n[F] 存储结构");
  const store = await evaluate(`(() => {
    const raw = localStorage.getItem("pomodoro:v2");
    let o = null;
    try { o = JSON.parse(raw); } catch(e) { return { parse: false, raw: String(raw).slice(0,80) }; }
    return {
      parse: true,
      v: o.v,
      hasSettings: !!o.settings,
      hasHistory: !!o.history,
      hasTasks: Array.isArray(o.tasks),
      cycleDone: typeof o.cycleDone,
      theme: o.settings && o.settings.theme,
      keys: Object.keys(o).sort().join(",")
    };
  })()`);
  check("pomodoro:v2 可解析", store.parse === true, store.raw || "");
  check("结构含 v/settings/history/tasks/cycleDone",
    store.v === 2 && store.hasSettings && store.hasHistory && store.hasTasks && store.cycleDone === "number",
    store.keys);
  check("主题已持久化（auto）", store.theme === "auto", String(store.theme));

  /* —— G. XSS 转义 —— */
  console.log("\n[G] 安全：任务名转义");
  const xss = await evaluate(`(() => {
    window.__pwned = false;
    const input = document.querySelector("[data-task-input]");
    const form = document.querySelector("[data-task-form]");
    const before = document.querySelectorAll(".pomo__task-item").length;
    input.value = '<img src=x onerror="window.__pwned=true">';
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    // 新任务追加在列表末尾，要断言最后一条，不能用 querySelector 取第一条
    const items = document.querySelectorAll(".pomo__task-item");
    const last = items[items.length - 1];
    return {
      added: items.length - before,
      pwned: window.__pwned,
      injected: document.querySelectorAll(".pomo__task-list img, .pomo__task-list script").length,
      text: last ? last.querySelector(".pomo__task-text").textContent : "(没新增)"
    };
  })()`);
  await sleep(300);
  const pwnedAfter = await evaluate(`window.__pwned`);
  check("恶意任务名确实被加入列表", xss.added === 1, `新增 ${xss.added} 条`);
  check("恶意任务名未被当 HTML 插入", xss.injected === 0, `img/script 元素 ${xss.injected} 个`);
  check("未被执行（无 onerror 触发）", pwnedAfter !== true, String(pwnedAfter));
  check(
    "原样作为文本显示（标签可见但无害）",
    xss.text.indexOf("<img") === 0,
    xss.text.slice(0, 45)
  );

  /* —— H. 键盘快捷键 —— */
  console.log("\n[H] 键盘快捷键");
  const keyR = await evaluate(`(() => {
    document.querySelector('[data-action="toggle"]').click(); // 先开始
    const before = document.querySelector('[data-action="toggle"]').textContent;
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
    return {
      before: before,
      after: document.querySelector('[data-action="toggle"]').textContent,
      time: document.querySelector(".pomo__time").textContent
    };
  })()`);
  check("按 R 重置：按钮回到「开始」", keyR.after === "开始", `${keyR.before} → ${keyR.after}`);
  check("按 R 重置：时间回到 25:00", keyR.time === "25:00", keyR.time);

  const keyS = await evaluate(`(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
    return document.querySelector(".pomo").getAttribute("data-phase");
  })()`);
  check("按 S 跳过到短休息", keyS === "short", keyS);

  // 输入框里按 R 不应被拦截
  const inInput = await evaluate(`(() => {
    const input = document.querySelector("[data-task-input]");
    input.focus();
    const ev = new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented };
  })()`);
  check("输入框内按 R 不被拦截（不打字冲突）", inInput.prevented === false, String(inInput.prevented));
});
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail ? 1 : 0);
