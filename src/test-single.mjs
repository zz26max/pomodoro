/**
 * 验证单文件版：file:// 直接打开也能添加任务、无报警、无外链
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const pageUrl = "file:///" + join(root, "番茄钟-单文件.html").replace(/\\/g, "/");

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find((p) => existsSync(p));
const dir = await mkdtemp(join(tmpdir(), "pomo-single-"));
const cdpPort = 7900 + Math.floor(Math.random() * 90);
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
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
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

console.log("\n=== 单文件版（file:// 直接打开）===\n");
await send("Page.navigate", { url: pageUrl });
await sleep(2200);

check("页面加载无 JS 异常", errors.length === 0, errors.slice(0, 2).join(" | "));

const boot = await evaluate(`(() => ({
  booted: window.__POMO_BOOTED === true,
  alertVisible: (() => { const a = document.querySelector("[data-boot-alert]"); return a ? !a.hidden : false; })(),
  hasStyle: [...document.styleSheets].length > 0,
  ringSized: (() => { const d = document.querySelector(".pomo__dial"); return d ? Math.round(d.getBoundingClientRect().width) : 0; })(),
  ringRound: (() => {
    const p = document.querySelector(".pomo__ring .is-progress");
    const r = p.getBoundingClientRect();
    return Math.abs(r.width - r.height) < 0.5 && r.width > 0;
  })(),
  externalRequests: [...document.querySelectorAll("link[rel=stylesheet][href], script[src]")]
    .map(el => el.getAttribute("href") || el.getAttribute("src"))
}))()`);
console.log(JSON.stringify(boot, null, 2));

check("脚本已运行（BOOTED）", boot.booted === true, String(boot.booted));
check("没有误报警告", boot.alertVisible === false, String(boot.alertVisible));
check("样式已生效（计时环有尺寸）", boot.ringSized > 100, `${boot.ringSized}px`);
check("计时环是正圆", boot.ringRound === true, "");
check("没有任何外链资源", boot.externalRequests.length === 0, JSON.stringify(boot.externalRequests));

/* 添加任务 */
const b = await evaluate(`(() => {
  const btn = document.querySelector(".pomo__task-submit");
  btn.scrollIntoView({ block: "center", behavior: "instant" });
  const i = document.querySelector("[data-task-input]");
  i.focus(); i.value = "单文件版添加成功";
  i.dispatchEvent(new Event("input", { bubbles: true }));
  const r = btn.getBoundingClientRect();
  return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
})()`);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1 });
await sleep(500);

const added = await evaluate(`(() => ({
  count: document.querySelectorAll(".pomo__task-item").length,
  text: (document.querySelector(".pomo__task-text") || {}).textContent || "",
  inputValue: document.querySelector("[data-task-input]").value
}))()`);
console.log("添加后:", JSON.stringify(added));
check("点「添加」成功加任务", added.count === 1, `count=${added.count}`);
check("任务文本正确", added.text === "单文件版添加成功", added.text);
check("输入框已清空", added.inputValue === "", JSON.stringify(added.inputValue));

ws.close(); proc.kill();
await rm(dir, { recursive: true, force: true }).catch(() => {});
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail ? 1 : 0);
