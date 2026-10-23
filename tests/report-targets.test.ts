import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(import.meta.dirname, "..", "skills", "moka-transcriptv2", "scripts", "report-targets.mjs");
const tempDirs: string[] = [];

async function tempFile(name: string, contents: unknown) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "moka-report-targets-"));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  await writeFile(file, JSON.stringify(contents), "utf8");
  return file;
}

async function run(...args: string[]) {
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, ...args]);
  return JSON.parse(stdout);
}

async function runFailure(...args: string[]) {
  try {
    await run(...args);
    throw new Error("expected command to fail");
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    if (!stderr) throw error;
    return JSON.parse(stderr).error as string;
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("report Drive folder configuration", () => {
  it("saves the supplied folder URL without discarding the existing Base configuration", async () => {
    const config = await tempFile("moka-config.json", {
      feishu_base_url: "https://trip.larkenterprise.com/base/base123?table=tbl123",
      existingSetting: "keep me",
    });
    const saved = await run("set-folder", "--config", config, "--url", "https://trip.larkenterprise.com/drive/folder/NEWfolder123?from=share");
    const loaded = await run("get-folder", "--config", config);

    expect(saved).toEqual({ folderUrl: "https://trip.larkenterprise.com/drive/folder/NEWfolder123", folderToken: "NEWfolder123" });
    expect(loaded).toEqual(saved);
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual({
      feishu_base_url: "https://trip.larkenterprise.com/base/base123?table=tbl123",
      existingSetting: "keep me",
      report_folder_url: "https://trip.larkenterprise.com/drive/folder/NEWfolder123",
    });
  });

  it("checks a proposed folder without saving it before remote permission verification", async () => {
    const original = { feishu_base_url: "https://trip.larkenterprise.com/base/base123?table=tbl123" };
    const config = await tempFile("moka-config.json", original);

    expect(await run("check-folder", "--config", config, "--url", "https://trip.larkenterprise.com/drive/folder/checked123"))
      .toEqual({ folderUrl: "https://trip.larkenterprise.com/drive/folder/checked123", folderToken: "checked123" });
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual(original);
  });

  it.each([
    "https://other.example.com/drive/folder/abc123",
    "https://trip.larkenterprise.com/file/abc123",
    "http://trip.larkenterprise.com/drive/folder/abc123",
  ])("rejects an invalid or cross-tenant report folder without changing config: %s", async (url) => {
    const original = { feishu_base_url: "https://trip.larkenterprise.com/base/base123?table=tbl123" };
    const config = await tempFile("moka-config.json", original);

    expect(await runFailure("set-folder", "--config", config, "--url", url)).toMatch(/folder URL/);
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual(original);
  });

  it("does not silently fall back to a former folder when the configured URL is missing", async () => {
    const config = await tempFile("moka-config.json", { feishu_base_url: "https://trip.larkenterprise.com/base/base123?table=tbl123" });
    expect(await runFailure("get-folder", "--config", config)).toMatch(/report_folder_url/);
  });
});

describe("report owner resolution", () => {
  it("selects the Moka scheduling HR rather than a different first search hit", async () => {
    const contacts = await tempFile("contacts.json", {
      ok: true,
      data: {
        users: [
          { open_id: "ou_other", name: "Joan Chen (陈乔安)" },
          { open_id: "ou_hr", name: "Joan Qian (钱明燕)" },
        ],
        has_more: false,
      },
    });
    expect(await run("resolve-owner", "--name", "Joan Qian （钱明燕）", "--contacts", contacts))
      .toEqual({ name: "Joan Qian （钱明燕）", openId: "ou_hr" });
  });

  it("prefers an exact bilingual identity over a different Chinese-only name match", async () => {
    const contacts = await tempFile("contacts.json", {
      users: [
        { open_id: "ou_unrelated", name: "钱明燕" },
        { open_id: "ou_hr", name: "Joan Qian (钱明燕)" },
      ],
      has_more: false,
    });
    expect(await run("resolve-owner", "--name", "Joan Qian （钱明燕）", "--contacts", contacts))
      .toEqual({ name: "Joan Qian （钱明燕）", openId: "ou_hr" });
  });

  it("does not guess between employees who share the scheduling HR's Chinese name", async () => {
    const contacts = await tempFile("contacts.json", {
      users: [
        { open_id: "ou_one", name: "Joan Qian (钱明燕)" },
        { open_id: "ou_two", name: "Jane Chen (钱明燕)" },
      ],
      has_more: false,
    });
    expect(await runFailure("resolve-owner", "--name", "钱明燕", "--contacts", contacts)).toMatch(/ambiguous/);
  });

  it("refuses partial search results and unmatched names", async () => {
    const partial = await tempFile("partial.json", { users: [{ open_id: "ou_hr", name: "钱明燕" }], has_more: true });
    const noMatch = await tempFile("no-match.json", { users: [{ open_id: "ou_other", name: "王文佳" }], has_more: false });
    expect(await runFailure("resolve-owner", "--name", "钱明燕", "--contacts", partial)).toMatch(/incomplete/);
    expect(await runFailure("resolve-owner", "--name", "钱明燕", "--contacts", noMatch)).toMatch(/no unique match/);
  });
});
