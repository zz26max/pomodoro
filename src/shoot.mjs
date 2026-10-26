/**
 * 截图：亮色 / 暗色 / 窄屏 / 无 JS
 * 用于人工确认版面（测试测的是行为，不是好看）
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const shots = join(root, ".shots");
await mkdir(shots, { recursive: true });

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
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
  } catch { res.writeHead(404).end("404"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find((p) => existsSync(p));
const dir = await mkdtemp(join(tmpdir(), "pomo-shot-"));
const cdpPort = 9000 + Math.floor(Math.random() * 90);
const proc = spawn(CHROME, ["--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check",
  "--disable-extensions","--hide-scrollbars",`--remote-debugging-port=${cdpPort}`,`--user-data-dir=${dir}`,"about:blank"], { stdio: "ignore" });

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
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
  return r.result.value;
};

await send("Page.enable"); await send("Runtime.enable");

const shoot = async (name, { width, height, theme, noJs = false, setup = null }) => {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: width < 700 });
  if (noJs) await send("Emulation.setScriptExecutionDisabled", { value: true });
  else await send("Emulation.setScriptExecutionDisabled", { value: false });

  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await new Promise((r) => setTimeout(r, 900));

  if (!noJs) {
    await evaluate(`localStorage.clear()`);
    if (theme) {
      await evaluate(`(() => { const r=document.querySelector('[data-theme-choice][value="${theme}"]');
        if(r){ r.checked=true; r.dispatchEvent(new Event("change",{bubbles:true})); } return true; })()`);
    }
    if (setup) await evaluate(setup);
    // 等入场动效跑完
    await evaluate(`document.querySelectorAll(".reveal").forEach(e=>e.classList.add("is-in"))`);
    await new Promise((r) => setTimeout(r, 700));
  } else {
    await new Promise((r) => setTimeout(r, 400));
  }

  /* 截整页前必须先把滚动归零。
     否则：页面被脚本滚下去（比如 setup 里新增任务会 scrollIntoView），
     而 header 是 position:sticky —— 整页截图时它会停留在滚动位置，
     看起来像"导航飘到了页面中间"。那是截图伪影，不是布局 bug。 */
  await evaluate(`(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 250));

  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const file = join(shots, name + ".png");
  await writeFile(file, Buffer.from(data, "base64"));
  console.log("  ✓", name + ".png");
};

console.log("\n生成截图：");
await shoot("01-light", { width: 1100, height: 1000, theme: "light" });
await shoot("02-dark", { width: 1100, height: 1000, theme: "dark" });
await shoot("03-tasks", {
  width: 1100, height: 1000, theme: "light",
  setup: `(() => {
    const form = document.querySelector("[data-task-form]");
    const input = document.querySelector("[data-task-input]");
    ["把番茄钟改成独立项目", "写 README", "跑一遍测试"].forEach(t => {
      input.value = t;
      form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    });
    const cb = document.querySelector(".pomo__task-check");
    cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector(".pomo__settings").open = true;
    return true;
  })()`,
});
await shoot("04-mobile", { width: 390, height: 1100, theme: "light" });
await shoot("05-nojs", { width: 1100, height: 1000, noJs: true });

ws.close(); proc.kill(); server.close();
await rm(dir, { recursive: true, force: true }).catch(() => {});
console.log("\n完成。目录：.shots/\n");
