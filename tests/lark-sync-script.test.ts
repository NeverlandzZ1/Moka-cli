import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "skills", "moka-transcript-getter", "scripts", "sync-lark-base.mjs");
const mockCliPath = path.join(repoRoot, "tests", "fixtures", "mock-lark-cli.mjs");
const tempDirs: string[] = [];

function record(overrides: Record<string, unknown> = {}) {
  return {
    applicationId: 825605224,
    interviewId: 48113316,
    candidateName: "示例候选人",
    jobTitle: "示例岗位",
    jobId: "job-example",
    interviewerNames: [],
    round: 1,
    roundName: "第一轮面试",
    startTime: 1787711400000,
    transcriptStatus: "available",
    transcript: "example transcript",
    transcriptType: 1,
    evaluationSummary: "example summary",
    questionAnalysis: { status: "success", result: [] },
    mokaCode: "",
    mokaMessage: "成功",
    ...overrides,
  };
}

async function setup(initialState: Record<string, unknown> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "moka-lark-sync-test-"));
  tempDirs.push(dir);
  const inputPath = path.join(dir, "transcript.json");
  const statePath = path.join(dir, "mock-state.json");
  await writeFile(statePath, JSON.stringify({ records: [], nextId: 1, ...initialState }), "utf8");
  return { dir, inputPath, statePath };
}

async function runScript(inputPath: string, statePath: string, records: unknown[]) {
  await writeFile(inputPath, JSON.stringify({ generatedAt: new Date().toISOString(), records }), "utf8");
  const result = await execFileAsync(process.execPath, [scriptPath, "--input", inputPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MOCK_LARK_STATE: statePath,
      MOKA_LARK_CLI_COMMAND_JSON: JSON.stringify([process.execPath, mockCliPath]),
    },
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

async function mockState(statePath: string) {
  return JSON.parse(await readFile(statePath, "utf8"));
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("sync-lark-base script", () => {
  it("deduplicates repeated input keys before creating", async () => {
    const ctx = await setup();
    const summary = await runScript(ctx.inputPath, ctx.statePath, [record(), record({ candidateName: "更新后的示例名" })]);
    const state = await mockState(ctx.statePath);

    expect(summary.ok).toBe(true);
    expect(summary.inputRecords).toBe(2);
    expect(summary.deduplicatedRecords).toBe(1);
    expect(summary.inputDuplicatesDropped).toBe(1);
    expect(summary.created).toBe(1);
    expect(state.calls.creates).toBe(1);
    expect(state.records).toHaveLength(1);
  });

  it("updates an existing business key on a later run without creating again", async () => {
    const ctx = await setup();
    await runScript(ctx.inputPath, ctx.statePath, [record()]);
    const second = await runScript(ctx.inputPath, ctx.statePath, [record({ transcript: "new transcript" })]);
    const state = await mockState(ctx.statePath);

    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(state.calls.creates).toBe(1);
    expect(state.calls.updates).toBe(1);
    expect(state.records).toHaveLength(1);
  });

  it("recovers a committed create after an ambiguous CLI failure without replaying it", async () => {
    const ctx = await setup({ ambiguousTranscriptCreateOnce: true });
    const summary = await runScript(ctx.inputPath, ctx.statePath, [record()]);
    const state = await mockState(ctx.statePath);

    expect(summary.created).toBe(0);
    expect(summary.recoveredCreates).toBe(1);
    expect(state.calls.creates).toBe(1);
    expect(state.records).toHaveLength(1);
  });

  it("recovers an ambiguous interviewer create and writes the link in the transcript upsert", async () => {
    const ctx = await setup({ ambiguousInterviewerCreateOnce: true });
    const summary = await runScript(ctx.inputPath, ctx.statePath, [record({ interviewerNames: ["示例面试官"] })]);
    const state = await mockState(ctx.statePath);
    const interviewers = state.records.filter((item: { tableId: string }) => item.tableId === "tblyYe2fDhI0Lluv");
    const transcripts = state.records.filter((item: { tableId: string }) => item.tableId === "tblUYL6KszcCEzuw");

    expect(summary.recoveredInterviewerCreates).toBe(1);
    expect(interviewers).toHaveLength(1);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]!.fields["面试官（关联）"]).toEqual([{ id: interviewers[0]!.record_id }]);
  });

  it("reports existing duplicate conflicts and updates only one canonical record", async () => {
    const fields = { "申请ID": 825605224, "面试ID": 48113316 };
    const ctx = await setup({
      nextId: 3,
      records: [
        { record_id: "rec00002", tableId: "tblUYL6KszcCEzuw", fields },
        { record_id: "rec00001", tableId: "tblUYL6KszcCEzuw", fields },
      ],
    });
    const summary = await runScript(ctx.inputPath, ctx.statePath, [record()]);
    const state = await mockState(ctx.statePath);

    expect(summary.created).toBe(0);
    expect(summary.updated).toBe(1);
    expect(summary.duplicateConflicts).toEqual([{
      applicationId: 825605224,
      interviewId: 48113316,
      recordIds: ["rec00001", "rec00002"],
    }]);
    expect(state.calls.creates).toBe(0);
    expect(state.calls.updates).toBe(1);
    expect(state.records).toHaveLength(2);
  });
});
