import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "skills", "moka-transcriptV2", "scripts", "backfill-interviewer-user.mjs");
const mockCliPath = path.join(repoRoot, "tests", "fixtures", "mock-lark-cli.mjs");
const tempDirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("person-field backfill", () => {
  it("uses row text for interviewers and top-level JSON only for current scheduling-HR records", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "moka-user-backfill-test-"));
    tempDirs.push(dir);
    const inputPath = path.join(dir, "transcripts.json");
    const statePath = path.join(dir, "state.json");
    const wrapperPath = path.join(dir, "mock-lark-cli.cmd");

    await writeFile(inputPath, JSON.stringify({
      "面试安排HR": "Joan Qian （钱明燕）",
      records: [
        { applicationId: 101, interviewId: 201 },
        { applicationId: 102, interviewId: 202 },
      ],
    }), "utf8");
    await writeFile(statePath, JSON.stringify({
      contactUsers: {
        "钱明燕": { open_id: "ou_hr", name: "钱明燕" },
        "王面试": { open_id: "ou_interviewer", name: "王面试" },
      },
      records: [
        {
          record_id: "rec_current",
          tableId: "tbl_transcripts",
          fields: {
            "面试官": "Iris Wang （王面试）",
            "面试官 (人员 )": [],
            "面试安排HR(人员)": [],
            "申请ID": 101,
            "面试ID": 201,
          },
        },
        {
          record_id: "rec_already_filled",
          tableId: "tbl_transcripts",
          fields: {
            "面试官": "",
            "面试官 (人员 )": [],
            "面试安排HR(人员)": [{ id: "ou_existing_hr" }],
            "申请ID": 102,
            "面试ID": 202,
          },
        },
        {
          record_id: "rec_history",
          tableId: "tbl_transcripts",
          fields: {
            "面试官": "",
            "面试官 (人员 )": [],
            "面试安排HR(人员)": [],
            "申请ID": 999,
            "面试ID": 999,
          },
        },
      ],
    }), "utf8");
    await writeFile(
      wrapperPath,
      `@echo off\r\n"${process.execPath}" "${mockCliPath}" %*\r\n`,
      "utf8",
    );

    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath,
      "--input", inputPath,
      "--base-token", "app_token",
      "--transcript-table-id", "tbl_transcripts",
      "--lark-cli", wrapperPath,
    ], {
      cwd: repoRoot,
      env: { ...process.env, MOCK_LARK_STATE: statePath },
      maxBuffer: 10 * 1024 * 1024,
    });

    const summary = JSON.parse(stdout);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const current = state.records.find((record: { record_id: string }) => record.record_id === "rec_current");
    const alreadyFilled = state.records.find((record: { record_id: string }) => record.record_id === "rec_already_filled");
    const history = state.records.find((record: { record_id: string }) => record.record_id === "rec_history");

    expect(summary.ok).toBe(true);
    expect(summary.backfilled).toBe(1);
    expect(summary.schedulingHr.backfilled).toBe(1);
    expect(summary.schedulingHr.alreadyFilled).toBe(1);
    expect(current.fields["面试官 (人员 )"]).toEqual([{ id: "ou_interviewer" }]);
    expect(current.fields["面试安排HR(人员)"]).toEqual([{ id: "ou_hr" }]);
    expect(history.fields["面试安排HR(人员)"]).toEqual([]);
    expect(alreadyFilled.fields["面试安排HR(人员)"]).toEqual([{ id: "ou_existing_hr" }]);
    expect(current.fields).not.toHaveProperty("面试安排HR");
  });
});
