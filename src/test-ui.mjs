/**
 * UI 回归测试 —— 几何与真实交互
 * ============================================================================
 * 这个文件的由来：两个用户实测发现、而原有测试**全部漏掉**的问题：
 *
 *   1. 计时环被裁成方形（不是正圆）
 *      → 原测试只验「环有尺寸」，没验「宽高相等」和「没超出画布」
 *   2. 点「添加」没反应
 *      → 原测试用 form.dispatchEvent("submit") 模拟，绕过了真实点击路径，
 *        也从未测「空输入时用户能不能得到反馈」
 *
 * 所以这里刻意用**真实鼠标事件**（CDP Input 域）而不是 .click()，
 * 并且把几何量出来断言，而不是"看着像就行"。
 *
 * 教训：测试能证明行为，但证明不了"看起来对不对"。
 * 几何、可点击 affordance、空态反馈，都必须单独断言。
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

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
  console.error("找不到 Chrome。请设置 CHROME_PATH 环境变量。");
  process.exit(1);
}

const dir = await mkdtemp(join(tmpdir(), "pomo-ui-"));
const cdpPort = 8900 + Math.floor(Math.random() * 90);
const proc = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--hide-scrollbars",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${dir}`,
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
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let id = 0;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Runtime.exceptionThrown") {
    pageErrors.push(
      m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text
    );
  }
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
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || "eval 失败");
  }
  return r.result.value;
};

/** 真实鼠标点击某个选择器的中心点 */
const mouseClick = async (selector) => {
  const b = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    // 先滚进视口 —— 否则元素在页面下方时 rect 坐标超出视口，
    // CDP 的鼠标事件会打在空白处，"点击无效"其实是没点中。
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      inViewport: r.top >= 0 && r.bottom <= window.innerHeight
    };
  })()`);
  if (!b) throw new Error(`找不到元素：${selector}`);
  if (!b.inViewport) throw new Error(`元素不在视口内：${selector} (${b.x},${b.y})`);
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: b.x, y: b.y, button: "left", clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1,
  });
  await sleep(250);
};

const taskCount = () => evaluate(`document.querySelectorAll(".pomo__task-item").length`);

const load = async () => {
  await send("Page.navigate", { url: pageUrl });
  await sleep(700);
  await evaluate(`(() => { try { localStorage.clear(); } catch (e) {} return true; })()`);
  await send("Page.navigate", { url: pageUrl });
  await sleep(800);
  await evaluate(`document.querySelectorAll(".reveal").forEach(e => e.classList.add("is-in"))`);
  await sleep(250);
};

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1100, height: 1100, deviceScaleFactor: 1, mobile: false,
});

console.log("\n=== UI 回归测试（几何 + 真实交互）===\n");
console.log(`页面：${pageUrl}\n`);

await load();

/* ==========================================================================
   A. 计时环必须是正圆，且不被画布裁剪
   ========================================================================== */
console.log("[A] 计时环几何");

const ringGeo = await evaluate(`(() => {
  const svg = document.querySelector(".pomo__ring");
  const prog = svg.querySelector(".is-progress");
  const track = svg.querySelector(".is-track");
  const cs = getComputedStyle(svg);
  const sr = svg.getBoundingClientRect();
  const pr = prog.getBoundingClientRect();
  const tr = track.getBoundingClientRect();

  const vb = svg.viewBox.baseVal;
  const one = prog.r.baseVal.value;
  const sw = parseFloat(getComputedStyle(prog).strokeWidth);

  return {
    svg: { w: +sr.width.toFixed(2), h: +sr.height.toFixed(2) },
    progress: { w: +pr.width.toFixed(2), h: +pr.height.toFixed(2) },
    track: { w: +tr.width.toFixed(2), h: +tr.height.toFixed(2) },
    overflow: cs.overflow,
    viewBox: { w: vb.width, h: vb.height },
    radius: one,
    strokeWidth: sw,
    // 描边外沿到圆心的距离
    outerEdge: one + sw / 2,
    // viewBox 中心到边界的距离
    halfViewBox: vb.width / 2,
    // 圆是否超出 SVG 画布（true = 会被裁掉，渲染成方形）
    circleExceedsCanvas:
      pr.width > sr.width + 0.5 || pr.height > sr.height + 0.5
  };
})()`);

console.log(JSON.stringify(ringGeo, null, 2));

check(
  "圆自身是正圆（宽高相等）",
  Math.abs(ringGeo.progress.w - ringGeo.progress.h) < 0.5,
  `${ringGeo.progress.w} × ${ringGeo.progress.h}`
);
check(
  "圆没有超出 SVG 画布（否则被裁成方形）",
  !ringGeo.circleExceedsCanvas,
  `圆 ${ringGeo.progress.w} vs 画布 ${ringGeo.svg.w}`
);
check(
  "viewBox 为描边留出了余量",
  ringGeo.outerEdge <= ringGeo.halfViewBox,
  `描边外沿 ${ringGeo.outerEdge} ≤ 半画布 ${ringGeo.halfViewBox}`
);
check(
  "SVG 未被 overflow:hidden 裁剪",
  ringGeo.overflow === "visible" || !ringGeo.circleExceedsCanvas,
  ringGeo.overflow
);
check(
  "轨道环也是正圆",
  Math.abs(ringGeo.track.w - ringGeo.track.h) < 0.5,
  `${ringGeo.track.w} × ${ringGeo.track.h}`
);

/* ==========================================================================
   B. 添加按钮：真实点击的四条路径
   ========================================================================== */
console.log("\n[B] 添加任务（真实鼠标事件）");

/* B1 — 空输入点按钮：必须给出可见反馈，而不是彻底静默 */
const before1 = await taskCount();
await mouseClick(".pomo__task-submit");
const after1 = await taskCount();
const feedback = await evaluate(`(() => {
  const h = document.querySelector("[data-task-hint]");
  const form = document.querySelector("[data-task-form]");
  const input = document.querySelector("[data-task-input]");
  const r = h ? h.getBoundingClientRect() : null;
  return {
    hintExists: !!h,
    // 提示区是常驻 live region，有文字才算"给出反馈"
    hintText: h ? h.textContent.trim() : "",
    hintVisible: !!(r && r.width > 0 && r.height > 0),
    // 读屏可播报：live region + 有内容
    hintIsLiveRegion: h ? (h.getAttribute("role") === "status" && h.getAttribute("aria-live") === "polite") : false,
    nudging: form.classList.contains("is-nudge"),
    focused: document.activeElement === input
  };
})()`);

check("空输入点按钮不会凭空加任务", after1 === before1, `${before1} → ${after1}`);
check("空输入点按钮会显示提示文字", feedback.hintVisible && feedback.hintText.length > 0, feedback.hintText);
check("提示是读屏可播报的 live region", feedback.hintIsLiveRegion, String(feedback.hintIsLiveRegion));
check("空输入点按钮会把焦点送回输入框", feedback.focused, String(feedback.focused));

/* B2 — 输入文字后点按钮（真实鼠标） */
await evaluate(`(() => {
  const i = document.querySelector("[data-task-input]");
  i.focus();
  i.value = "点按钮添加";
  i.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
const before2 = await taskCount();
await mouseClick(".pomo__task-submit");
const after2 = await taskCount();
check("有文字时点按钮能加任务", after2 === before2 + 1, `${before2} → ${after2}`);

const afterAdd = await evaluate(`(() => ({
  inputValue: document.querySelector("[data-task-input]").value,
  hintText: document.querySelector("[data-task-hint]").textContent.trim(),
  text: (document.querySelector(".pomo__task-item:last-child .pomo__task-text") || {}).textContent
}))()`);
check("添加后输入框清空", afterAdd.inputValue === "", JSON.stringify(afterAdd.inputValue));
check("添加后提示条清空", afterAdd.hintText === "", JSON.stringify(afterAdd.hintText));
check("任务文本正确", afterAdd.text === "点按钮添加", String(afterAdd.text));

/* B3 — 输入文字后按回车 */
await evaluate(`(() => {
  const i = document.querySelector("[data-task-input]");
  i.focus();
  i.value = "回车添加";
  i.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
const before3 = await taskCount();
await send("Input.dispatchKeyEvent", {
  type: "keyDown", key: "Enter", code: "Enter",
  windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
});
await send("Input.dispatchKeyEvent", {
  type: "keyUp", key: "Enter", code: "Enter",
  windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
});
await sleep(350);
const after3 = await taskCount();
check("有文字时按回车能加任务", after3 === before3 + 1, `${before3} → ${after3}`);

/* B4 — 中文输入法组词时的回车不应提交（那是确认候选词） */
await evaluate(`(() => {
  const i = document.querySelector("[data-task-input]");
  i.focus();
  i.value = "";
  i.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  i.value = "重点";
  i.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
const before4 = await taskCount();
await send("Input.dispatchKeyEvent", {
  type: "keyDown", key: "Enter", code: "Enter",
  windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
});
await send("Input.dispatchKeyEvent", {
  type: "keyUp", key: "Enter", code: "Enter",
  windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
});
await sleep(350);
const after4 = await taskCount();
check(
  "输入法组词中的回车不提交（避免选词误加任务）",
  after4 === before4,
  `${before4} → ${after4}`
);

/* 结束组词后回车应当能提交 */
await evaluate(`(() => {
  const i = document.querySelector("[data-task-input]");
  i.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "重点" }));
  return true;
})()`);
const before5 = await taskCount();
await send("Input.dispatchKeyEvent", {
  type: "keyDown", key: "Enter", code: "Enter",
  windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
});
await send("Input.dispatchKeyEvent", {
  type: "keyUp", key: "Enter", code: "Enter",
  windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
});
await sleep(350);
const after5 = await taskCount();
check("组词结束后回车可以提交", after5 === before5 + 1, `${before5} → ${after5}`);

/* ==========================================================================
   C. 按钮的可点击 affordance
   ========================================================================== */
console.log("\n[C] 按钮看起来可点");

const affordance = await evaluate(`(() => {
  const btn = document.querySelector(".pomo__task-submit");
  const cs = getComputedStyle(btn);
  const r = btn.getBoundingClientRect();
  const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  // 解析 rgb，算与页面底色的对比度
  const parse = (s) => { const m = s.match(/rgba?\\(([^)]+)\\)/); return m ? m[1].split(",").map(Number) : null; };
  const lum = (c) => { const s = c.slice(0,3).map(v => { v/=255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }); return 0.2126*s[0]+0.7152*s[1]+0.0722*s[2]; };
  const ratio = (a,b) => { const x = lum(a), y = lum(b); return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05); };
  const bg = parse(cs.backgroundColor);
  const pageBg = parse(getComputedStyle(document.body).backgroundColor) || [255,255,255];
  return {
    bg: cs.backgroundColor,
    color: cs.color,
    borderColor: cs.borderColor,
    cursor: cs.cursor,
    notOccluded: top === btn || btn.contains(top),
    contrastVsPage: bg ? +ratio(bg, pageBg).toFixed(2) : 0
  };
})()`);
console.log(JSON.stringify(affordance, null, 2));

check("按钮没被其他元素遮挡", affordance.notOccluded, String(affordance.notOccluded));
check("鼠标悬停指针为 pointer", affordance.cursor === "pointer", affordance.cursor);
check(
  "按钮与页面底色有明显区分（≥3:1）",
  affordance.contrastVsPage >= 3,
  `${affordance.contrastVsPage}:1（按钮 ${affordance.bg}）`
);

/* ==========================================================================
   D. 页面无 JS 异常
   ========================================================================== */
console.log("\n[D] 运行期");
check(
  "整个测试过程无未捕获异常",
  pageErrors.length === 0,
  pageErrors.slice(0, 3).join(" | ")
);

ws.close();
proc.kill();
await sleep(200);
server.close();
await rm(dir, { recursive: true, force: true }).catch(() => {});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail ? 1 : 0);
