#!/usr/bin/env node

/**
 * upload-html-to-drive.mjs — 把面试复盘 HTML 报告上传到飞书云盘(当前用户根目录),
 * 返回 file_token 和可访问 URL,供 sync-lark-base.mjs 的「面试复盘报告」列使用。
 *
 * 调用:
 *   node upload-html-to-drive.mjs --file <html绝对路径> [--lark-cli <path>] [--config <path>] [--feishu-base-url <url>]
 *
 * stdout(成功):
 *   { "ok": true, "file_token": "<token>", "url": "https://<tenant>.feishu.cn/file/<token>" }
 *
 * stderr(失败): { "ok": false, "error": { "type": "...", "message": "..." } }, exit 1
 *
 * 设计约束:
 *  - 复用 lark-cli 已授权 user 身份,不新增凭证/scope 配置。
 *  - 上传位置固定为「当前登录用户的云盘根目录」(不传 --parent-node,不新增 feishu_drive_folder_token 配置)。
 *  - tenant 从 ~/.opencli/moka-config.json 的 feishu_base_url host 提取(与 sync 脚本共用一份配置)。
 *  - 上传失败要抛错(exit 1),让上游流水线停下、留原始报错让人排查。
 */

import { spawn } from "node:child_process";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".opencli", "moka-config.json");
const DEFAULT_TIMEOUT_MS = 120_000;

class UploadError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "UploadError";
    this.details = details;
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--file") out.file = argv[++i];
    else if (arg === "--lark-cli") out.larkCli = argv[++i];
    else if (arg === "--config") out.configPath = argv[++i];
    else if (arg === "--feishu-base-url") out.feishuBaseUrl = argv[++i];
    else if (arg === "--timeout-ms") out.timeoutMs = Number(argv[++i]);
    else throw new UploadError(`Unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  return [
    "Usage:",
    "  node upload-html-to-drive.mjs --file <html-path> [options]",
    "",
    "Options:",
    "  --lark-cli <path>           Path to lark-cli executable",
    "  --config <path>             Config JSON (default ~/.opencli/moka-config.json)",
    "  --feishu-base-url <url>     Override feishu_base_url from config (tenant host source)",
    "  --timeout-ms <n>            Upload timeout ms (default 120000)",
  ].join("\n");
}

function readConfigSync(configPath) {
  try {
    const raw = fsSync.readFileSync(configPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new UploadError(`Failed to read config ${configPath}: ${err.message}`);
  }
}

function resolveTenantHost(options) {
  const url = options.feishuBaseUrl
    || readConfigSync(options.configPath || DEFAULT_CONFIG_PATH).feishu_base_url;
  if (!url || typeof url !== "string") {
    throw new UploadError("feishu_base_url is empty; run the first-time setup to configure it");
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new UploadError(`feishu_base_url is not a valid URL: ${url}`);
  }
  return parsed.host;
}

function resolveLarkCli(options) {
  return options.larkCli || process.env.LARK_CLI || "lark-cli";
}

function tryParseJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch {}
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
  }
  return null;
}

function runLarkCli(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr, timedOut: false, error: true });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

function extractFileToken(envelope) {
  if (!envelope || typeof envelope !== "object") return null;
  const data = envelope.data || envelope;
  return data?.file_token
    || data?.fileToken
    || data?.file?.file_token
    || data?.token
    || null;
}

async function upload(options) {
  if (!options.file) throw new UploadError("--file is required");
  const absPath = path.resolve(options.file);
  if (!fsSync.existsSync(absPath)) {
    throw new UploadError(`file not found: ${absPath}`);
  }
  const tenantHost = resolveTenantHost(options);
  const larkCli = resolveLarkCli(options);
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  const args = ["drive", "+upload", "--file", absPath, "--format", "json"];
  const result = await runLarkCli(larkCli, args, timeoutMs);
  const envelope = tryParseJson(result.stdout);

  if (result.timedOut) {
    throw new UploadError(`lark-cli drive +upload timed out after ${timeoutMs}ms`);
  }
  if (result.error || result.code !== 0 || !envelope?.ok) {
    const msg = envelope?.error?.message || result.stderr?.slice(0, 500) || "lark-cli drive +upload failed";
    throw new UploadError(msg);
  }
  const fileToken = extractFileToken(envelope);
  if (!fileToken) {
    throw new UploadError("lark-cli drive +upload succeeded but returned no file_token");
  }
  const url = `https://${tenantHost}/file/${fileToken}`;
  return { ok: true, file_token: fileToken, url };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const summary = await upload(options);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    const safe = {
      ok: false,
      error: {
        type: error?.name || "Error",
        message: error?.message || "Unknown upload error",
      },
    };
    process.stderr.write(`${JSON.stringify(safe, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export { upload };
