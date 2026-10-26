/**
 * 验证两道防御：
 *   A. 正常情况下不误报警（1.5s 后不出现报警条）
 *   B. 脚本缺失时报警条出现，且给出可读原因
 *   C. 脚本缺失时点「添加」不会刷新页面（onsubmit 保险）
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
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

// 可选：模拟 pomodoro.js 加载失败
let breakScript = false;
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    if (breakScript && p.indexOf("pomodoro.js") >= 0) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end("not found");
      return;
    }
    const f = normalize(join(root, p));
    if (!f.startsWith(root)) return res.writeHead(403).end();
    const i = await stat(f);
    if (i.isDirectory()) return res.writeHead(301, { Location: p + "/" }).end();
    res.writeHead(200, { "Content-Type": MIME[extname(f).toLowerCase()] || "application/octet-stream" });
    res.end(await readFile(f));
  } catch { res.writeHead(404).end("404"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find((p) => existsSync(p));
const dir = await mkdtemp(join(tmpdir(), "pomo-boot-"));
const cdpPort = 8000 + Math.floor(Math.random() * 90);
const proc = spawn(CHROME, ["--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check",
  "--disable-extensions",`--remote-debugging-port=${cdpPort}`,`--user-data-dir=${dir}`,"about:blank"], { stdio: "ignore" });

let target = null;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    target = (await r.json()).find((t) => t.type === "page"); if (target) break; } catch {}
  await new Promise((r) => setTimeout(r, 150));
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { resolve: r, reject: j } = pending.get(m.id); pending.delete(m.id);
    m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { resolve: res, reject: rej });
  ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (e) => {
  const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description };
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? "  → " + d : ""}`); ok ? pass++ : fail++; };

await send("Runtime.enable"); await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 1200, deviceScaleFactor: 1, mobile: false });

const alertState = () => evaluate(`(() => {
  const el = document.querySelector("[data-boot-alert]");
  if (!el) return { exists: false };
  const r = el.getBoundingClientRect();
  return {
    exists: true,
    hidden: el.hidden,
    visible: !el.hidden && r.width > 0 && r.height > 0,
    text: el.textContent.trim(),
    booted: window.__POMO_BOOTED === true
  };
})()`);

console.log("\n=== A. 正常情况：不误报警 ===");
breakScript = false;
await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
await sleep(2400);
const a = await alertState();
console.log("  ", JSON.stringify(a));
check("脚本正常时 BOOTED 为 true", a.booted === true, String(a.booted));
check("脚本正常时不显示报警条", a.visible === false, `hidden=${a.hidden}`);

console.log("\n=== B. 脚本缺失：显示报警 ===");
breakScript = true;
await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
await sleep(2400);
const b = await alertState();
console.log("  ", JSON.stringify(b));
check("脚本缺失时 BOOTED 为 undefined", b.booted === false, String(b.booted));
check("脚本缺失时报警条可见", b.visible === true, `hidden=${b.hidden}`);
check("报警文字说明了原因", /脚本没有成功运行/.test(b.text), b.text.slice(0, 40));
check("报警里列出了脚本地址", /pomodoro\.js/.test(b.text), "");

console.log("\n=== C. 脚本缺失时点「添加」不刷新页面 ===");
await evaluate(`(() => { window.__marker = "before-click"; return true; })()`);
const beforeUrl = await evaluate(`location.href`);
const beforeMarker = await evaluate(`window.__marker`);

const btn = await evaluate(`(() => {
  const el = document.querySelector(".pomo__task-submit");
  el.scrollIntoView({ block: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  const i = document.querySelector("[data-task-input]");
  i.focus(); i.value = "不该丢的输入";
  return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
})()`);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: btn.x, y: btn.y, button: "left", clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: btn.x, y: btn.y, button: "left", clickCount: 1 });
await sleep(600);

const afterUrl = await evaluate(`location.href`);
const afterMarker = await evaluate(`window.__marker`);
const afterValue = await evaluate(`document.querySelector("[data-task-input]").value`);

check("点按钮后 URL 没变（没刷新）", afterUrl === beforeUrl, `${beforeUrl.slice(0, 40)} → ${afterUrl.slice(0, 40)}`);
check("页面没重新加载（window 标记还在）", afterMarker === "before-click", String(afterMarker));
check("输入内容没丢", afterValue === "不该丢的输入", JSON.stringify(afterValue));

ws.close(); proc.kill(); server.close();
await rm(dir, { recursive: true, force: true }).catch(() => {});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail ? 1 : 0);
