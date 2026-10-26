/**
 * 构建：src/index.mjs → index.html
 * 运行：node src/build.mjs   （或 npm run build）
 *
 * 为什么还要构建（而不是直接手写 index.html）：
 *   - 文案与结构分离：改一句话不用在几百行 HTML 里翻
 *   - 默认时长只在一处定义，不会和 pomodoro.js 的 DEFAULTS 漂移
 *   - 产物是纯静态 HTML，首屏不依赖 JS 也能读到完整内容
 *
 * 零第三方依赖，只用 Node 内置模块。
 */

import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { renderPage, POMO } from "./index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const html = renderPage();
const out = join(root, "index.html");

await writeFile(out, html, "utf8");

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1);

console.log(`\n✓ index.html  (${kb(html)} KB)`);
for (const f of ["pomodoro.css", "pomodoro.js", "main.js"]) {
  const size = await readFile(join(root, "assets", f), "utf8").then(
    (s) => kb(s) + " KB",
    () => "缺失!"
  );
  console.log(`  assets/${f}  (${size})`);
}

/* ==========================================================================
   单文件版：把 CSS / JS 全部内联进一个 .html
   --------------------------------------------------------------------------
   为什么要这个：主版本依赖 assets/ 下的三个子资源。如果出现
     - assets 目录没跟 index.html 放在一起
     - 浏览器/预览器拦截了本地子资源加载
     - 想把页面发给别人（一个文件就够）
   那页面会"能开但没样式、按钮没反应"。

   单文件版没有任何子资源请求，因此不受上述任何一种影响。
   注意：改样式/逻辑仍要改 assets/ 下的源文件，然后重新 build。
   ========================================================================== */
const css = await readFile(join(root, "assets", "pomodoro.css"), "utf8");
const jsPomo = await readFile(join(root, "assets", "pomodoro.js"), "utf8");
const jsMain = await readFile(join(root, "assets", "main.js"), "utf8");

/** 内联 <script> 时，内容里若出现 </script 会提前闭合标签 —— 必须转义 */
const safeScript = (s) => s.replace(/<\/script/gi, "<\\/script");

/* 把外链标签替换成内联。注意顺序：先换 <link>，再换两个 <script>。 */
let single = html
  .replace(
    /<link rel="stylesheet" href="assets\/pomodoro\.css">/,
    `<style>\n${css}\n</style>`
  )
  .replace(
    /<script src="assets\/main\.js" defer><\/script>/,
    `<script>\n${safeScript(jsMain)}\n</script>`
  )
  .replace(
    /<script src="assets\/pomodoro\.js" defer><\/script>/,
    `<script>\n${safeScript(jsPomo)}\n</script>`
  );

/* 自检：确认没有残留的外链 */
const leftovers = [...single.matchAll(/(?:src|href)="assets\/[^"]+"/g)].map((m) => m[0]);
if (leftovers.length) {
  console.error(`\n✗ 单文件版仍有外链残留：${leftovers.join(", ")}`);
  process.exitCode = 1;
} else {
  const singleOut = join(root, "番茄钟-单文件.html");
  await writeFile(singleOut, single, "utf8");
  console.log(`✓ 番茄钟-单文件.html  (${kb(single)} KB，CSS/JS 已内联，零子资源请求)`);
}

/* —— 构建自检 —— */
console.log(`\n构建完成。`);

/* 1. 未替换的占位符（模板里用【】标记待填内容） */
const placeholders = [...html.matchAll(/【[^】]+】/g)].map((m) => m[0]);
if (placeholders.length) {
  console.log(`  ⚠️ 待替换占位符 ${placeholders.length} 处：${placeholders.join(", ")}`);
}

/* 2. 关键契约自检：默认时长必须与 pomodoro.js 的 DEFAULTS 一致，
      不一致会出现「无 JS 显示 25、有 JS 后变 30」。 */
const js = await readFile(join(root, "assets", "pomodoro.js"), "utf8");
const defaultsBlock = js.slice(js.indexOf("var DEFAULTS = {"), js.indexOf("};", js.indexOf("var DEFAULTS = {")));
const jsDefaults = {};
for (const [k, v] of defaultsBlock.matchAll(/(\w+):\s*(\d+)/g)) jsDefaults[k] = Number(v);

const mismatches = [];
for (const k of ["focus", "short", "long", "cycle"]) {
  const a = POMO.defaults[k];
  const b = jsDefaults[k];
  if (b !== undefined && a !== b) mismatches.push(`${k}: 模板 ${a} vs JS ${b}`);
}

if (mismatches.length) {
  console.log(`  ✗ 默认时长不一致（会导致无 JS 与有 JS 显示不同）：`);
  mismatches.forEach((m) => console.log(`     - ${m}`));
  console.log(`     修：src/index.mjs 的 POMO.defaults 与 assets/pomodoro.js 的 DEFAULTS 要一致。`);
} else {
  console.log(`  ✓ 默认时长与 pomodoro.js 的 DEFAULTS 一致（${JSON.stringify(POMO.defaults)}）`);
}

/* 3. 结构自检：关键挂点齐不齐 */
const required = [
  ['data-action="toggle"', "开始/暂停按钮"],
  ['data-action="reset"', "重置按钮"],
  ['data-action="skip"', "跳过按钮"],
  ['data-task-form', "任务表单"],
  ['data-steps', "进度点容器"],
  ['data-stat="done"', "统计数字"],
  ['data-theme-choice', "主题单选"],
  ['class="pomo__ring"', "计时环"],
];
const missing = required.filter(([needle]) => !html.includes(needle)).map(([, label]) => label);
if (missing.length) {
  console.log(`  ✗ 缺少关键挂点：${missing.join(", ")}`);
} else {
  console.log(`  ✓ ${required.length} 个关键挂点齐全`);
}
console.log();
