#!/usr/bin/env node

/**
 * deduplicate-lark-base.mjs — 飞书多维表格去重清理脚本
 *
 * 规则：
 *   面试转写表：按「面试ID + 申请ID」联合键去重，保留每组第一条，删除其余
 *
 * 删除策略：
 *   逐条调用 `lark-cli base +record-delete --record-id <id> --yes`
 *   不使用 batch JSON 接口（batch delete 在某些场景下会静默失败）
 *
 * 面试官信息表已废弃 — 不再处理。
 *
 * 用法：
 *   node deduplicate-lark-base.mjs [options]
 *
 * 选项：
 *   --lark-cli <path>           lark-cli 可执行文件路径
 *   --dry-run                   只分析不删除
 *   --timeout-ms <n>            单次操作超时（默认 60000）
 *   --concurrency <n>           并发删除进程数（默认 3；过高可能触发飞书限流）
 */

import { spawn } from "node:child_process";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Windows 命令行参数安全阈值（含 shell 包装开销）
const MAX_INLINE_JSON = 3000;

// ─── 默认配置 ───────────────────────────────────────────────
// 目标 Base 由用户在首次配置时写入 ~/.opencli/moka-config.json 的 feishu_base_url,
// 脚本从中解析出 app_token 与 table_id。
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".opencli", "moka-config.json");

const DEFAULTS = Object.freeze({
  timeoutMs: 60_000,
  concurrency: 3, // 并发删除进程数 — 保守值，避免飞书 API 限流
  larkCli: process.env.LARK_CLI || "lark-cli",
});

// 去重键所在字段的显示名。字段的内部 field_id 每张表都不同，因此启动时按名字
// 到当前表的字段列表里查真实 field_id（见 resolveFieldIds），不再硬编码。
const INTERVIEW_ID_FIELD_NAME = "面试ID";
const APPLICATION_ID_FIELD_NAME = "申请ID";

// ─── 错误类型 ────────────────────────────────────────────────
class DedupError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DedupError";
    this.details = details;
  }
}

