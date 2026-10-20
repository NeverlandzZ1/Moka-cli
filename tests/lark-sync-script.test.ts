import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "skills", "moka-transcriptV2", "scripts", "sync-lark-base.mjs");
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
  const wrapperPath = path.join(dir, "mock-lark-cli.cmd");
  await writeFile(statePath, JSON.stringify({ records: [], nextId: 1, ...initialState }), "utf8");
  await writeFile(wrapperPath, `@echo off\r\n"${process.execPath}" "${mockCliPath}" %*\r\n`, "utf8");
  return { dir, inputPath, statePath, wrapperPath };
}

async function runScript(inputPath: string, statePath: string, wrapperPath: string, records: unknown[]) {
  await writeFile(inputPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    "面试安排HR": "HR User",
    records,
  }), "utf8");
  const result = await execFileAsync(process.execPath, [
    scriptPath,
    "--input", inputPath,
    "--base-token", "app_token",
    "--transcript-table-id", "tbl_transcripts",
    "--lark-cli", wrapperPath,
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MOCK_LARK_STATE: statePath,
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
  it("deduplicates repeated input keys before one batch create", async () => {
    const ctx = await setup();
    const summary = await runScript(ctx.inputPath, ctx.statePath, ctx.wrapperPath, [
      record(), record({ candidateName: "更新后的示例名" }),
    ]);
    const state = await mockState(ctx.statePath);

    expect(summary.ok).toBe(true);
    expect(summary.inputRecords).toBe(2);
    expect(summary.deduplicatedRecords).toBe(1);
    expect(summary.inputDuplicatesDropped).toBe(1);
    expect(summary.created).toBe(1);
    expect(summary.failed).toBe(0);
    expect(state.calls.batchCreates).toBe(1);
    expect(state.calls.creates).toBe(0);
    expect(state.calls.lists).toBe(0);
    expect(state.records).toHaveLength(1);
    expect(state.records[0].fields["候选人姓名"]).toBe("更新后的示例名");
  });

  it("creates every distinct interview and leaves existing Base records for the dedup script", async () => {
    const ctx = await setup();
    const summary = await runScript(ctx.inputPath, ctx.statePath, ctx.wrapperPath, [
      record(), record({ interviewId: 48113317, candidateName: "另一位候选人" }),
    ]);
    const state = await mockState(ctx.statePath);

    expect(summary.ok).toBe(true);
    expect(summary.created).toBe(2);
    expect(state.calls.batchCreates).toBe(1);
    expect(state.calls.lists).toBe(0);
    expect(state.records).toHaveLength(2);
    expect(state.records.map((item: { fields: Record<string, unknown> }) => item.fields["面试ID"])).toEqual([48113316, 48113317]);
  });

  it("falls back to single creates when batch create fails", async () => {
    const ctx = await setup({ failBatchOnce: true });
    const summary = await runScript(ctx.inputPath, ctx.statePath, ctx.wrapperPath, [
      record(), record({ interviewId: 48113317 }),
    ]);
    const state = await mockState(ctx.statePath);

    expect(summary.ok).toBe(true);
    expect(summary.batchCreateFallback).toBe(true);
    expect(summary.created).toBe(2);
    expect(summary.failed).toBe(0);
    expect(state.calls.batchCreates).toBe(1);
    expect(state.calls.creates).toBe(2);
    expect(state.records).toHaveLength(2);
  });

  it("reports a partial fallback failure instead of claiming success", async () => {
    const ctx = await setup({ failBatchOnce: true, failCreateForInterviewId: 48113317 });
    const summary = await runScript(ctx.inputPath, ctx.statePath, ctx.wrapperPath, [
      record(), record({ interviewId: 48113317 }),
    ]);
    const state = await mockState(ctx.statePath);

    expect(summary.ok).toBe(false);
    expect(summary.created).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.errors.some((item: { phase: string }) => item.phase === "upsert-fallback")).toBe(true);
    expect(state.records).toHaveLength(1);
  });

  it("returns a successful no-op for an empty input", async () => {
    const ctx = await setup();
    const summary = await runScript(ctx.inputPath, ctx.statePath, ctx.wrapperPath, []);
    const state = await mockState(ctx.statePath);

    expect(summary.created).toBe(0);
    expect(summary.ok).toBe(true);
    expect(summary.deduplicatedRecords).toBe(0);
    expect(state.calls?.batchCreates || 0).toBe(0);
    expect(state.calls?.creates || 0).toBe(0);
    expect(state.records).toHaveLength(0);
  });
});
