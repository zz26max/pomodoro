/**
 * 本地预览用的极简静态服务器（零依赖）
 * 运行：node src/serve.mjs   （或 npm run dev）
 *
 * 默认 http://localhost:5174
 * 手机端调试：同一 Wi-Fi 下访问终端里打印的局域网地址。
 *
 * 只用于开发。正式部署就是把整个目录丢到任意静态托管上。
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const port = Number(process.env.PORT || 5174);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (urlPath.endsWith("/")) urlPath += "index.html";

    // 防止 ../ 穿越到项目目录之外
    const filePath = normalize(join(root, urlPath));
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    const info = await stat(filePath);
    if (info.isDirectory()) {
      res.writeHead(301, { Location: urlPath + "/" }).end();
      return;
    }

    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
      // 开发期禁缓存，免得改了看不到
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h1>404</h1><p>找不到这个文件。如果 index.html 不存在，先运行 npm run build。</p>");
  }
});

server.listen(port, () => {
  console.log(`\n  本地预览已启动：\n`);
  console.log(`    http://localhost:${port}`);
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === "IPv4" && !net.internal) {
        console.log(`    http://${net.address}:${port}   ← 手机端同一 Wi-Fi 下访问`);
      }
    }
  }
  console.log(`\n  改动 src/index.mjs 后记得重新执行 npm run build；按 Ctrl+C 停止。\n`);
});
