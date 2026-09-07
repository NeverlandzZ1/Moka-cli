#!/usr/bin/env node

/**
 * backfill-interviewer-user.mjs — 回填「面试官(人员)」列
 *
 * 场景:
 *   面试转写表有两列面试官信息 —
 *     - 「面试官」 = text 列, sync 时按 record.interviewerNames.join(", ") 写入。
 *     - 「面试官(人员)」 = user 列, 需要形如 [{ id: "ou_xxx" }] 的对象数组;
 *       sync 脚本不写这列 — 因为姓名到 open_id 的映射不在采集数据里。
 *   本脚本在 sync/dedup 之后运行, 扫描全表把「面试官(人员)」为空但「面试官」有值
 *   的记录挑出来, 用两种手段解析姓名 → open_id, 逐条 upsert 回填。
 *
 * 4 步执行 (基于用户验证过的成功路径):
 *   1) +field-list 拿三个字段的 field_id, 校验类型 (text / user / anything)。
 *   2) +record-list --field-id ... 按行投影拉全量, 拿到每行的
 *      (record_id, 面试官 text, 面试官(人员) users, 面试ID) 元组。定位空行。
 *   3) 建 name → open_id 映射:
 *      - 来源 A: 已填充记录 — 若同表其他行 面试官 = "A、B" 且 面试官(人员) = [{id:1},{id:2}],
 *        按顺序拆解得到 A→1、B→2。
 *        (稳健: 只取『名字数量与人员数量一致』的行, 避免顺序不匹配)
 *      - 来源 B: `lark-cli contact +search-user --query <name>` 精确匹配第一条 open_id,
 *        补齐来源 A 覆盖不到的姓名。
 *   4) 逐条 `+record-upsert --record-id ... --json '{"面试官(人员)":[{id:...},...]}'`
 *      不用 +record-batch-update — 它是同值批量更新, 每条 record 的人员不同,
 *      必须逐条。默认 3 并发, 与 dedup 脚本一致, 防止飞书限流。
 *
 * 面试官(人员)字段显示名解析容错:
 *   Base 里这列的显示名不同租户/不同建表方式可能是「面试官(人员)」「面试官 (人员 )」
 *   「面试官（人员）」 等 (半/全角括号、括号内外多余空格) 混用。脚本按下列顺序找:
 *     1. 精确匹配 INTERVIEWER_USER_FIELD_NAME 常量。
 *     2. 归一化后匹配 (剥去所有 ASCII/全角空格 + 全角→半角括号) — 只要归一化后落在
 *        `面试官(人员)`, 就认这列。
 *   如果表里同时存在多列都归一化到同一形态, 报错让人先在飞书 Base 上把重复列改掉,
 *   而不是脚本猜。
 *
 * 用法:
 *   node backfill-interviewer-user.mjs [options]
 *
 * 选项:
 *   --lark-cli <path>           lark-cli 可执行文件路径
 *   --config <path>             配置文件路径 (默认 ~/.opencli/moka-config.json)
 *   --feishu-base-url <url>     覆盖 config 里的 feishu_base_url
 *   --base-token <token>        覆盖解析结果 (与 --transcript-table-id 同时给可跳过 URL 解析)
 *   --transcript-table-id <id>  同上
 *   --dry-run                   只分析不写入
 *   --timeout-ms <n>            单次操作超时 (默认 60000)
 *   --concurrency <n>           upsert 并发数 (默认 3)
 */

import { spawn } from "node:child_process";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_INLINE_JSON = 3000;
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".opencli", "moka-config.json");

const DEFAULTS = Object.freeze({
  timeoutMs: 60_000,
  concurrency: 3,
  larkCli: process.env.LARK_CLI || "lark-cli",
});

// ─── 目标字段名 ──────────────────────────────────────────────
// 面试官 text 列固定叫「面试官」; 人员列的常见叫法参见文件头部注释,
// 脚本会做归一化匹配, 不强制表里用哪一种写法。
const INTERVIEWER_TEXT_FIELD_NAME = "面试官";
const INTERVIEWER_USER_FIELD_NAME = "面试官 (人员 )"; // 首选精确匹配
const INTERVIEW_ID_FIELD_NAME = "面试ID";

