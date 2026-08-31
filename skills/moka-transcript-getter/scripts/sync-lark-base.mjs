#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULTS = Object.freeze({
  baseToken: "TeB3bU3ltak2MWsD8I0cdoxPnSf",
  interviewerTableId: "tblyYe2fDhI0Lluv",
  transcriptTableId: "tblUYL6KszcCEzuw",
  timeoutMs: 60_000,
});

class SyncError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SyncError";
    this.details = details;
  }
}

class CliError extends SyncError {
  constructor(label, exitCode, envelope, timedOut = false) {
    super(
      timedOut
        ? `${label} timed out; create was not retried before a read-back check`
        : `${label} failed (exit ${exitCode})`,
      { label, exitCode, envelope, timedOut },
    );
    this.name = "CliError";
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--input") out.input = argv[++i];
    else if (arg === "--state-dir") out.stateDir = argv[++i];
    else if (arg === "--lark-cli") out.larkCli = argv[++i];
    else if (arg === "--base-token") out.baseToken = argv[++i];
    else if (arg === "--interviewer-table-id") out.interviewerTableId = argv[++i];
    else if (arg === "--transcript-table-id") out.transcriptTableId = argv[++i];
    else if (arg === "--timeout-ms") out.timeoutMs = Number(argv[++i]);
    else throw new SyncError(`Unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  return [
    "Usage:",
    "  node sync-lark-base.mjs --input <transcript.json> [--state-dir <dir>]",
    "",
    "The script deduplicates by applicationId + interviewId and writes records serially.",
    "It never retries an ambiguous create before an exact read-back check.",
  ].join("\n");
}

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
    map.set(businessKey(record), record);
  }
  return {
    records: [...map.values()],
    dropped: records.length - map.size,
  };
}

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

function transcriptFields(record, interviewerRecordIds) {
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
    "面试官（关联）": interviewerRecordIds.length
      ? interviewerRecordIds.map((id) => ({ id }))
      : null,
  };
}

function maskName(name) {
  const text = asText(name).trim();
  if (!text) return "未记录";
  return text
    .replace(/[\u3400-\u9fff]+/g, (part) => (part.length === 1 ? "*" : `${part[0]}${"*".repeat(part.length - 1)}`))
    .replace(/[A-Za-z]+/g, (part) => (part.length === 1 ? part : `${part[0]}${"*".repeat(part.length - 1)}`))
    .replace(/\d/g, "*");
}

function nameHash(name) {
  return createHash("sha256").update(name, "utf8").digest("hex").slice(0, 12);
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

function extractListData(envelope) {
  const candidates = [
    envelope?.data,
    envelope?.data?.data,
    envelope,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return { records: candidate, container: envelope?.data ?? envelope };
    if (!candidate || typeof candidate !== "object") continue;
    for (const key of ["items", "records", "rows"]) {
      if (Array.isArray(candidate[key])) return { records: candidate[key], container: candidate };
    }
  }
  return { records: [], container: envelope?.data ?? envelope ?? {} };
}

function extractRecordId(record) {
  const value = record?.record_id ?? record?.recordId ?? record?.id;
  return typeof value === "string" && value ? value : null;
}

function extractCreatedRecordId(envelope) {
  const candidates = [
    envelope?.data?.record,
    envelope?.data,
    envelope?.record,
  ];
  for (const candidate of candidates) {
    const id = extractRecordId(candidate);
    if (id) return id;
  }
  const list = envelope?.data?.record_id_list ?? envelope?.record_id_list;
  return Array.isArray(list) && typeof list[0] === "string" ? list[0] : null;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function acquireLock(lockPath) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const metadata = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  try {
    const handle = await fs.open(lockPath, "wx", 0o600);
    await handle.writeFile(metadata, "utf8");
    await handle.close();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let owner = null;
    try {
      owner = JSON.parse(await fs.readFile(lockPath, "utf8"));
    } catch {
      // An unreadable lock is treated as active rather than removed blindly.
    }
    if (owner && !isProcessAlive(Number(owner.pid))) {
      await fs.unlink(lockPath);
      return acquireLock(lockPath);
    }
    throw new SyncError("Another Moka-to-Lark sync is already running", { lockPath, owner });
  }
  return async () => {
    try {
      const owner = JSON.parse(await fs.readFile(lockPath, "utf8"));
      if (Number(owner.pid) === process.pid) await fs.unlink(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    if (process.platform !== "win32" || !["EEXIST", "EPERM"].includes(error?.code)) throw error;
    await fs.unlink(filePath).catch((unlinkError) => {
      if (unlinkError?.code !== "ENOENT") throw unlinkError;
    });
    await fs.rename(tempPath, filePath);
  }
}

async function loadCheckpoint(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { version: 1, entries: {} };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, entries: {} };
    throw new SyncError("Unable to read the Lark sync checkpoint", { cause: error?.message });
  }
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (!/[\s"&|<>^()%!]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function resolveCommand(options) {
  if (process.env.MOKA_LARK_CLI_COMMAND_JSON) {
    const parts = JSON.parse(process.env.MOKA_LARK_CLI_COMMAND_JSON);
    if (!Array.isArray(parts) || !parts.length || parts.some((p) => typeof p !== "string")) {
      throw new SyncError("MOKA_LARK_CLI_COMMAND_JSON must be a non-empty JSON string array");
    }
    return { command: parts[0], prefixArgs: parts.slice(1), windowsWrapper: false };
  }
  const command = options.larkCli || process.env.LARK_CLI || "lark-cli";
  return {
    command,
    prefixArgs: [],
    windowsWrapper: process.platform === "win32" && !/\.exe$/i.test(command),
  };
}

async function runProcess(commandSpec, args, options) {
  const fullArgs = [...commandSpec.prefixArgs, ...args];
  let command = commandSpec.command;
  let spawnArgs = fullArgs;
  if (commandSpec.windowsWrapper) {
    const commandLine = [command, ...fullArgs].map(quoteWindowsArg).join(" ");
    command = process.env.ComSpec || "cmd.exe";
    spawnArgs = ["/d", "/s", "/c", commandLine];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, spawnArgs, {
      cwd: options.cwd,
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new SyncError("Unable to start lark-cli", { cause: error.message }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

class LarkClient {
  constructor(options) {
    this.baseToken = options.baseToken;
    this.interviewerTableId = options.interviewerTableId;
    this.transcriptTableId = options.transcriptTableId;
    this.timeoutMs = options.timeoutMs;
    this.cwd = options.cwd;
    this.commandSpec = resolveCommand(options);
    this.payloadCounter = 0;
  }

  async payloadFile(prefix, value) {
    const filename = `${String(++this.payloadCounter).padStart(4, "0")}-${prefix}.json`;
    await fs.writeFile(path.join(this.cwd, filename), JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
    return filename;
  }

  async invoke(args, label) {
    const result = await runProcess(this.commandSpec, args, { cwd: this.cwd, timeoutMs: this.timeoutMs });
    const envelope = tryParseJson(result.stdout) || tryParseJson(result.stderr);
    if (result.timedOut || result.code !== 0 || envelope?.ok !== true) {
      throw new CliError(label, result.code, envelope, result.timedOut);
    }
    return envelope;
  }

  async listExact(tableId, filter, fieldNames, label) {
    const records = [];
    for (let offset = 0; ; offset += 200) {
      const filterFile = await this.payloadFile("filter", filter);
      const args = [
        "base", "+record-list",
        "--base-token", this.baseToken,
        "--table-id", tableId,
        "--filter-json", `@${filterFile}`,
      ];
      for (const field of fieldNames) args.push("--field-id", field);
      args.push("--offset", String(offset), "--limit", "200", "--as", "user", "--format", "json");
      const envelope = await this.invoke(args, label);
      const page = extractListData(envelope);
      records.push(...page.records);
      const hasMore = page.container?.has_more ?? page.container?.hasMore ?? envelope?.meta?.has_more;
      if (hasMore === false || page.records.length < 200) break;
      if (page.records.length === 0) break;
    }
    return records;
  }

  findTranscript(applicationId, interviewId) {
    return this.listExact(
      this.transcriptTableId,
      { logic: "and", conditions: [["申请ID", "==", applicationId], ["面试ID", "==", interviewId]] },
      ["申请ID", "面试ID"],
      "query transcript by business key",
    );
  }

  findInterviewer(name) {
    return this.listExact(
      this.interviewerTableId,
      { logic: "and", conditions: [["姓名", "==", name]] },
      ["姓名"],
      "query interviewer by exact name",
    );
  }

  async upsert(tableId, fields, recordId, label) {
    const payloadFile = await this.payloadFile("record", fields);
    const args = [
      "base", "+record-upsert",
      "--base-token", this.baseToken,
      "--table-id", tableId,
    ];
    if (recordId) args.push("--record-id", recordId);
    args.push("--json", `@${payloadFile}`, "--as", "user", "--format", "json");
    return this.invoke(args, label);
  }
}

function sortedRecordIds(records) {
  const ids = [...new Set(records.map(extractRecordId).filter(Boolean))].sort();
  if (records.length && !ids.length) throw new SyncError("lark-cli returned records without record_id");
  return ids;
}

async function readBack(find, attempts = 4) {
  let records = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    records = await find();
    if (records.length) return records;
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
  }
  return records;
}

async function resolveInterviewer(client, name, summary) {
  let matches = await client.findInterviewer(name);
  let ids = sortedRecordIds(matches);
  if (ids.length) {
    if (ids.length > 1) summary.interviewerDuplicateConflicts.push({ nameHash: nameHash(name), recordIds: ids });
    return ids[0];
  }

  let envelope = null;
  let ambiguousError = null;
  try {
    envelope = await client.upsert(client.interviewerTableId, { "姓名": name }, null, "create interviewer");
  } catch (error) {
    ambiguousError = error;
  }

  matches = await readBack(() => client.findInterviewer(name));
  ids = sortedRecordIds(matches);
  const returnedId = envelope ? extractCreatedRecordId(envelope) : null;
  if (!ids.length && returnedId) ids = [returnedId];
  if (!ids.length) throw ambiguousError || new SyncError("Interviewer create could not be verified");
  if (ids.length > 1) summary.interviewerDuplicateConflicts.push({ nameHash: nameHash(name), recordIds: ids });
  if (ambiguousError) summary.recoveredInterviewerCreates += 1;
  else summary.createdInterviewers += 1;
  return ids[0];
}

async function syncTranscript(client, record, summary, checkpoint, checkpointPath) {
  const key = businessKey(record);
  checkpoint.entries[key] = { status: "checking", updatedAt: new Date().toISOString() };
  await writeJsonAtomic(checkpointPath, checkpoint);

  const interviewerRecordIds = [];
  for (const name of record.interviewerNames) {
    interviewerRecordIds.push(await resolveInterviewer(client, name, summary));
  }
  const fields = transcriptFields(record, interviewerRecordIds);

  let matches = await client.findTranscript(record.applicationId, record.interviewId);
  let ids = sortedRecordIds(matches);
  let operation = "updated";
  let recordId = ids[0] || null;

  if (ids.length > 1) {
    summary.duplicateConflicts.push({ applicationId: record.applicationId, interviewId: record.interviewId, recordIds: ids });
  }

  if (recordId) {
    await client.upsert(client.transcriptTableId, fields, recordId, "update transcript");
    summary.updated += 1;
  } else {
    checkpoint.entries[key] = { status: "creating", updatedAt: new Date().toISOString() };
    await writeJsonAtomic(checkpointPath, checkpoint);

    let envelope = null;
    let ambiguousError = null;
    try {
      envelope = await client.upsert(client.transcriptTableId, fields, null, "create transcript");
    } catch (error) {
      ambiguousError = error;
    }

    // A failed or timed-out create is never replayed. Read back the business key first.
    matches = await readBack(() => client.findTranscript(record.applicationId, record.interviewId));
    ids = sortedRecordIds(matches);
    const returnedId = envelope ? extractCreatedRecordId(envelope) : null;
    if (!ids.length && returnedId) ids = [returnedId];
    if (!ids.length) throw ambiguousError || new SyncError("Transcript create could not be verified", { key });
    recordId = ids[0];
    if (ids.length > 1) {
      summary.duplicateConflicts.push({ applicationId: record.applicationId, interviewId: record.interviewId, recordIds: ids });
    }
    if (ambiguousError) {
      operation = "recoveredCreate";
      summary.recoveredCreates += 1;
    } else {
      operation = "created";
      summary.created += 1;
    }
  }

  checkpoint.entries[key] = { status: "complete", recordId, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(checkpointPath, checkpoint);
  summary.records.push({
    applicationId: record.applicationId,
    interviewId: record.interviewId,
    candidateName: maskName(record.candidateName),
    interviewerNames: record.interviewerNames.map(maskName),
    jobTitle: asText(record.jobTitle),
    operation,
    recordId,
  });
}

async function cleanupOldTempDirs(stateDir) {
  const entries = await fs.readdir(stateDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(".moka-lark-sync-")) {
      await fs.rm(path.join(stateDir, entry.name), { recursive: true, force: true });
    }
  }
}

export async function sync(options) {
  if (!options.input) throw new SyncError("--input is required");
  const inputPath = path.resolve(options.input);
  const stateDir = path.resolve(options.stateDir || path.dirname(inputPath));
  await fs.mkdir(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, "lark-sync.lock");
  const checkpointPath = path.join(stateDir, "lark-sync-state.json");
  const releaseLock = await acquireLock(lockPath);
  let tempDir = null;
  try {
    await cleanupOldTempDirs(stateDir);
    tempDir = await fs.mkdtemp(path.join(stateDir, ".moka-lark-sync-"));
    const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
    const deduped = deduplicateRecords(input.records);
    const checkpoint = await loadCheckpoint(checkpointPath);
    checkpoint.version = 1;
    checkpoint.lastRunStartedAt = new Date().toISOString();
    checkpoint.entries ||= {};
    await writeJsonAtomic(checkpointPath, checkpoint);

    const client = new LarkClient({
      ...DEFAULTS,
      ...options,
      cwd: tempDir,
    });
    const summary = {
      ok: true,
      inputRecords: input.records.length,
      deduplicatedRecords: deduped.records.length,
      inputDuplicatesDropped: deduped.dropped,
      created: 0,
      recoveredCreates: 0,
      updated: 0,
      createdInterviewers: 0,
      recoveredInterviewerCreates: 0,
      duplicateConflicts: [],
      interviewerDuplicateConflicts: [],
      records: [],
      checkpointPath,
    };

    for (const record of deduped.records) {
      await syncTranscript(client, record, summary, checkpoint, checkpointPath);
    }
    checkpoint.lastRunCompletedAt = new Date().toISOString();
    await writeJsonAtomic(checkpointPath, checkpoint);
    return summary;
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    await releaseLock();
  }
}

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

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
