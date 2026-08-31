#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const statePath = process.env.MOCK_LARK_STATE;
if (!statePath) throw new Error("MOCK_LARK_STATE is required");

const state = JSON.parse(await fs.readFile(statePath, "utf8"));
state.records ||= [];
state.nextId ||= 1;
state.calls ||= { creates: 0, updates: 0, lists: 0 };

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function jsonFlag(name) {
  const raw = flag(name);
  if (!raw) return null;
  if (raw.startsWith("@")) return JSON.parse(await fs.readFile(path.resolve(raw.slice(1)), "utf8"));
  return JSON.parse(raw);
}

async function save() {
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

function success(data) {
  process.stdout.write(`${JSON.stringify({ ok: true, identity: "user", data })}\n`);
}

function failure(message) {
  process.stderr.write(`${JSON.stringify({ ok: false, identity: "user", error: { message } })}\n`);
  process.exitCode = 1;
}

const command = args[1];
const tableId = flag("--table-id");

if (command === "+record-list") {
  state.calls.lists += 1;
  const filter = await jsonFlag("--filter-json");
  const offset = Number(flag("--offset") || 0);
  const limit = Number(flag("--limit") || 100);
  const conditions = filter?.conditions || [];
  const items = state.records
    .filter((record) => record.tableId === tableId)
    .filter((record) => conditions.every(([field, operator, value]) => operator === "==" && record.fields[field] === value))
    .slice(offset, offset + limit)
    .map((record) => ({ record_id: record.record_id, fields: record.fields }));
  await save();
  success({ items, has_more: false });
} else if (command === "+record-upsert") {
  const recordId = flag("--record-id");
  const fields = await jsonFlag("--json");
  if (recordId) {
    state.calls.updates += 1;
    const record = state.records.find((item) => item.record_id === recordId && item.tableId === tableId);
    if (!record) {
      failure("record not found");
    } else {
      record.fields = { ...record.fields, ...fields };
      await save();
      success({ record: { record_id: recordId, fields: record.fields }, updated: true });
    }
  } else {
    state.calls.creates += 1;
    const id = `rec${String(state.nextId++).padStart(5, "0")}`;
    state.records.push({ record_id: id, tableId, fields });
    const transcriptFailure = tableId === "tblUYL6KszcCEzuw"
      && state.ambiguousTranscriptCreateOnce
      && !state.ambiguousTranscriptCreateUsed;
    const interviewerFailure = tableId === "tblyYe2fDhI0Lluv"
      && state.ambiguousInterviewerCreateOnce
      && !state.ambiguousInterviewerCreateUsed;
    const shouldFailAfterCommit = transcriptFailure || interviewerFailure;
    if (transcriptFailure) state.ambiguousTranscriptCreateUsed = true;
    if (interviewerFailure) state.ambiguousInterviewerCreateUsed = true;
    await save();
    if (shouldFailAfterCommit) failure("simulated connection loss after commit");
    else success({ record: { record_id: id, fields }, created: true });
  }
} else {
  failure(`unsupported mock command: ${command}`);
}
