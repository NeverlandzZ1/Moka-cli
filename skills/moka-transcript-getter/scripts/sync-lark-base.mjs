#!/usr/bin/env node

/**
 * sync-lark-base.mjs — Moka 转写批量写入飞书多维表格
 *
 * 核心设计：
 * 1. 输入数据先在内存中去重（applicationId + interviewId 联合键）
 * 2. 不查飞书，直接批量写入面试转写表（batch-create）
 * 3. 写入后由 deduplicate-lark-base.mjs 负责飞书端的去重清理
 *
 * Windows 兼容：当 --json 参数超过命令行长度限制时，自动切换为
 * lark-cli 的 @file.json 语法（将 JSON 写入 cwd 下临时文件，用相对路径引用）。
 *
 * 面试官信息表已废弃 — 面试官姓名仅作为 text 字段写入面试转写表的「面试官」列。
 *
 * 成功条件：退出码 0 且 stdout JSON 的 ok == true
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─── 固定配置 ───────────────────────────────────────────────
const DEFAULTS = Object.freeze({
  baseToken: "TeB3bU3ltak2MWsD8I0cdoxPnSf",
  transcriptTableId: "tblUYL6KszcCEzuw",
  timeoutMs: 60_000,
  batchSize: 200, // 每批次写入条数（飞书 API 上限 200）
});

// Windows 命令行参数安全阈值（含 shell 包装开销）
// Windows CreateProcess 上限约 32767 字符，shell 层有额外开销
const MAX_INLINE_JSON = 3000;

// ─── 错误类型 ────────────────────────────────────────────────
class SyncError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SyncError";
    this.details = details;
  }
}

// ─── 参数解析 ────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--input") out.input = argv[++i];
    else if (arg === "--lark-cli") out.larkCli = argv[++i];
    else if (arg === "--base-token") out.baseToken = argv[++i];
    else if (arg === "--transcript-table-id") out.transcriptTableId = argv[++i];
    else if (arg === "--timeout-ms") out.timeoutMs = Number(argv[++i]);
    else if (arg === "--dry-run") out.dryRun = true;
    else throw new SyncError(`Unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  return [
    "Usage:",
    "  node sync-lark-base.mjs --input <transcript.json> [options]",
    "",
    "Options:",
    "  --lark-cli <path>           Path to lark-cli executable",
    "  --base-token <token>        Override default Base token",
    "  --transcript-table-id <id>  Override transcript table ID",
    "  --timeout-ms <n>            Per-operation timeout (default 60000)",
    "  --dry-run                   Print plan without writing to Lark",
  ].join("\n");
}

// ─── 输入去重 ────────────────────────────────────────────────
function normalizeId(value, field) {
  if (value === null || value === undefined || value === "") {
    throw new SyncError(`${field} is required`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new SyncError(`${field} must be a non-negative safe integer`);
  }
  return number;
}

function businessKey(record) {
  return `${record.applicationId}:${record.interviewId}`;
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SyncError("Each records[] item must be an object");
  }
  const interviewerNames = Array.isArray(raw.interviewerNames)
    ? [...new Set(raw.interviewerNames.map((v) => String(v ?? "").trim()).filter(Boolean))]
    : [];
  return {
    ...raw,
    applicationId: normalizeId(raw.applicationId, "applicationId"),
    interviewId: normalizeId(raw.interviewId, "interviewId"),
    interviewerNames,
  };
}

function deduplicateRecords(records) {
  if (!Array.isArray(records)) throw new SyncError("Input JSON must contain a records array");
  const map = new Map();
  for (const raw of records) {
    const record = normalizeRecord(raw);
    map.set(businessKey(record), record); // 同 key 保留最后一条
  }
  return {
    records: [...map.values()],
    dropped: records.length - map.size,
  };
}

// ─── 字段格式化 ──────────────────────────────────────────────
function asText(value) {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

function asOptionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatUtcDateTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function stringifyQuestionAnalysis(value) {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function transcriptFields(record) {
  return {
    "候选人姓名": asText(record.candidateName),
    "岗位名称": asText(record.jobTitle),
    "面试官": record.interviewerNames.join(", "),
    "面试轮次": asText(record.roundName),
    "面试开始时间": formatUtcDateTime(record.startTime),
    "转写状态": asText(record.transcriptStatus),
    "逐字稿": asText(record.transcript),
    "评估总结": asText(record.evaluationSummary),
    "问题分析": stringifyQuestionAnalysis(record.questionAnalysis),
    "Moka码": asText(record.mokaCode),
    "Moka消息": asText(record.mokaMessage),
    "申请ID": record.applicationId,
    "岗位ID": asText(record.jobId),
    "面试ID": record.interviewId,
    "轮次序号": asOptionalNumber(record.round),
    "转写类型": asOptionalNumber(record.transcriptType),
  };
}

// ─── 脱敏 ─────────────────────────────────────────────────────
function maskName(name) {
  const text = asText(name).trim();
  if (!text) return "未记录";
  return text
    .replace(/[\u3400-\u9fff]+/g, (part) => (part.length === 1 ? "*" : `${part[0]}${"*".repeat(part.length - 1)}`))
    .replace(/[A-Za-z]+/g, (part) => (part.length === 1 ? part : `${part[0]}${"*".repeat(part.length - 1)}`))
    .replace(/\d/g, "*");
}

// ─── lark-cli 调用层 ─────────────────────────────────────────
function resolveLarkCli(options) {
  return options.larkCli || process.env.LARK_CLI || "lark-cli";
}

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
 *
 * 当 jsonPayload 非空且较长时（超过 MAX_INLINE_JSON），将 JSON 写入当前工作目录下的
 * 临时文件，并用 lark-cli 的 `--json @./filename` 语法引用，以绕过 Windows 命令行
 * 长度限制（ENAMETOOLONG）。lark-cli 要求 @file 路径必须是相对路径。
 *
 * @param {string} command  - lark-cli 可执行文件路径
 * @param {string[]} args   - 命令参数（可能包含占位 jsonPayload 值）
 * @param {number} timeoutMs - 超时毫秒
 * @param {string|null} jsonPayload - 需要通过 --json 传递的 JSON 字符串（可选）
 * @returns {Promise<{code, stdout, stderr, timedOut, error}>}
 */
