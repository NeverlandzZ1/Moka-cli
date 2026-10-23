#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CONFIG = path.join(os.homedir(), ".opencli", "moka-config.json");

function optionsFrom(argv) {
  const options = { command: argv[0] };
  for (let i = 1; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || !argv[i + 1]) throw new Error(`invalid argument: ${argv[i]}`);
    options[argv[i].slice(2)] = argv[i + 1];
  }
  return options;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function parseFolderUrl(value, baseUrl) {
  if (typeof value !== "string" || !value.trim()) throw new Error("report_folder_url is missing; configure the report folder first");
  let folder;
  let base;
  try {
    folder = new URL(value);
    base = new URL(baseUrl);
  } catch {
    throw new Error("folder URL or feishu_base_url is invalid");
  }
  const match = folder.pathname.match(/^\/drive\/folder\/([A-Za-z0-9]+)\/?$/);
  if (folder.protocol !== "https:" || folder.origin !== base.origin || !match || folder.username || folder.password) {
    throw new Error("folder URL must be an HTTPS /drive/folder/<token> link in the configured Base tenant");
  }
  return { folderUrl: `${folder.origin}/drive/folder/${match[1]}`, folderToken: match[1] };
}

function folderTarget(options, useProvidedUrl, save) {
  const configPath = path.resolve(options.config || DEFAULT_CONFIG);
  const config = readJson(configPath);
  if (!config.feishu_base_url) throw new Error("feishu_base_url must be configured before the report folder");
  const target = parseFolderUrl(useProvidedUrl ? options.url : config.report_folder_url, config.feishu_base_url);
  if (save) {
    config.report_folder_url = target.folderUrl;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }
  return target;
}

function nameParts(value) {
  const full = String(value || "").replace(/[（]/g, "(").replace(/[）]/g, ")")
    .replace(/[\s　]+/g, "").toLowerCase();
  const match = full.match(/^([^()]+)\(([^()]+)\)$/);
  const chinese = match ? match[2] : /^[\p{Script=Han}]+$/u.test(full) ? full : "";
  const english = match ? match[1] : chinese ? "" : full;
  return { full, chinese, english };
}

function resolveOwner(name, response) {
  if (!name || !String(name).trim()) throw new Error("top-level 面试安排HR is missing");
  if (response?.ok === false) throw new Error("contact search failed");
  const data = response?.data || response;
  if (data?.has_more === true) throw new Error("contact search is incomplete; fetch all pages before resolving owner");
  const users = data?.users;
  if (!Array.isArray(users)) throw new Error("contact search response has no users array");
  const expected = nameParts(name);
  const exactMatches = new Map();
  const aliasMatches = new Map();
  for (const user of users) {
    const actual = nameParts(user?.name);
    const id = user?.open_id || user?.openId || user?.id;
    if (typeof id !== "string" || !/^ou_[A-Za-z0-9_]+$/.test(id)) continue;
    if (actual.full === expected.full) {
      exactMatches.set(id, user);
      continue;
    }
    const chinese = expected.chinese && actual.chinese === expected.chinese
      && (!expected.english || !actual.english || expected.english === actual.english);
    const english = !expected.chinese && expected.english && actual.english === expected.english;
    if (chinese || english) aliasMatches.set(id, user);
  }
  const matches = exactMatches.size ? exactMatches : aliasMatches;
  if (matches.size > 1) throw new Error(`ambiguous scheduling HR: ${name}; verify the employee identity manually`);
  if (matches.size !== 1) throw new Error(`no unique match for scheduling HR: ${name}`);
  return { name: String(name), openId: [...matches.keys()][0] };
}

function main() {
  const options = optionsFrom(process.argv.slice(2));
  let result;
  if (options.command === "set-folder") result = folderTarget(options, true, true);
  else if (options.command === "check-folder") result = folderTarget(options, true, false);
  else if (options.command === "get-folder") result = folderTarget(options, false, false);
  else if (options.command === "resolve-owner") result = resolveOwner(options.name, readJson(options.contacts));
  else throw new Error("usage: report-targets.mjs check-folder|set-folder --url <folder URL> | get-folder | resolve-owner --name <Moka HR> --contacts <search result JSON> (folder commands accept --config <path>)");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  }
}
