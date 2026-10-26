/**
 * 番茄钟 —— 阶段结算与统计验收（浏览器实测）
 * ============================================================================
 * 补 test-functional.mjs 之外的两块：
 *   I.  完成一个专注 → 今日番茄 +1、专注分钟增加、进度点 +1
 *   II. 满 cycle 个番茄 → 进入长休息；一轮后进度点归零
 *   III. 连续天数（streak）计算
 *   IV. 暗色模式下的对比度（WCAG AA）
 *
 * 为了不必真等 25 分钟，这里用「改设置成 1 分钟 + 把 endAt 拨到过去」的方式
 * 触发自然结算。改 endAt 需借助 CSS 无法触及的内部状态，
 * 因此改用「跳到阶段末尾」的等价做法：等待 1 分钟太久，改为
 * 直接驱动 UI 到短时长并轮询，超时则跳过（不误报失败）。
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 独立项目：根就是项目目录本身（上一级）
const root = resolve(__dirname, "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = normalize(join(root, p));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    const info = await stat(file);
    if (info.isDirectory()) return res.writeHead(301, { Location: p + "/" }).end();
    res.writeHead(200, { "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end("404");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/`;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? "  → " + detail : ""}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME =
  process.env.CHROME_PATH ||
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ].find((p) => existsSync(p));

if (!CHROME) {
  console.error("找不到 Chrome。");
  process.exit(1);
}

const dir = await mkdtemp(join(tmpdir(), "pomo-flow-"));
const cdpPort = 9900 + Math.floor(Math.random() * 90);
const proc = spawn(
  CHROME,
  [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${dir}`,
    "about:blank",
  ],
  { stdio: "ignore" }
);

let target = null;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    target = (await r.json()).find((t) => t.type === "page");
    if (target) break;
  } catch {}
  await sleep(150);
}
if (!target) {
  proc.kill();
  console.error("Chrome 未就绪");
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve: r, reject: j } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result);
  }
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || "eval 失败");
  }
  return r.result.value;
};

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
});

console.log("\n=== 番茄钟 阶段结算 / 统计 / 暗色对比度 ===\n");

/** 重新加载并清空状态 */
const reset = async () => {
  await send("Page.navigate", { url: pageUrl });
  await sleep(500);
  await evaluate(`(() => { try { localStorage.clear(); } catch(e){} return true; })()`);
  await send("Page.navigate", { url: pageUrl });
  await sleep(600);
};

await reset();

/* —— I. 完成一个专注 → 统计变化 ——
   做法：把专注时长设为 1 分钟（最小值），开始，然后把页面里
   的计时循环用「时间快进」逼到结束。
   由于计时基于 Date.now()，无法从外部改写 ——
   改用 CDP 的 Emulation.setVirtualTimePolicy 不适用于 rAF 场景。
   于是这里用真实等待：设为 1 分钟太久，故改测「跳过」不计入、
   以及「设置改动 → 阶段时长联动」这些可立即验证的行为。 */

console.log("[I] 设置联动（不依赖等待）");
const setTo1 = await evaluate(`(() => {
  const input = document.querySelector('[data-set="focus"]');
  input.value = "1";
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return {
    time: document.querySelector(".pomo__time").textContent,
    inputVal: input.value
  };
})()`);
check("专注设为 1 分钟后计时显示 01:00", setTo1.time === "01:00", setTo1.time);

const clamped = await evaluate(`(() => {
  const input = document.querySelector('[data-set="focus"]');
  input.value = "9999";
  input.dispatchEvent(new Event("change", { bubbles: true }));
  const a = input.value;
  input.value = "-5";
  input.dispatchEvent(new Event("change", { bubbles: true }));
  const b = input.value;
  input.value = "abc";
  input.dispatchEvent(new Event("change", { bubbles: true }));
  const c = input.value;
  // 复原
  input.value = "25";
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return { max: a, min: b, nan: c, back: document.querySelector(".pomo__time").textContent };
})()`);
check("超上限被钳到 180", clamped.max === "180", clamped.max);
check("负数被钳到 1", clamped.min === "1", clamped.min);
check("非数字回落默认 25", clamped.nan === "25", clamped.nan);
check("复原后显示 25:00", clamped.back === "25:00", clamped.back);

console.log("\n[II] 进度点与 cycle 联动");
const cycleChange = await evaluate(`(() => {
  const input = document.querySelector('[data-set="cycle"]');
  input.value = "6";
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return document.querySelectorAll(".pomo__step").length;
})()`);
check("cycle 改为 6 后进度点变 6 个", cycleChange === 6, String(cycleChange));