function runLarkCli(command, args, timeoutMs, jsonPayload) {
  return new Promise((resolve) => {
    let tempFile = null;
    let finalArgs = args;

    // Windows（或任意平台）上 JSON payload 过大时，切换为 @file.json 语法
    if (jsonPayload && jsonPayload.length > MAX_INLINE_JSON) {
      const fileName = `lark-payload-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
      tempFile = path.join(process.cwd(), fileName);
      fsSync.writeFileSync(tempFile, jsonPayload, "utf8");
      // 将 args 中的 jsonPayload 值替换为 "@./filename"（lark-cli 要求相对路径）
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

// ─── 批量创建面试转写 ────────────────────────────────────────
async function batchCreateTranscripts(config, records, summary) {
  const { larkCli, baseToken, transcriptTableId, batchSize, timeoutMs, dryRun } = config;

  if (dryRun) {
    summary.created = records.length;
    return records.map((r) => ({ record: r, recordId: `dry-run-${businessKey(r)}`, operation: "dry-run" }));
  }

  // 为每条记录组装字段
  const prepared = records.map((record) => {
    const fields = transcriptFields(record);
    return { record, fields };
  });

  const results = [];

  // batch-create 使用 {"fields": ["字段1","字段2",...], "rows": [["值1","值2",...], ...]} 格式
  const fieldNames = Object.keys(prepared[0].fields);

  // 分批 batch-create（每批最多 batchSize 条）
  for (let i = 0; i < prepared.length; i += batchSize) {
    const batch = prepared.slice(i, i + batchSize);
    const rows = batch.map((item) => fieldNames.map((fn) => item.fields[fn] ?? null));

    const batchPayloadJson = JSON.stringify({ fields: fieldNames, rows });
    const args = [
      "base", "+record-batch-create",
      "--base-token", baseToken,
      "--table-id", transcriptTableId,
      "--json", batchPayloadJson,
      "--format", "json",
    ];

    const result = await runLarkCli(larkCli, args, timeoutMs, batchPayloadJson);
    const envelope = tryParseJson(result.stdout);

    // batch-create 返回的 record_id_list 按顺序对应 rows
    const createdIds = envelope?.data?.record_id_list || [];
    if (envelope?.ok && createdIds.length > 0) {
      for (let j = 0; j < batch.length; j++) {
        const recordId = createdIds[j] || null;
        results.push({
          record: batch[j].record,
          recordId,
          operation: "created",
        });
        if (recordId) summary.created += 1;
      }
    } else {
      // batch-create 失败，降级为逐条创建
      summary.batchCreateFallback = true;
      for (const item of batch) {
        const singlePayloadJson = JSON.stringify(item.fields);
        const singleArgs = [
          "base", "+record-upsert",
          "--base-token", baseToken,
          "--table-id", transcriptTableId,
          "--json", singlePayloadJson,
          "--format", "json",
        ];
        const singleResult = await runLarkCli(larkCli, singleArgs, timeoutMs, singlePayloadJson);
        const singleEnvelope = tryParseJson(singleResult.stdout);
        const recordId = singleEnvelope?.data?.record?.record_id || null;
        results.push({ record: item.record, recordId, operation: recordId ? "created" : "failed" });
        if (recordId) summary.created += 1;
      }
    }
  }

  return results;
}

// ─── 主流程 ──────────────────────────────────────────────────
export async function sync(options) {
  if (!options.input) throw new SyncError("--input is required");

  const inputPath = path.resolve(options.input);
  const config = {
    ...DEFAULTS,
    larkCli: resolveLarkCli(options),
    baseToken: options.baseToken || DEFAULTS.baseToken,
    transcriptTableId: options.transcriptTableId || DEFAULTS.transcriptTableId,
    timeoutMs: options.timeoutMs || DEFAULTS.timeoutMs,
    batchSize: DEFAULTS.batchSize,
    dryRun: options.dryRun || false,
  };

  // 读取并去重输入
  const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const deduped = deduplicateRecords(input.records);

  const summary = {
    ok: true,
    inputRecords: input.records.length,
    deduplicatedRecords: deduped.records.length,
    inputDuplicatesDropped: deduped.dropped,
    created: 0,
    batchCreateFallback: false,
    records: [],
  };

  if (deduped.records.length === 0) {
    return summary;
  }

  // 批量创建面试转写
  const transcriptResults = await batchCreateTranscripts(config, deduped.records, summary);

  // 组装脱敏摘要
  summary.records = transcriptResults.map(({ record, recordId, operation }) => ({
    applicationId: record.applicationId,
    interviewId: record.interviewId,
    candidateName: maskName(record.candidateName),
    interviewerNames: record.interviewerNames.map(maskName),
    jobTitle: asText(record.jobTitle),
    operation,
    recordId,
  }));

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
    const summary = await sync(options);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    const safe = {
      ok: false,
      error: {
        type: error?.name || "Error",
        message: error?.message || "Unknown sync error",
      },
    };
    process.stderr.write(`${JSON.stringify(safe, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
