#!/usr/bin/env node

/**
 * inline-badge-icon.mjs
 *
 * 把 HTML 报告里 <img src="icon/xxx.png"> 和 <img src="logo.png"> 的 src 就地替换为
 * base64 data URI(`data:image/png;base64,...`),让 HTML 变成自包含单文件——
 * artifact 发布后浏览器不再依赖旁边的 icon/ 目录和 logo 文件。
 *
 * 2026-09-14 变更:图标从 SVG 换回极小的 PNG(logo ~7 KB,badge 每个 ~10 KB),
 * 不再是"把 <img> 换成内联 <svg> 元素",而是"读 PNG → 拼 base64 → 只替换 src 属性"。
 *
 * Usage:
 *   node inline-badge-icon.mjs --file <html> [--icon-dir <dir>] [--assets-dir <dir>]
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ICON_DIR = path.resolve(__dirname, "..", "assets", "icon");
const DEFAULT_ASSETS_DIR = path.resolve(__dirname, "..", "assets");

function parseArgs(argv) {
  var out = { file: null, iconDir: DEFAULT_ICON_DIR, assetsDir: DEFAULT_ASSETS_DIR };
  for (var i = 2; i < argv.length; i++) {
    var a = argv[i];
    if (a === "--file") out.file = argv[++i];
    else if (a === "--icon-dir") out.iconDir = argv[++i];
    else if (a === "--assets-dir") out.assetsDir = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log("Usage: node inline-badge-icon.mjs --file <html> [--icon-dir <dir>] [--assets-dir <dir>]");
      process.exit(0);
    }
  }
  return out;
}

function fail(msg, extra) {
  process.stdout.write(JSON.stringify(Object.assign({ ok: false, error: msg }, extra || {})) + "\n");
  process.exit(1);
}

async function pngToDataUri(absPath) {
  var buf = await fs.readFile(absPath);
  return { dataUri: "data:image/png;base64," + buf.toString("base64"), bytes: buf.length };
}

async function main() {
  var args = parseArgs(process.argv);
  if (!args.file) fail("missing --file <html-path>");
  var absHtml = path.resolve(args.file);

  var html;
  try {
    html = await fs.readFile(absHtml, "utf8");
  } catch (e) {
    fail("read html failed: " + e.message, { file: absHtml });
  }

  var replaced = 0;
  var badgeIcon = null;
  var iconPath = null;
  var iconBytes = 0;
  var logoBytes = 0;

  // ── Step 1: 把 <img src="icon/xxx.png"> 里的 src 换成 base64 data URI ──
  var badgeRe = /(<img\b[^>]*?\bsrc\s*=\s*["'])icon\/([^"'\/]+\.png)(["'][^>]*>)/gi;
  var badgeHits = [];
  html.replace(badgeRe, function(_m, _pre, name) {
    badgeHits.push(name);
    return _m;
  });

  var badgeDataUri = null;
  if (badgeHits.length > 0) {
    badgeIcon = badgeHits[0];
    iconPath = path.resolve(args.iconDir, badgeIcon);
    try {
      var r = await pngToDataUri(iconPath);
      badgeDataUri = r.dataUri;
      iconBytes = r.bytes;
    } catch (e) {
      fail("read icon PNG failed: " + e.message, { iconPath: iconPath, badgeIcon: badgeIcon });
    }
    html = html.replace(badgeRe, function(_m, pre, _name, post) {
      replaced += 1;
      return pre + badgeDataUri + post;
    });
  }

  // ── Step 2: 把 <img src="logo.png"> 里的 src 换成 base64 data URI ──
  var logoRe = /(<img\b[^>]*?\bsrc\s*=\s*["'])logo\.png(["'][^>]*>)/gi;
  if (logoRe.test(html)) {
    logoRe.lastIndex = 0;
    var logoPath = path.resolve(args.assetsDir, "logo.png");
    var logoDataUri;
    try {
      var lr = await pngToDataUri(logoPath);
      logoDataUri = lr.dataUri;
      logoBytes = lr.bytes;
    } catch (e) {
      fail("read logo PNG failed: " + e.message, { logoPath: logoPath });
    }
    html = html.replace(logoRe, function(_m, pre, post) {
      replaced += 1;
      return pre + logoDataUri + post;
    });
  }

  if (replaced === 0) {
    fail("no PNG img tags found in HTML (expected icon/*.png or logo.png)", { file: absHtml });
  }

  try {
    await fs.writeFile(absHtml, html, "utf8");
  } catch (e) {
    fail("write html failed: " + e.message, { file: absHtml });
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    file: absHtml,
    badgeIcon: badgeIcon,
    iconPath: iconPath,
    iconBytes: iconBytes,
    logoBytes: logoBytes,
    replaced: replaced
  }) + "\n");
}

main().catch(function(e) {
  fail("unexpected: " + (e && e.message ? e.message : String(e)));
});