// 姓名字符串拆分分隔符: sync 脚本用 ", " 拼接, 但同一张 Base 里既往人工录入可能
// 混用中英文顿号/逗号/斜杠。这里一律按下列分隔符切开。
const NAME_SPLIT_RE = /[、,，/;；]+/;

// ─── 错误类型 ────────────────────────────────────────────────
class BackfillError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "BackfillError";
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
    else throw new BackfillError(`Unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  return [
    "Usage: node backfill-interviewer-user.mjs [options]",
    "",
    "Options:",
    "  --lark-cli <path>           Path to lark-cli executable",
    "  --config <path>             Config JSON (default ~/.opencli/moka-config.json)",
    "  --feishu-base-url <url>     Override feishu_base_url from config",
    "  --base-token <token>        Override Base app_token parsed from URL",
    "  --transcript-table-id <id>  Override transcript table ID parsed from URL",
    "  --dry-run                   Analyze only, no writes",
    "  --timeout-ms <n>            Per-operation timeout (default 60000)",
    "  --concurrency <n>           Parallel upsert processes (default 3)",
  ].join("\n");
}

// ─── URL / config 解析 (与 sync/dedup 一致) ─────────────────
function parseFeishuBaseUrl(url) {
  if (!url || typeof url !== "string") {
    throw new BackfillError("feishu_base_url is empty; run the first-time setup to configure it");
  }
  let parsed;
  try { parsed = new URL(url); }
  catch { throw new BackfillError(`feishu_base_url is not a valid URL: ${url}`); }
  const match = parsed.pathname.match(/\/base\/([A-Za-z0-9]+)/);
  if (!match) throw new BackfillError(`feishu_base_url must contain /base/<app_token>: ${url}`);
  const appToken = match[1];
  const tableId = parsed.searchParams.get("table");
  if (!tableId) throw new BackfillError(`feishu_base_url must include ?table=<table_id>: ${url}`);
  return { appToken, tableId };
}

function readConfigSync(configPath) {
  try {
    const raw = fsSync.readFileSync(configPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new BackfillError(`Failed to read config ${configPath}: ${err.message}`);
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

// ─── lark-cli 调用层 ─────────────────────────────────────────
function tryParseJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); }
  catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
    }
    return null;
  }
}

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
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
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

async function invokeLarkCli(config, args, label, jsonPayload) {
  const result = await runLarkCli(config.larkCli, args, config.timeoutMs, jsonPayload);
  const envelope = tryParseJson(result.stdout);
  if (result.timedOut || result.code !== 0 || envelope?.ok !== true) {
    throw new BackfillError(`${label} failed`, {
      code: result.code,
      stderr: (result.stderr || "").slice(0, 500),
      timedOut: result.timedOut,
      envelope: envelope || null,
    });
  }
  return envelope;
}

// ─── 字段名归一化 ──────────────────────────────────────────────
// 处理「面试官(人员)」 vs 「面试官 (人员 )」 vs 「面试官（人员）」 等写法差异。
function normalizeFieldName(s) {
  if (!s) return "";
  return String(s)
    .replace(/[\s　]+/g, "")   // 剥所有空白
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")");
}

async function resolveFieldIds(config, tableId) {
  const allFields = [];
  let pageToken = null;
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

  // 精确匹配 + 归一化后匹配
  const byExact = new Map();
  const byNormalized = new Map(); // normalized → [{name, id, type}, ...]
  for (const f of allFields) {
    const name = f?.field_name ?? f?.name;
    const id = f?.field_id ?? f?.id;
    const type = f?.type ?? f?.ui_type ?? null;
    if (!name || !id) continue;
    byExact.set(String(name), { name: String(name), id: String(id), type });
    const norm = normalizeFieldName(name);
    if (!byNormalized.has(norm)) byNormalized.set(norm, []);
    byNormalized.get(norm).push({ name: String(name), id: String(id), type });
  }

  function pickField(target, kind /* "text" | "user" | "any" */) {
    // 精确命中优先
    if (byExact.has(target)) {
      return byExact.get(target);
    }
    const norm = normalizeFieldName(target);
    const candidates = byNormalized.get(norm) || [];
    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0) {
      throw new BackfillError(
        `Field "${target}" not found on table ${tableId} (also tried normalized match "${norm}"). `
        + `Available fields: ${[...byExact.keys()].join(", ")}`,
      );
    }
    // 多命中 (罕见, 说明表里有重复列): 让人先在飞书 Base 上把重复列改掉
    throw new BackfillError(
      `Field name "${target}" is ambiguous — normalized "${norm}" matches multiple columns: `
      + candidates.map((c) => c.name).join(" / ")
      + `. Rename or delete the duplicate columns in Feishu Base before rerunning.`,
    );
  }

  return {
    interviewerText: pickField(INTERVIEWER_TEXT_FIELD_NAME, "text"),
    interviewerUser: pickField(INTERVIEWER_USER_FIELD_NAME, "user"),
    interviewId: pickField(INTERVIEW_ID_FIELD_NAME, "any"),
  };
}

// ─── 拉取全表相关字段 ────────────────────────────────────────
async function fetchAllRecords(config, tableId, fieldIds /* string[] */) {
  const rows = [];      // [ [f0, f1, f2], ... ] 顺序与 fieldIds 一致
  const recordIds = []; // 与 rows 一一对应
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
    const data = envelope.data || {};

    if (Array.isArray(data.data)) rows.push(...data.data);
    if (Array.isArray(data.record_id_list)) recordIds.push(...data.record_id_list);

    if (data.has_more === false || (Array.isArray(data.data) && data.data.length < limit)) break;
    if (Array.isArray(data.data) && data.data.length === 0) break;
    offset += limit;
  }

  if (rows.length !== recordIds.length) {
    throw new BackfillError(
      `record-list returned mismatched rows (${rows.length}) vs record_ids (${recordIds.length})`,
    );
  }
  return { rows, recordIds };
}

// ─── 单元格 → 面试官姓名 text 提取 ────────────────────────────
// text 列在 record-list --field-id 投影下多数版本直接返回字符串;
// 少数版本会返回 [{type:"text", text:"..."}] 结构 — 一并兼容。
function extractText(cell) {
  if (cell == null) return "";
  if (typeof cell === "string") return cell;
  if (Array.isArray(cell)) {
    return cell.map((seg) => extractText(seg)).join("");
  }
  if (typeof cell === "object") {
    if (typeof cell.text === "string") return cell.text;
    if (typeof cell.value === "string") return cell.value;
    if (typeof cell.name === "string") return cell.name;
    return "";
  }
  return String(cell);
}

// ─── 单元格 → 人员列 open_id 数组 ───────────────────────────
// user 列在 record-list 投影下常见形态: [{id:"ou_xxx", name:"...", en_name:"..."}, ...]
// 也见过 [{open_id:"ou_..."}]  — 一并兼容, 姓名取 name 或 en_name 或 nickname。
function extractUsers(cell) {
  if (cell == null) return [];
  if (!Array.isArray(cell)) return [];
  const out = [];
  for (const u of cell) {
    if (!u || typeof u !== "object") continue;
    const openId = u.id || u.open_id || u.openId || null;
    if (!openId || !String(openId).startsWith("ou_")) continue;
    const name = u.name || u.en_name || u.nickname || null;
    out.push({ openId: String(openId), name: name ? String(name) : null });
  }
  return out;
}

// ─── 姓名拆分 & 归一化 ───────────────────────────────────────
function splitNames(text) {
  if (!text) return [];
  return String(text)
    .split(NAME_SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 用于姓名匹配的归一化: 剥空格, 括号一致化。
// 保留大小写和内容 — 飞书里 "Jax Yu（俞鹏君）" 与 "Jax Yu(俞鹏君)" 视为同一人。
function normalizeName(s) {
  if (!s) return "";
  return String(s)
    .replace(/[\s　]+/g, "")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")");
}

// ─── 从已填充记录里挖 name → open_id ─────────────────────────
// 只取『名字数量与人员数量一致』的行, 顺序对齐;
// 一致时才能安全建立映射, 避免顺序错位污染。
function buildNameMapFromExisting(rows, textIdx, userIdx) {
  const map = new Map(); // normalizedName → openId
  const skipped = [];
  for (const row of rows) {
    const textVal = extractText(row[textIdx]);
    const users = extractUsers(row[userIdx]);
    if (!textVal || users.length === 0) continue;
    const names = splitNames(textVal);
    if (names.length !== users.length) {
      skipped.push({ text: textVal, textNameCount: names.length, userCount: users.length });
      continue;
    }
    for (let i = 0; i < names.length; i++) {
      const key = normalizeName(names[i]);
      if (!key) continue;
      // 冲突时以先看到的为准 (相同姓名映射不同 open_id 时不覆盖 —
      // 罕见, 若发生记入日志。)
      if (map.has(key) && map.get(key) !== users[i].openId) continue;
      map.set(key, users[i].openId);
    }
  }
  return { map, skipped };
}

// ─── 通过 contact +search-user 补齐姓名 ────────────────────
async function searchUserByName(config, name) {
  const args = [
    "contact", "+search-user",
    "--query", name,
    "--as", "user",
    "--format", "json",
  ];
  const result = await runLarkCli(config.larkCli, args, config.timeoutMs);
  const envelope = tryParseJson(result.stdout);
  if (result.code !== 0 || envelope?.ok !== true) {
    return { openId: null, error: envelope?.error?.message || result.stderr?.slice(0, 200) || `search-user failed (code=${result.code})` };
  }
  // 命令返回结构常见:
  //   data: { users: [{ open_id:"ou_...", name:"...", ... }, ...], has_more, page_token }
  // 也可能是 data.items / data.data
  const data = envelope.data || {};
  const users = Array.isArray(data.users) ? data.users
    : Array.isArray(data.items) ? data.items
    : Array.isArray(data.data) ? data.data
    : [];
  if (users.length === 0) return { openId: null, error: "no match" };
  const first = users[0];
  const openId = first.open_id || first.openId || first.id || null;
  if (!openId) return { openId: null, error: "first result has no open_id" };
  return { openId: String(openId), name: first.name || null };
}

// ─── 单条 upsert 回填 ────────────────────────────────────────
async function upsertUserField(config, tableId, recordId, userFieldName, openIds) {
  const payload = { [userFieldName]: openIds.map((id) => ({ id })) };
  const payloadJson = JSON.stringify(payload);
  const args = [
    "base", "+record-upsert",
    "--base-token", config.baseToken,
    "--table-id", tableId,
    "--record-id", recordId,
    "--json", payloadJson,
    "--as", "user",
    "--format", "json",
  ];
  const result = await runLarkCli(config.larkCli, args, config.timeoutMs, payloadJson);
  const envelope = tryParseJson(result.stdout);
  if (result.code === 0 && envelope?.ok === true) {
    return { ok: true };
  }
  return {
    ok: false,
    error: envelope?.error?.message || result.stderr?.slice(0, 200) || `upsert failed (code=${result.code})`,
  };
}

// ─── 并发控制 ────────────────────────────────────────────────
async function runConcurrent(tasks, concurrency) {
  const results = new Array(tasks.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      results[i] = await tasks[i]();
    }
  }
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), tasks.length || 1) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// ─── 主流程 ──────────────────────────────────────────────────
export async function backfill(options) {
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
    scanned: 0,
    needsBackfill: 0,
    backfilled: 0,
    skipped: 0,
    failed: 0,
    namesResolvedFromExisting: 0,
    namesResolvedFromSearch: 0,
    unresolvedNames: [],
    errors: [],
  };

  // ── 步骤 1: field-list ──
  const fields = await resolveFieldIds(config, config.transcriptTableId);
  const textIdx = 0, userIdx = 1, idIdx = 2;
  const fieldIds = [fields.interviewerText.id, fields.interviewerUser.id, fields.interviewId.id];

  // ── 步骤 2: record-list 拉全量, 定位空行 ──
  const { rows, recordIds } = await fetchAllRecords(config, config.transcriptTableId, fieldIds);
  summary.scanned = rows.length;

  const needing = []; // [{ recordId, textVal, names, interviewId }]
  for (let i = 0; i < rows.length; i++) {
    const textVal = extractText(rows[i][textIdx]);
    const users = extractUsers(rows[i][userIdx]);
    const names = splitNames(textVal);
    if (names.length === 0) continue;            // 面试官 text 空: 无从下手, 跳过
    if (users.length > 0) continue;              // 人员列已有值: 尊重现有数据
    needing.push({
      recordId: recordIds[i],
      textVal,
      names,
      interviewId: extractText(rows[i][idIdx]),
    });
  }
  summary.needsBackfill = needing.length;

  if (needing.length === 0) {
    return summary; // nothing to do
  }

  // ── 步骤 3: 建 name → open_id 映射 ──
  const { map: nameMap, skipped: existingSkipped } = buildNameMapFromExisting(rows, textIdx, userIdx);
  const initialMapSize = nameMap.size;

  // 收集缺失姓名 (uniq)
  const missingNames = new Set();
  for (const row of needing) {
    for (const n of row.names) {
      const key = normalizeName(n);
      if (!key) continue;
      if (!nameMap.has(key)) missingNames.add(n); // 用原文姓名做 search-user 查询
    }
  }

  // search-user 逐个补齐 (串行 — contact API 一般不慢, 而且并发太高容易限流)
  for (const rawName of missingNames) {
    const { openId, error } = await searchUserByName(config, rawName);
    if (openId) {
      nameMap.set(normalizeName(rawName), openId);
      summary.namesResolvedFromSearch += 1;
    } else {
      summary.unresolvedNames.push({ name: rawName, reason: error || "no result" });
    }
  }

  summary.namesResolvedFromExisting = initialMapSize;

  // ── 步骤 4: 逐条 upsert ──
  const tasks = needing.map((row) => async () => {
    const openIds = [];
    const unresolved = [];
    for (const n of row.names) {
      const key = normalizeName(n);
      const openId = nameMap.get(key);
      if (openId) openIds.push(openId);
      else unresolved.push(n);
    }
    if (openIds.length === 0) {
      summary.skipped += 1;
      summary.errors.push({
        recordId: row.recordId,
        interviewId: row.interviewId,
        phase: "resolve-names",
        message: `all names unresolved: ${unresolved.join(", ")}`,
      });
      return;
    }
    if (config.dryRun) {
      summary.backfilled += 1;
      return;
    }
    const res = await upsertUserField(
      config, config.transcriptTableId, row.recordId, fields.interviewerUser.name, openIds,
    );
    if (res.ok) {
      summary.backfilled += 1;
      if (unresolved.length > 0) {
        // 部分填充: 有一部分姓名没解析上, 但已尽力
        summary.errors.push({
          recordId: row.recordId,
          interviewId: row.interviewId,
          phase: "partial-fill",
          message: `partial fill; unresolved names: ${unresolved.join(", ")}`,
        });
      }
    } else {
      summary.failed += 1;
      summary.errors.push({
        recordId: row.recordId,
        interviewId: row.interviewId,
        phase: "upsert",
        message: res.error,
      });
    }
  });

  await runConcurrent(tasks, config.concurrency);

  // ── 汇总 ok 判定 ──
  if (summary.failed > 0) summary.ok = false;
  if (existingSkipped.length > 0) {
    summary.errors.push({
      phase: "build-name-map",
      message: `${existingSkipped.length} existing rows skipped due to name/user count mismatch`,
      details: existingSkipped.slice(0, 5),
    });
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
    const summary = await backfill(options);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (!summary.ok) process.exitCode = 1;
  } catch (error) {
    const safe = {
      ok: false,
      error: {
        type: error?.name || "Error",
        message: error?.message || "Unknown backfill error",
        details: error?.details || null,
      },
    };
    process.stderr.write(`${JSON.stringify(safe, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
