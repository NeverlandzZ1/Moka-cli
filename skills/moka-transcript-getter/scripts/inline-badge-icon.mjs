#!/usr/bin/env node

/**
 * inline-badge-icon.mjs
 *
 * 把 HTML 报告里的 <img src="icon/xxx.svg"> 和 <img src="logo.svg">
 * 就地替换为内联 <svg> 元素,确保 artifact 发布后是自包含单文件。
 *
 * SVG 文件内容是多行的,内联后不会产生超长单行,
 * 确保 readFile 能完整读取最终 HTML。
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

function makeInlineSvg(svgText, classAttr) {
  var svgStart = svgText.indexOf("<svg");
  if (svgStart === -1) return null;
  var svgEnd = svgText.lastIndexOf("</svg>") + 6;
  var svgEl = svgText.substring(svgStart, svgEnd);
  if (classAttr) {
    svgEl = svgEl.replace(/<svg /, "<svg class=\"" + classAttr + "\" ");
  }
  return svgEl;
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
  var byteCount = 0;

  // Step 1: inline badge icon
  var badgeRe = /<img\b([^>]*?)\bsrc\s*=\s*["']icon\/([^"'\/]+\.svg)["']([^>]*)>/gi;
  var badgeHits = [];
  html.replace(badgeRe, function(m, pre, name, post) {
    badgeHits.push(name);
    return m;
  });

  if (badgeHits.length > 0) {
    badgeIcon = badgeHits[0];
    iconPath = path.resolve(args.iconDir, badgeIcon);
    var svgText;
    try {
      svgText = await fs.readFile(iconPath, "utf8");
      byteCount = svgText.length;
    } catch (e) {
      fail("read icon SVG failed: " + e.message, { iconPath: iconPath, badgeIcon: badgeIcon });
    }

    html = html.replace(badgeRe, function(m, pre, name, post) {
      var classMatch = (pre + post).match(/class\s*=\s*["']([^"']+)["']/);
      var classAttr = classMatch ? classMatch[1] : "";
      var inline = makeInlineSvg(svgText, classAttr);
      if (inline) {
        replaced += 1;
        return inline;
      }
      return m;
    });
  }

  // Step 2: inline logo
  var logoRe = /<img\b([^>]*?)\bsrc\s*=\s*["']logo\.svg["']([^>]*)>/gi;
  var logoMatch = html.match(logoRe);
  if (logoMatch) {
    var logoPath = path.resolve(args.assetsDir, "logo.svg");
    var logoSvg;
    try {
      logoSvg = await fs.readFile(logoPath, "utf8");
    } catch (e) {
      fail("read logo SVG failed: " + e.message, { logoPath: logoPath });
    }
    html = html.replace(logoRe, function(m, pre, post) {
      var classMatch = (pre + post).match(/class\s*=\s*["']([^"']+)["']/);
      var classAttr = classMatch ? classMatch[1] : "";
      var inline = makeInlineSvg(logoSvg, classAttr);
      if (inline) {
        replaced += 1;
        return inline;
      }
      return m;
    });
  }

  if (replaced === 0) {
    fail("no SVG img tags found in HTML", { file: absHtml });
  }

  try {
    await fs.writeFile(absHtml, html, "utf8");
  } catch (e) {
    fail("write html failed: " + e.message, { file: absHtml });
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    file: absHtml,
    badgeIcon: badgeIcon || "logo.svg",
    iconPath: iconPath || path.resolve(args.assetsDir, "logo.svg"),
    byteCount: byteCount,
    replaced: replaced
  }) + "\n");
}

main().catch(function(e) {
  fail("unexpected: " + (e && e.message ? e.message : String(e)));
});
