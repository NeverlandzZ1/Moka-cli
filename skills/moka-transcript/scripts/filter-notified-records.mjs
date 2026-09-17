#!/usr/bin/env node

/**
 * 在报告生成前过滤已经通知过的面试。
 *
 * 只读飞书 Base：若已有行的「申请ID + 面试ID」与 Moka 导出记录完全匹配，
 * 且「是否已通知」为「是」，则从本次 JSON 的 records[] 中移除该记录。
 * 这样记录不会进入评分、HTML、Drive 上传、sync、dedup 或人员回填流程。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".opencli", "moka-config.json");
const INTERVIEW_ID_FIELD_NAME = "面试ID";
const APPLICATION_ID_FIELD_NAME = "申请ID";
const NOTIFIED_FIELD_NAME = "是否已通知";

class FilterError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "FilterError";
    this.details = details;
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") options.input = argv[++index];
    else if (arg === "--lark-cli") options.larkCli = argv[++index];
    else if (arg === "--config") options.configPath = argv[++index];
    else if (arg === "--feishu-base-url") options.feishuBaseUrl = argv[++index];
    else if (arg === "--base-token") options.baseToken = argv[++index];
    else if (arg === "--transcript-table-id") options.transcriptTableId = argv[++index];
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new FilterError(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage: node filter-notified-records.mjs --input <transcript.json> [options]",
    "",
    "Options:",
    "  --lark-cli <path>           Path to lark-cli executable",
    "  --config <path>             Config JSON (default ~/.opencli/moka-config.json)",
    "  --feishu-base-url <url>     Override feishu_base_url from config",
    "  --base-token <token>        Override Base app_token parsed from URL",
    "  --transcript-table-id <id>  Override transcript table ID parsed from URL",
    "  --timeout-ms <n>            Per-operation timeout (default 60000)",
    "  --dry-run                   Report matches without rewriting input",
  ].join("\n");
}

function tryParseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function readConfig(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new FilterError(`Failed to read config ${configPath}: ${error.message}`);
  }
}

function parseFeishuBaseUrl(value) {
  if (!value || typeof value !== "string") throw new FilterError("feishu_base_url is empty");
  let parsed;
  try { parsed = new URL(value); } catch { throw new FilterError("feishu_base_url is not a valid URL"); }
  const match = parsed.pathname.match(/\/base\/([A-Za-z0-9]+)/);
  const tableId = parsed.searchParams.get("table");
  if (!match || !tableId) throw new FilterError("feishu_base_url must include /base/<app_token>?table=<table_id>");
  return { baseToken: match[1], transcriptTableId: tableId };
}

function resolveTarget(options) {
  const fromUrl = parseFeishuBaseUrl(
    options.feishuBaseUrl || readConfig(options.configPath || DEFAULT_CONFIG_PATH).feishu_base_url,
  );
  return {
    baseToken: options.baseToken || fromUrl.baseToken,
    transcriptTableId: options.transcriptTableId || fromUrl.transcriptTableId,
  };
}

function runLarkCli(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", () => { clearTimeout(timer); resolve({ code: 1, stdout, stderr, timedOut: false }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr, timedOut }); });
  });
}

async function invokeLarkCli(config, args, label) {
  const result = await runLarkCli(config.larkCli, args, config.timeoutMs);
  const envelope = tryParseJson(result.stdout);
  if (result.timedOut || result.code !== 0 || envelope?.ok !== true) {
    throw new FilterError(`${label} failed`, { code: result.code, stderr: result.stderr.slice(0, 500), timedOut: result.timedOut });
  }
  return envelope;
}

async function resolveFieldIds(config) {
  const envelope = await invokeLarkCli(config, [
    "base", "+field-list", "--base-token", config.baseToken, "--table-id", config.transcriptTableId,
    "--limit", "200", "--as", "user", "--format", "json",
  ], "list fields");
  const fields = envelope.data?.items || envelope.data?.data || envelope.data?.fields || [];
  const byName = new Map(fields.map((field) => [String(field?.field_name ?? field?.name ?? ""), String(field?.field_id ?? field?.id ?? "")]));
  const names = [INTERVIEW_ID_FIELD_NAME, APPLICATION_ID_FIELD_NAME, NOTIFIED_FIELD_NAME];
  const missing = names.filter((name) => !byName.get(name));
  if (missing.length > 0) {
    throw new FilterError(`Base 缺少预筛所需字段: ${missing.join("、")}`, { missing });
  }
  return Object.fromEntries(names.map((name) => [name, byName.get(name)]));
}

async function fetchNotifiedKeys(config, fieldIds) {
  const keys = new Set();
  let offset = 0;
  const limit = 200;
  while (true) {
    const args = [
      "base", "+record-list", "--base-token", config.baseToken, "--table-id", config.transcriptTableId,
      "--limit", String(limit), "--offset", String(offset), "--as", "user", "--format", "json",
      "--field-id", fieldIds[INTERVIEW_ID_FIELD_NAME],
      "--field-id", fieldIds[APPLICATION_ID_FIELD_NAME],
      "--field-id", fieldIds[NOTIFIED_FIELD_NAME],
    ];
    const envelope = await invokeLarkCli(config, args, `fetch records offset=${offset}`);
    const rows = Array.isArray(envelope.data?.data) ? envelope.data.data : [];
    for (const row of rows) {
      const [interviewId, applicationId, notified] = row;
      if (isNotifiedYes(notified)) {
        const key = businessKey(applicationId, interviewId);
        if (key) keys.add(key);
      }
    }
    if (envelope.data?.has_more === false || rows.length < limit || rows.length === 0) break;
    offset += limit;
  }
  return keys;
}

export function isNotifiedYes(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.some(isNotifiedYes);
  if (typeof value === "string") return value.trim() === "是";
  if (typeof value === "object") return [value.text, value.value, value.name].some((item) => typeof item === "string" && item.trim() === "是");
  return false;
}

export function businessKey(applicationId, interviewId) {
  if (applicationId == null || interviewId == null || applicationId === "" || interviewId === "") return null;
  return `${applicationId}:${interviewId}`;
}

export async function filterNotifiedRecords(options) {
  if (!options.input) throw new FilterError("--input is required");
  if (!Number.isFinite(options.timeoutMs) && options.timeoutMs != null) throw new FilterError("--timeout-ms must be a number");
  const inputPath = path.resolve(options.input);
  const payload = tryParseJson(fs.readFileSync(inputPath, "utf8"));
  if (!payload || !Array.isArray(payload.records)) throw new FilterError("input must be a JSON object containing records[]");
  const target = resolveTarget(options);
  const config = { ...target, larkCli: options.larkCli || process.env.LARK_CLI || "lark-cli", timeoutMs: options.timeoutMs || 60_000 };
  const fieldIds = await resolveFieldIds(config);
  const notifiedKeys = await fetchNotifiedKeys(config, fieldIds);
  const before = payload.records.length;
  const filtered = payload.records.filter((record) => !notifiedKeys.has(businessKey(record?.applicationId, record?.interviewId)));
  const skipped = before - filtered.length;
  if (!options.dryRun && skipped > 0) {
    payload.records = filtered;
    const tempPath = `${inputPath}.filtering-${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, inputPath);
  }
  return { ok: true, dryRun: Boolean(options.dryRun), inputRecords: before, notifiedKeys: notifiedKeys.size, skippedAlreadyNotified: skipped, remainingRecords: filtered.length };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  console.log(JSON.stringify(await filterNotifiedRecords(options)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1"))) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message, details: error.details || {} }));
    process.exitCode = 1;
  });
}
