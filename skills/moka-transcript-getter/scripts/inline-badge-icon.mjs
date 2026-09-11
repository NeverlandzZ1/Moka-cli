#!/usr/bin/env node

/**
 * inline-badge-icon.mjs — 把已生成的 HTML 报告里 `<img src="icon/xxx.png">`
 * 就地改写为 `<img src="data:image/png;base64,...">`,确保 artifact 发布后是自包含单文件。
 *
 * 用法:
 *   node inline-badge-icon.mjs --file <html绝对路径> [--icon-dir <assets/icon 目录绝对路径>]
 *
 * 默认 icon-dir = <脚本所在目录>/../assets/icon。
 *
 * stdout 输出一行 JSON: { ok, file, badgeIcon, iconPath, byteCount, replaced }
 *   - ok: 是否成功
 *   - badgeIcon: 从 HTML 里识别出的 PNG 文件名
 *   - replaced: 实际替换的 `src="icon/xxx.png"` 出现次数
 *
 * 退出码: 0 = 成功;非 0 = 失败(HTML 不含 icon/ 前缀 / PNG 找不到 / 写入失败)。
 *
 * 此脚本只做确定性字符串替换,不解析 HTML,不改动 token,不动 CSS。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ICON_DIR = path.resolve(__dirname, "..", "assets", "icon");

function parseArgs(argv) {
  const out = { file: null, iconDir: DEFAULT_ICON_DIR };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") out.file = argv[++i];
    else if (a === "--icon-dir") out.iconDir = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log("Usage: node inline-badge-icon.mjs --file <html> [--icon-dir <dir>]");
      process.exit(0);
    }
  }
  return out;
}

function fail(msg, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg, ...extra }) + "\n");
  process.exit(1);
}

async function main() {
  const { file, iconDir } = parseArgs(process.argv);
  if (!file) fail("missing --file <html-path>");
  const absHtml = path.resolve(file);

  let html;
  try {
    html = await fs.readFile(absHtml, "utf8");
  } catch (e) {
    fail(`read html failed: ${e.message}`, { file: absHtml });
  }

  // 匹配 <img ... src="icon/<basename>.png" ...>,提取 basename.png
  // 只认 icon/ 前缀,双引号或单引号都支持;不吃跨行。
  const re = /<img\b([^>]*?)\bsrc\s*=\s*["']icon\/([^"'\/]+\.png)["']([^>]*)>/gi;
  const hits = [];
  html.replace(re, (m, pre, name, post) => {
    hits.push(name);
    return m;
  });

  if (hits.length === 0) {
    fail("no <img src=\"icon/*.png\"> found in HTML — 检查 BADGE_ICON token 是否已替换", {
      file: absHtml,
    });
  }

  // 所有命中的 PNG 文件名应当一致(模板里只有一处 badge img);容忍多处但用同一文件
  const badgeIcon = hits[0];
  const inconsistent = hits.find((n) => n !== badgeIcon);
  if (inconsistent) {
    fail(`multiple different icon filenames found: ${JSON.stringify([...new Set(hits)])}`, {
      file: absHtml,
    });
  }

  const iconPath = path.resolve(iconDir, badgeIcon);
  let png;
  try {
    png = await fs.readFile(iconPath);
  } catch (e) {
    fail(`read icon PNG failed: ${e.message}`, { iconPath, badgeIcon });
  }

  const b64 = png.toString("base64");
  const dataUrl = `data:image/png;base64,${b64}`;

  let replaced = 0;
  const newHtml = html.replace(re, (m, pre, name, post) => {
    replaced += 1;
    return `<img${pre}src="${dataUrl}"${post}>`;
  });

  if (replaced === 0) {
    fail("replace produced 0 substitutions — regex mismatch bug", { file: absHtml });
  }

  try {
    await fs.writeFile(absHtml, newHtml, "utf8");
  } catch (e) {
    fail(`write html failed: ${e.message}`, { file: absHtml });
  }

  process.stdout.write(
    JSON.stringify({
      ok: true,
      file: absHtml,
      badgeIcon,
      iconPath,
      byteCount: png.length,
      replaced,
    }) + "\n"
  );
}

main().catch((e) => fail(`unexpected: ${e && e.message ? e.message : String(e)}`));