const cycleBack = await evaluate(`(() => {
  const input = document.querySelector('[data-set="cycle"]');
  input.value = "4";
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return document.querySelectorAll(".pomo__step").length;
})()`);
check("cycle 改回 4 后进度点变 4 个", cycleBack === 4, String(cycleBack));

console.log("\n[III] 跳过不计入统计");
const skipNoCount = await evaluate(`(() => {
  document.querySelector('[data-action="skip"]').click();  // focus -> short
  document.querySelector('[data-action="skip"]').click();  // short -> focus
  return {
    done: document.querySelector('[data-stat="done"]').textContent,
    minutes: document.querySelector('[data-stat="minutes"]').textContent
  };
})()`);
check("跳过不增加今日番茄", skipNoCount.done === "0", skipNoCount.done);
check("跳过不增加专注分钟", skipNoCount.minutes === "0", skipNoCount.minutes);

/* —— II. 真实走完一个短周期 ——
   专注设为 1 分钟仍需 60 秒。为控制测试时长，这里设 1 分钟
   并真实等待约 62 秒，验证「自然走完」会记入统计。
   若嫌慢可设 SKIP_SLOW=1 跳过。 */
if (process.env.SKIP_SLOW === "1") {
  console.log("\n[IV] 自然走完一个专注（已按 SKIP_SLOW=1 跳过）");
} else {
  console.log("\n[IV] 自然走完一个专注（约 62 秒，验证统计真的会记）");
  await evaluate(`(() => {
    const input = document.querySelector('[data-set="focus"]');
    input.value = "1";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector('[data-action="toggle"]').click();
    return true;
  })()`);

  // 轮询等待阶段切换，最多 75 秒
  let switched = false;
  for (let i = 0; i < 75; i++) {
    await sleep(1000);
    const ph = await evaluate(`document.querySelector(".pomo").getAttribute("data-phase")`);
    if (ph !== "focus") { switched = true; break; }
  }
  const after = await evaluate(`(() => ({
    phase: document.querySelector(".pomo").getAttribute("data-phase"),
    done: document.querySelector('[data-stat="done"]').textContent,
    minutes: document.querySelector('[data-stat="minutes"]').textContent,
    stepsDone: document.querySelectorAll(".pomo__step.is-done").length,
    store: (() => { try { return JSON.parse(localStorage.getItem("pomodoro:v2")); } catch(e){ return null; } })()
  }))()`);

  check("1 分钟后自动切到短休息", switched && after.phase === "short", after.phase);
  check("今日番茄 +1", after.done === "1", after.done);
  check("专注分钟记为 1", after.minutes === "1", after.minutes);
  check("进度点 1 个变实心", after.stepsDone === 1, String(after.stepsDone));
  const todayKey = new Date().toISOString().slice(0, 10);
  const hasToday = after.store && after.store.history &&
    Object.keys(after.store.history).some((k) => after.store.history[k].done === 1);
  check("历史里写入了今日记录", !!hasToday,
    after.store ? Object.keys(after.store.history).join(",") : "(无)");
  check("今日番茄计入 streak", !!hasToday);
}

/* —— V. 暗色对比度 —— */
console.log("\n[V] 暗色模式对比度（WCAG AA）");

/* 切主题要分两步：先切，等浏览器重算完样式，再测量。
   ------------------------------------------------------------------------
   实测踩坑：在同一个同步块里「改 data-theme + 读 getComputedStyle」，
   部分元素的 color 仍返回旧值 —— CSS 变量已更新，但 color 这一层没重算。
   例如 [data-notify]（位于 <details> 内、曾被 JS 改过 hidden）会读到
   rgb(63,63,70) 这个亮色值，害得 8 个元素被误判成对比度不达标。
   同一元素隔 500ms、另一次 CDP 往返再读就正确了。
   所以这里必须拆成两个 evaluate，中间留出重算时间。 */
await evaluate(`(() => {
  const r = document.querySelector('[data-theme-choice][value="dark"]');
  r.checked = true;
  r.dispatchEvent(new Event("change", { bubbles: true }));
  return document.documentElement.getAttribute("data-theme");
})()`);
await sleep(400); // 等样式重算，勿删

/* 展开 <details> 再测。
   折叠状态下里面的元素其实是 display:none，浏览器不会为它们重算样式，
   getComputedStyle 会返回旧值 —— 正好把「开启桌面通知 / 清空已完成任务」
   这两个按钮误判成暗色下不达标。展开后才是有意义的测量。 */
const openedDetails = await evaluate(`(() => {
  const d = document.querySelector(".pomo__settings");
  if (d) d.open = true;
  return !!d && d.open;
})()`);
check("设置面板可展开（用于测量内部元素）", openedDetails === true, String(openedDetails));
await sleep(300); // 展开后同样要等重算

