/**
 * 窄视口回归测试（侧边栏场景）
 * ============================================================================
 * 由来：用户反馈「浏览器里正常，侧边栏打开就出问题」。
 * 侧边栏的特征是**视口很窄**（约 240–420px），而此前所有测试都在 1100px 宽跑。
 *
 * 复现到的真 bug：
 *   `.pomo { place-items: start center }` 里的 center 让栅格轨道按 max-content
 *   定宽（实测 319px）。宽屏下 max-content < 视口看不出来；窄到 300px 上下时
 *   轨道仍是 319px → 整页横向溢出 → 「添加」按钮被推出右边界 → 点击落空。
 *
 * 这个文件锁死三件事：
 *   1. 任何宽度都不出现横向溢出
 *   2. 「添加」按钮完整在视口内、未被裁切、点得到
 *   3. 计时环在任何宽度都是正圆
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
    const f = normalize(join(root, p));
    if (!f.startsWith(root)) return res.writeHead(403).end();
    const i = await stat(f);
    if (i.isDirectory()) return res.writeHead(301, { Location: p + "/" }).end();
    res.writeHead(200, {
      "Content-Type": MIME[extname(f).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(await readFile(f));
  } catch {
    res.writeHead(404).end("404");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/`;

let pass = 0;
let fail = 0;
const check = (n, ok, d = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? "  → " + d : ""}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME =
  process.env.CHROME_PATH ||
  ["C:/Program Files/Google/Chrome/Application/chrome.exe",
   "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find((p) => existsSync(p));

if (!CHROME) {
  console.error("找不到 Chrome。");
  process.exit(1);
}

const dir = await mkdtemp(join(tmpdir(), "pomo-narrow-"));
const cdpPort = 7300 + Math.floor(Math.random() * 90);
const proc = spawn(CHROME, ["--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check",
  "--disable-extensions",`--remote-debugging-port=${cdpPort}`,`--user-data-dir=${dir}`,"about:blank"], { stdio: "ignore" });

let target = null;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    target = (await r.json()).find((t) => t.type === "page"); if (target) break; } catch {}
  await sleep(150);
}
if (!target) { proc.kill(); console.error("Chrome 未就绪"); process.exit(1); }

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
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval 失败");
  return r.result.value;
};

await send("Runtime.enable");
await send("Page.enable");

console.log("\n=== 窄视口回归测试（侧边栏场景）===\n");

/* 侧边栏从极窄到手机宽度都要成立 */
const VIEWPORTS = [
  ["侧边栏 240", 240, 560],
  ["侧边栏 280", 280, 640],
  ["侧边栏 320", 320, 700],
  ["侧边栏 360", 360, 760],
  ["手机 375", 375, 812],
  ["侧边栏 420", 420, 900],
  ["平板 768", 768, 1024],
];

for (const [label, w, h] of VIEWPORTS) {
  console.log(`\n[${label} × ${h}]`);
  await send("Emulation.setDeviceMetricsOverride", {
    width: w, height: h, deviceScaleFactor: 1, mobile: w < 700,
  });
  await send("Page.navigate", { url: pageUrl });
  await sleep(700);
  await evaluate(`(() => { try { localStorage.clear(); } catch (e) {} return true; })()`);
  await send("Page.navigate", { url: pageUrl });
  await sleep(750);
  await evaluate(`document.querySelectorAll(".reveal").forEach(e => e.classList.add("is-in"))`);
  await sleep(200);

  const layout = await evaluate(`(() => {
    const doc = document.documentElement;
    const vw = doc.clientWidth;
    const btn = document.querySelector(".pomo__task-submit");
    const ring = document.querySelector(".pomo__ring .is-progress");
    btn.scrollIntoView({ block: "center", behavior: "instant" });
    const br = btn.getBoundingClientRect();
    const rr = ring.getBoundingClientRect();

    // 找出真正撑宽的元素（排除刻意移出屏幕的 .skip）
    const offenders = [];
    document.querySelectorAll("*").forEach(el => {
      if (el.classList && el.classList.contains("skip")) return;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 0.5) {
        offenders.push(el.tagName + "." + (el.className || "").toString().slice(0, 24));
      }
    });

    return {
      vw,
      overflow: doc.scrollWidth - vw,
      offenders: offenders.slice(0, 5),
      btn: { left: Math.round(br.left), right: Math.round(br.right), w: Math.round(br.width) },
      btnClipped: br.left < -0.5 || br.right > vw + 0.5,
      ringRound: Math.abs(rr.width - rr.height) < 0.5 && rr.width > 0,
      ringW: Math.round(rr.width)
    };
  })()`);

  check(
    "无横向溢出",
    layout.overflow <= 1,
    layout.overflow > 1 ? `溢出 ${layout.overflow}px；元凶：${layout.offenders.join(", ")}` : ""
  );
  check("「添加」按钮未被裁切", !layout.btnClipped, `left=${layout.btn.left} right=${layout.btn.right} 视口=${layout.vw}`);
  check("计时环是正圆", layout.ringRound, `${layout.ringW}px`);

  /* 真实点击验证 */
  await evaluate(`(() => {
    const i = document.querySelector("[data-task-input]");
    i.focus();
    i.value = "窄视口测试";
    i.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);

  const b = await evaluate(`(() => {
    const el = document.querySelector(".pomo__task-submit");
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1 });
  await sleep(400);

  const added = await evaluate(`document.querySelectorAll(".pomo__task-item").length`);
  check("点「添加」能成功加任务", added === 1, `count=${added}`);
}

ws.close();
proc.kill();
await sleep(200);
server.close();
await rm(dir, { recursive: true, force: true }).catch(() => {});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail ? 1 : 0);