// ─── 参数解析 ────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--lark-cli") out.larkCli = argv[++i];
    else if (arg === "--config") out.configPath = argv[++i];
    else if (arg === "--feishu-base-url") out.feishuBaseUrl = argv[++i];
    else if (arg === "--base-token") out.baseToken = argv[++i];
    else if (arg === "--transcript-table-id") out.transcriptTableId = argv[++i];
    else if (arg === "--timeout-ms") out.timeoutMs = Number(argv[++i]);
    else if (arg === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (arg === "--dry-run") out.dryRun = true;
    else throw new DedupError(`Unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  return [
    "Usage: node deduplicate-lark-base.mjs [options]",
    "",
    "Options:",
    "  --lark-cli <path>           Path to lark-cli executable",
    "  --config <path>             Config JSON (default ~/.opencli/moka-config.json)",
    "  --feishu-base-url <url>     Override feishu_base_url from config",
    "  --base-token <token>        Override Base app_token parsed from URL",
    "  --transcript-table-id <id>  Override transcript table ID parsed from URL",
    "  --dry-run                   Analyze only, no deletions",
    "  --timeout-ms <n>            Per-operation timeout (default 60000)",
    "  --concurrency <n>           Parallel delete processes (default 3)",
  ].join("\n");
}

// ─── 目标 Base 解析 ─────────────────────────────────────────
function parseFeishuBaseUrl(url) {
  if (!url || typeof url !== "string") {
    throw new DedupError("feishu_base_url is empty; run the first-time setup to configure it");
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new DedupError(`feishu_base_url is not a valid URL: ${url}`);
  }
  const match = parsed.pathname.match(/\/base\/([A-Za-z0-9]+)/);
  if (!match) {
    throw new DedupError(`feishu_base_url must contain /base/<app_token>: ${url}`);
  }
  const appToken = match[1];
  const tableId = parsed.searchParams.get("table");
  if (!tableId) {
    throw new DedupError(`feishu_base_url must include ?table=<table_id>: ${url}`);
  }
  return { appToken, tableId };
}

function readConfigSync(configPath) {
  try {
    const raw = fsSync.readFileSync(configPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new DedupError(`Failed to read config ${configPath}: ${err.message}`);
  }
}

function resolveTarget(options) {
  if (options.baseToken && options.transcriptTableId) {
    return { appToken: options.baseToken, tableId: options.transcriptTableId };
  }
  const url = options.feishuBaseUrl
    || readConfigSync(options.configPath || DEFAULT_CONFIG_PATH).feishu_base_url;
  const parsed = parseFeishuBaseUrl(url);
  return {
    appToken: options.baseToken || parsed.appToken,
    tableId: options.transcriptTableId || parsed.tableId,
  };
}

// ─── 工具函数 ────────────────────────────────────────────────
function tryParseJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * 执行 lark-cli 命令。
 * 当 jsonPayload 非空且较长时，将 JSON 写入 cwd 下临时文件，
 * 用 lark-cli 的 --json @./filename 语法引用，绕过 Windows 命令行长度限制。
 */
function runLarkCli(command, args, timeoutMs, jsonPayload) {
  return new Promise((resolve) => {
    let tempFile = null;
    let finalArgs = args;

    if (jsonPayload && jsonPayload.length > MAX_INLINE_JSON) {
      const fileName = `lark-payload-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
      tempFile = path.join(process.cwd(), fileName);
      fsSync.writeFileSync(tempFile, jsonPayload, "utf8");
      finalArgs = args.map((a) => (a === jsonPayload ? `@./${fileName}` : a));
    }

    const child = spawn(command, finalArgs, {
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
      if (tempFile) { try { fsSync.unlinkSync(tempFile); } catch {} }
      resolve({ code: 1, stdout, stderr, timedOut: false, error: true });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (tempFile) { try { fsSync.unlinkSync(tempFile); } catch {} }
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

async function invokeLarkCli(config, args, label) {
  const result = await runLarkCli(config.larkCli, args, config.timeoutMs);
  const envelope = tryParseJson(result.stdout);
  if (result.timedOut || result.code !== 0 || envelope?.ok !== true) {
    throw new DedupError(`${label} failed`, { code: result.code, stderr: result.stderr.slice(0, 500), timedOut: result.timedOut });
  }
  return envelope;
}

// ─── 字段名 → field_id 解析 ──────────────────────────────────
// 按字段显示名到当前表的字段清单里挑出真实 field_id。允许用户新建/更换 Base,
// 只要面试转写表里存在名为 INTERVIEW_ID_FIELD_NAME / APPLICATION_ID_FIELD_NAME
// 的字段即可（内容可以完全不同，字段的 field_id 也不再要求与旧表一致）。
async function resolveFieldIds(config, tableId, fieldNames) {
  const allFields = [];
  let pageToken = null;
  // 部分 lark-cli 版本的 +field-list 用 page-token 分页；无分页时单页返回即可。
  do {
    const args = [
      "base", "+field-list",
      "--base-token", config.baseToken,
      "--table-id", tableId,
      "--limit", "200",
      "--as", "user",
      "--format", "json",
    ];
    if (pageToken) args.push("--page-token", pageToken);
    const envelope = await invokeLarkCli(config, args, "list fields");
    const data = envelope.data || {};
    const items = Array.isArray(data.items) ? data.items
      : Array.isArray(data.data) ? data.data
      : Array.isArray(data.fields) ? data.fields
      : [];
    allFields.push(...items);
    pageToken = data.has_more && data.page_token ? data.page_token : null;
  } while (pageToken);

  const byName = new Map();
  for (const f of allFields) {
    const name = f?.field_name ?? f?.name;
    const id = f?.field_id ?? f?.id;
    if (name && id) byName.set(String(name), String(id));
  }

  const resolved = {};
  const missing = [];
  for (const name of fieldNames) {
    const id = byName.get(name);
    if (id) resolved[name] = id;
    else missing.push(name);
  }
  if (missing.length > 0) {
    throw new DedupError(
      `Field(s) not found on table ${tableId}: ${missing.join(", ")}. `
      + `The transcript table must contain fields named exactly: ${fieldNames.join(", ")}.`,
      { availableFields: [...byName.keys()], missing },
    );
  }
  return resolved;
}

// ─── 拉取全表记录 ────────────────────────────────────────────
async function fetchAllRecords(config, tableId, fieldIds) {
  const allRecords = [];
  const allRecordIds = [];
  let offset = 0;
  const limit = 200;

  while (true) {
    const args = [
      "base", "+record-list",
      "--base-token", config.baseToken,
      "--table-id", tableId,
      "--limit", String(limit),
      "--offset", String(offset),
      "--as", "user",
      "--format", "json",
    ];
    for (const fid of fieldIds) args.push("--field-id", fid);

    const envelope = await invokeLarkCli(config, args, `fetch records offset=${offset}`);
    const data = envelope.data;

    if (data.data && Array.isArray(data.data)) {
      allRecords.push(...data.data);
    }
    if (data.record_id_list && Array.isArray(data.record_id_list)) {
      allRecordIds.push(...data.record_id_list);
    }

    if (data.has_more === false || (data.data && data.data.length < limit)) break;
    if (data.data && data.data.length === 0) break;
    offset += limit;
  }

  return { records: allRecords, recordIds: allRecordIds };
}

// ─── 逐条删除 ────────────────────────────────────────────────
// 不使用 batch JSON 接口 — 逐条 +record-delete 更可靠。
// batch delete 在某些场景下会静默失败（返回 ok 但未实际删除，
// 或直接报错 batch delete N records failed）。
// 逐条删除虽然慢一点，但每条都有明确的成功/失败反馈。
async function deleteRecordsIndividually(config, tableId, recordIds, dryRun) {
  if (recordIds.length === 0) return { deleted: 0, failed: 0, errors: [] };

  if (dryRun) {
    return { deleted: recordIds.length, failed: 0, errors: [], dryRun: true };
  }

  let deleted = 0;
  let failed = 0;
  const errors = [];

  // 构建逐条删除任务
  const tasks = recordIds.map((recordId) => async () => {
    const args = [
      "base", "+record-delete",
      "--base-token", config.baseToken,
      "--table-id", tableId,
      "--record-id", recordId,
      "--yes",
      "--as", "user",
      "--format", "json",
    ];
    try {
      const result = await runLarkCli(config.larkCli, args, config.timeoutMs);
      const envelope = tryParseJson(result.stdout);
      if (result.code === 0 && envelope?.ok === true) {
        deleted += 1;
      } else {
        failed += 1;
        errors.push({
          recordId,
          code: result.code,
          stderr: result.stderr.slice(0, 200),
        });
      }
    } catch (err) {
      failed += 1;
      errors.push({ recordId, error: err.message });
    }
  });

  await runConcurrent(tasks, config.concurrency);

  return { deleted, failed, errors };
}

// ─── 并发控制 ────────────────────────────────────────────────
async function runConcurrent(tasks, concurrency = 3) {
  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      results[index] = await tasks[index]();
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// ─── 去重逻辑 ────────────────────────────────────────────────

/**
 * 面试转写表按「面试ID + 申请ID」联合键去重
 * @returns { keepBy: Map<key, recordId>, toDelete: string[] }
 */
function deduplicateTranscripts(records, recordIds) {
  const keepBy = new Map(); // businessKey → recordId (保留的第一条)
  const toDelete = [];

  for (let i = 0; i < records.length; i++) {
    const interviewId = records[i][0]; // 面试ID
    const applicationId = records[i][1]; // 申请ID
    const recordId = recordIds[i];

    // 跳过没有面试ID或申请ID的空行
    if (interviewId == null || applicationId == null) {
      continue;
    }

    const key = `${applicationId}:${interviewId}`;

    if (keepBy.has(key)) {
      toDelete.push(recordId);
    } else {
      keepBy.set(key, recordId);
    }
  }

  return { keepBy, toDelete };
}

// ─── 主流程 ──────────────────────────────────────────────────
export async function deduplicate(options) {
  const target = resolveTarget(options);
  const config = {
    ...DEFAULTS,
    larkCli: options.larkCli || DEFAULTS.larkCli,
    baseToken: target.appToken,
    transcriptTableId: target.tableId,
    timeoutMs: options.timeoutMs || DEFAULTS.timeoutMs,
    concurrency: options.concurrency || DEFAULTS.concurrency,
    dryRun: options.dryRun || false,
  };

  const summary = {
    ok: true,
    dryRun: config.dryRun,
    transcripts: { before: 0, after: 0, deleted: 0, failed: 0, errors: [] },
  };

  // ── 步骤1: 按字段名解析出当前表真实的 field_id，再拉全量记录 ──
  const fieldIds = await resolveFieldIds(
    config,
    config.transcriptTableId,
    [INTERVIEW_ID_FIELD_NAME, APPLICATION_ID_FIELD_NAME],
  );
  // 顺序固定：records[i][0]=面试ID, records[i][1]=申请ID（deduplicateTranscripts 依赖此顺序）
  const transcriptFields = [
    fieldIds[INTERVIEW_ID_FIELD_NAME],
    fieldIds[APPLICATION_ID_FIELD_NAME],
  ];
  const transcriptData = await fetchAllRecords(config, config.transcriptTableId, transcriptFields);
  summary.transcripts.before = transcriptData.recordIds.length;

  // ── 步骤2: 分析去重 ──
  const transcriptDedup = deduplicateTranscripts(transcriptData.records, transcriptData.recordIds);
  summary.transcripts.after = transcriptDedup.keepBy.size;
  summary.transcripts.deleted = transcriptDedup.toDelete.length;

  // 如果 dry-run，到此为止
  if (config.dryRun) {
    summary.wouldDeleteTranscripts = transcriptDedup.toDelete;
    return summary;
  }

  // ── 步骤3: 逐条删除重复记录 ──
  if (transcriptDedup.toDelete.length > 0) {
    const delResult = await deleteRecordsIndividually(
      config, config.transcriptTableId, transcriptDedup.toDelete, false,
    );
    summary.transcripts.deleted = delResult.deleted;
    summary.transcripts.failed = delResult.failed;
    summary.transcripts.errors = delResult.errors;
  }

  // 如果有任何删除失败，标记整体 ok=false（但仍返回已删除数量）
  if (summary.transcripts.failed > 0) {
    summary.ok = false;
  }

  return summary;
}

// ─── CLI 入口 ────────────────────────────────────────────────
async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const summary = await deduplicate(options);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    const safe = {
      ok: false,
      error: {
        type: error?.name || "Error",
        message: error?.message || "Unknown dedup error",
      },
    };
    process.stderr.write(`${JSON.stringify(safe, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