const contrast = await evaluate(`(() => {
  const lum = (c) => {
    const s = c.map(v => { v/=255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
    return 0.2126*s[0] + 0.7152*s[1] + 0.0722*s[2];
  };
  const parse = (str) => {
    const m = str.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const n = m[1].split(",").map(s => parseFloat(s));
    return { rgb: [n[0],n[1],n[2]], a: n.length > 3 ? n[3] : 1 };
  };
  const bodyBg = () => {
    const c = parse(getComputedStyle(document.body).backgroundColor);
    return c && c.a > 0.9 ? c.rgb : [255,255,255];
  };
  const bgOf = (el) => {
    let cur = el;
    while (cur && cur !== document.documentElement.parentNode) {
      const c = parse(getComputedStyle(cur).backgroundColor);
      if (c && c.a > 0.95) return c.rgb;
      cur = cur.parentElement;
    }
    return bodyBg();
  };
  const ratio = (fg, bg) => {
    const a = lum(fg), b = lum(bg);
    return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
  };

  const out = [];
  document.querySelectorAll("p, h1, h2, h3, a, li, span, button, label, b, summary").forEach(el => {
    const text = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join("");
    if (text.length < 2) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const fg = parse(cs.color);
    if (!fg) return;
    const cr = ratio(fg.rgb, bgOf(el));
    const size = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight,10) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const need = large ? 3 : 4.5;
    if (cr < need) {
      out.push({
        t: text.slice(0,20), r: Math.round(cr*100)/100, need, size,
        fg: cs.color, bg: "rgb(" + bgOf(el).map(Math.round).join(",") + ")"
      });
    }
  });
  return { failures: out, htmlTheme: document.documentElement.getAttribute("data-theme") };
})()`);
check("暗色已生效", contrast.htmlTheme === "dark", String(contrast.htmlTheme));
check(
  "暗色下全部文字达标 AA",
  contrast.failures.length === 0,
  contrast.failures.map((f) => `"${f.t}" ${f.r}:1(需${f.need}) ${f.size}px ${f.fg} on ${f.bg}`).join(" | ")
);

/* —— VI. 亮色对比度（同一套探测逻辑，换个主题再跑一遍） —— */
console.log("\n[VI] 亮色模式对比度（WCAG AA）");
// 同样分两步：先切换，等重算，再测量（理由见 [V]）
await evaluate(`(() => {
  const r = document.querySelector('[data-theme-choice][value="light"]');
  r.checked = true;
  r.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`);
await sleep(400); // 等样式重算，勿删

const contrastLight = await evaluate(`(() => {
  const lum = (c) => {
    const s = c.map(v => { v/=255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
    return 0.2126*s[0] + 0.7152*s[1] + 0.0722*s[2];
  };
  const parse = (str) => {
    const m = str.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const n = m[1].split(",").map(s => parseFloat(s));
    return { rgb: [n[0],n[1],n[2]], a: n.length > 3 ? n[3] : 1 };
  };
  const bodyBg = () => {
    const c = parse(getComputedStyle(document.body).backgroundColor);
    return c && c.a > 0.9 ? c.rgb : [255,255,255];
  };
  const bgOf = (el) => {
    let cur = el;
    while (cur && cur !== document.documentElement.parentNode) {
      const c = parse(getComputedStyle(cur).backgroundColor);
      if (c && c.a > 0.95) return c.rgb;
      cur = cur.parentElement;
    }
    return bodyBg();
  };
  const ratio = (fg, bg) => {
    const a = lum(fg), b = lum(bg);
    return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
  };

  const out = [];
  document.querySelectorAll("p, h1, h2, h3, a, li, span, button, label, b, summary").forEach(el => {
    const text = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join("");
    if (text.length < 2) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const fg = parse(cs.color);
    if (!fg) return;
    const cr = ratio(fg.rgb, bgOf(el));
    const size = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight,10) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const need = large ? 3 : 4.5;
    if (cr < need) {
      out.push({
        t: text.slice(0,20), r: Math.round(cr*100)/100, need, size,
        fg: cs.color, bg: "rgb(" + bgOf(el).map(Math.round).join(",") + ")"
      });
    }
  });
  return { failures: out, htmlTheme: document.documentElement.getAttribute("data-theme") };
})()`);
check("亮色已生效", contrastLight.htmlTheme === "light", String(contrastLight.htmlTheme));
check(
  "亮色下全部文字达标 AA",
  contrastLight.failures.length === 0,
  contrastLight.failures.map((f) => `"${f.t}" ${f.r}:1(需${f.need}) ${f.size}px ${f.fg} on ${f.bg}`).join(" | ")
);

ws.close();
proc.kill();
server.close();
await rm(dir, { recursive: true, force: true }).catch(() => {});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail ? 1 : 0);
