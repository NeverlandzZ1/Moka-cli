// src/plugin.ts
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError } from "@jackwener/opencli/errors";

// src/constants.ts
var MOKA_ORIGIN = "https://app.mokahr.com";
var MOKA_OVERVIEW_URL = `${MOKA_ORIGIN}/interviews/overview`;
var API_PATHS = {
  updateCurrentHireMode: "/api/users/update_currenthiremode_fields",
  interviewList: "/api/outer/ats-interview/interview/hr/interviewList",
  interviewCard: "/api/outer/ats-interview/interview/interviewCard",
  meetingSummary: "/api/outer/ats-interview/interview/meeting/getMeetingSummary"
};
var DEFAULT_CDP_PORT = 9222;

// src/chrome.ts
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { launchDetachedApp, probeCDP } from "@jackwener/opencli/launcher";
import { CDPBridge } from "@jackwener/opencli/browser/cdp";
import { ConfigError } from "@jackwener/opencli/errors";
function selectReusableMokaTarget(targets) {
  return targets.filter((target) => target.type === "page" && target.url?.startsWith(MOKA_ORIGIN) && !target.url.includes("/api/") && target.webSocketDebuggerUrl).sort((left, right) => {
    const score = (target) => {
      if (target.url?.startsWith(MOKA_OVERVIEW_URL)) return 3;
      if (target.url?.includes("/login")) return 2;
      return 1;
    };
    return score(right) - score(left);
  })[0];
}
async function bringTargetToFront(target) {
  if (!target.webSocketDebuggerUrl) return;
  const bridge = new CDPBridge();
  try {
    await bridge.connect({ cdpEndpoint: target.webSocketDebuggerUrl, timeout: 5 });
    await bridge.send("Page.bringToFront");
  } finally {
    await bridge.close().catch(() => void 0);
  }
}
async function readCdpTargets(endpoint) {
  const response = await fetch(`${endpoint}/json`, {
    signal: AbortSignal.timeout(3e3)
  });
  if (!response.ok) return [];
  const targets = await response.json();
  return Array.isArray(targets) ? targets : [];
}
async function reloadMokaOnceAfterLaunch(endpoint) {
  const deadline = Date.now() + 1e4;
  while (Date.now() < deadline) {
    const initial = selectReusableMokaTarget(await readCdpTargets(endpoint).catch(() => []));
    if (!initial) {
      await new Promise((resolve2) => setTimeout(resolve2, 300));
      continue;
    }
    await new Promise((resolve2) => setTimeout(resolve2, 1500));
    const target = selectReusableMokaTarget(await readCdpTargets(endpoint).catch(() => []));
    if (!target?.webSocketDebuggerUrl) continue;
    const bridge = new CDPBridge();
    try {
      await bridge.connect({ cdpEndpoint: target.webSocketDebuggerUrl, timeout: 5 });
      await bridge.send("Page.reload", { ignoreCache: false });
      await bridge.send("Page.bringToFront");
      return true;
    } catch {
    } finally {
      await bridge.close().catch(() => void 0);
    }
  }
  return false;
}
async function openOrReuseCdpTab(endpoint, url) {
  const existing = selectReusableMokaTarget(await readCdpTargets(endpoint));
  if (existing) {
    await bringTargetToFront(existing);
    return true;
  }
  const response = await fetch(`${endpoint}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
    signal: AbortSignal.timeout(3e3)
  });
  if (!response.ok) throw new Error(`CDP new tab failed: HTTP ${response.status}`);
  const created = await response.json();
  await bringTargetToFront(created);
  return false;
}
function defaultProfileDir() {
  const base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(base, "MokaTranscriptGetter", "ChromeProfile");
}
function findChromeExecutable(explicitPath) {
  if (explicitPath) {
    if (existsSync(explicitPath)) return explicitPath;
    throw new ConfigError(`\u627E\u4E0D\u5230\u6307\u5B9A\u7684 Chrome\uFF1A${explicitPath}`);
  }
  const candidates = process.platform === "win32" ? [
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
  ] : process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const found = candidates.find((candidate) => Boolean(candidate && existsSync(candidate)));
  if (found) return found;
  throw new ConfigError(
    "\u6CA1\u6709\u627E\u5230 Google Chrome",
    "\u8BF7\u5B89\u88C5 Chrome\uFF0C\u6216\u4F7F\u7528 --chrome-path \u6307\u5B9A chrome.exe \u7684\u5B8C\u6574\u8DEF\u5F84\u3002"
  );
}
async function ensureChromeWithCdp(options) {
  const endpoint = `http://127.0.0.1:${options.port}`;
  const profileDir = options.profileDir || defaultProfileDir();
  if (await probeCDP(options.port, 2e3)) {
    const reusedMokaTab = await openOrReuseCdpTab(endpoint, options.url);
    return {
      endpoint,
      launched: false,
      profileDir,
      reusedMokaTab,
      refreshedAfterLaunch: false
    };
  }
  const executable = findChromeExecutable(options.chromePath);
  mkdirSync(profileDir, { recursive: true });
  await launchDetachedApp(executable, [
    `--remote-debugging-port=${options.port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    options.url
  ], "Google Chrome");
  const deadline = Date.now() + 15e3;
  while (Date.now() < deadline) {
    if (await probeCDP(options.port, 800)) {
      const refreshedAfterLaunch = await reloadMokaOnceAfterLaunch(endpoint);
      return {
        endpoint,
        launched: true,
        profileDir,
        reusedMokaTab: false,
        refreshedAfterLaunch
      };
    }
    await new Promise((resolve2) => setTimeout(resolve2, 300));
  }
  throw new ConfigError(
    `Chrome \u5DF2\u542F\u52A8\uFF0C\u4F46 CDP \u7AEF\u53E3 ${options.port} \u672A\u5C31\u7EEA`,
    "\u8BF7\u5173\u95ED\u521A\u6253\u5F00\u7684 Chrome \u540E\u91CD\u8BD5\uFF0C\u6216\u901A\u8FC7 --port \u4F7F\u7528\u53E6\u4E00\u4E2A\u7AEF\u53E3\u3002"
  );
}

// src/cdp.ts
import { CDPBridge as CDPBridge2 } from "@jackwener/opencli/browser/cdp";
import { BrowserConnectError, TimeoutError } from "@jackwener/opencli/errors";

// src/utils.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}
function asOptionalNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return void 0;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function parseJsonObject(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} \u4E0D\u662F\u6709\u6548\u7684 JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${label} \u5FC5\u987B\u662F JSON \u5BF9\u8C61`);
  return parsed;
}
function parsePossiblyEncodedJson(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

// src/payload-store.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync, writeFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname, join as join2 } from "node:path";
function defaultPayloadPath() {
  return join2(homedir2(), ".opencli", "mokaData", "moka-interview-list-payload.json");
}
function ensureParentDir(filePath) {
  const parent = dirname(filePath);
  if (!existsSync2(parent)) mkdirSync2(parent, { recursive: true });
}
function readPayloadBundle(path = defaultPayloadPath()) {
  if (!existsSync2(path)) return void 0;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.body)) return void 0;
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : (/* @__PURE__ */ new Date(0)).toISOString();
    return { updatedAt, body: parsed.body };
  } catch {
    return void 0;
  }
}
function writePayloadBundle(body, path = defaultPayloadPath()) {
  ensureParentDir(path);
  const bundle = { updatedAt: (/* @__PURE__ */ new Date()).toISOString(), body };
  writeFileSync(path, `${JSON.stringify(bundle, null, 2)}
`, "utf8");
  return bundle;
}

// src/cdp.ts
function endpointForPort(port = DEFAULT_CDP_PORT) {
  return `http://127.0.0.1:${port}`;
}
async function withMokaPage(port, operation) {
  const bridge = new CDPBridge2();
  const previousTarget = process.env.OPENCLI_CDP_TARGET;
  process.env.OPENCLI_CDP_TARGET = "app.mokahr.com";
  try {
    const page = await bridge.connect({ cdpEndpoint: endpointForPort(port), timeout: 10 });
    const currentUrl = await page.getCurrentUrl?.();
    if (!currentUrl?.startsWith(MOKA_ORIGIN)) {
      await page.goto(MOKA_OVERVIEW_URL, { waitUntil: "none" });
      await new Promise((resolve2) => setTimeout(resolve2, 1e3));
    }
    return await operation(page, bridge);
  } catch (error) {
    if (error instanceof BrowserConnectError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/ECONNREFUSED|CDP endpoint|No inspectable targets|fetch failed/i.test(message)) {
      throw new BrowserConnectError(
        `\u65E0\u6CD5\u8FDE\u63A5 Moka \u4E13\u7528 Chrome\uFF08\u7AEF\u53E3 ${port}\uFF09`,
        "\u8BF7\u5148\u8FD0\u884C opencli moka login\uFF0C\u6216\u786E\u8BA4 Chrome \u6CA1\u6709\u88AB\u5173\u95ED\u3002",
        "daemon-not-running"
      );
    }
    throw error;
  } finally {
    await bridge.close().catch(() => void 0);
    if (previousTarget === void 0) delete process.env.OPENCLI_CDP_TARGET;
    else process.env.OPENCLI_CDP_TARGET = previousTarget;
  }
}
async function probeMokaLogin(page) {
  const probe = await page.evaluate(async (path) => {
    const result = { pageUrl: window.location.href };
    try {
      const response = await fetch(path, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationIds: [] })
      });
      result.status = response.status;
      result.contentType = response.headers.get("content-type") || "";
      const text = await response.text();
      if (result.contentType.includes("application/json")) {
        try {
          result.json = JSON.parse(text);
        } catch {
          result.error = "invalid-json";
        }
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    return result;
  }, API_PATHS.interviewCard);
  const pageUrl = typeof probe.pageUrl === "string" ? probe.pageUrl : "";
  const pathSuggestsLogin = /login|signin|passport/i.test(pageUrl);
  const json = isRecord(probe.json) ? probe.json : void 0;
  const code = json && typeof json.code === "number" ? json.code : void 0;
  const authenticated = !pathSuggestsLogin && probe.status === 200 && Boolean(json) && code !== 401 && code !== 403;
  return authenticated ? {
    browser: "connected",
    mokaLogin: "authenticated",
    pageUrl,
    message: "Moka \u767B\u5F55\u6210\u529F\uFF0C\u53EF\u4EE5\u5F00\u59CB\u83B7\u53D6\u9762\u8BD5\u8BB0\u5F55"
  } : {
    browser: "connected",
    mokaLogin: "waiting_for_user",
    pageUrl,
    message: "\u8BF7\u5728\u6253\u5F00\u7684 Chrome \u7A97\u53E3\u4E2D\u5B8C\u6210 Moka \u767B\u5F55"
  };
}
var INTERVIEW_LIST_PAYLOAD_CACHE_KEY = "__opencli_moka_interview_list_payload__";
async function discoverInterviewListPayload(page, bridge, timeoutSeconds = 15) {
  const cached = await page.evaluate((key) => sessionStorage.getItem(key), INTERVIEW_LIST_PAYLOAD_CACHE_KEY);
  if (cached) return parseJsonObject(cached, "\u7F13\u5B58\u7684 Moka interviewList \u8BF7\u6C42\u4F53");
  await bridge.send("Network.enable");
  let handler;
  let timeoutHandle;
  const captured = new Promise((resolve2, reject) => {
    handler = (params) => {
      const event = params;
      const request = event.request;
      if (request?.method === "POST" && request.url?.includes(API_PATHS.interviewList) && request.postData) {
        try {
          resolve2(parseJsonObject(request.postData, "Moka interviewList \u8BF7\u6C42\u4F53"));
        } catch {
        }
      }
    };
    bridge.on("Network.requestWillBeSent", handler);
    timeoutHandle = setTimeout(
      () => reject(new Error("INTERVIEW_LIST_CAPTURE_TIMEOUT")),
      timeoutSeconds * 1e3
    );
  });
  try {
    const trigger = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const button = buttons.find((candidate) => candidate.classList.contains("table-load-more") || candidate.textContent?.trim() === "\u52A0\u8F7D\u66F4\u591A");
      if (!button || button.hasAttribute("disabled")) {
        return { clicked: false, reason: "load-more-not-found" };
      }
      button.click();
      return { clicked: true, reason: "load-more" };
    });
    if (!trigger.clicked) {
      throw new Error(
        "\u672A\u627E\u5230\u53EF\u89E6\u53D1 interviewList \u7684\u201C\u52A0\u8F7D\u66F4\u591A\u201D\u6309\u94AE\uFF0C\u4E14\u5F53\u524D\u6807\u7B7E\u9875\u6CA1\u6709\u7F13\u5B58\u8BF7\u6C42\u4F53\u3002\u8BF7\u5728\u603B\u89C8\u9875\u8C03\u6574\u4EFB\u610F\u7B5B\u9009\u6761\u4EF6\u540E\u7ACB\u5373\u91CD\u8BD5\u3002"
      );
    }
    try {
      const payload = await captured;
      await page.evaluate(
        (key, value) => sessionStorage.setItem(key, value),
        INTERVIEW_LIST_PAYLOAD_CACHE_KEY,
        JSON.stringify(payload)
      );
      try {
        writePayloadBundle(payload);
      } catch {
      }
      return payload;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "INTERVIEW_LIST_CAPTURE_TIMEOUT") throw error;
      const diagnostics = await page.evaluate(() => ({
        url: window.location.href,
        title: document.title,
        readyState: document.readyState,
        bodyLength: document.body?.innerText?.length ?? 0,
        matchingResources: performance.getEntriesByType("resource").map((entry) => entry.name).filter((url) => url.includes("interviewList"))
      })).catch(() => void 0);
      if (diagnostics && /login|signin|passport/i.test(diagnostics.url)) {
        throw new BrowserConnectError(
          "\u4E34\u65F6\u6807\u7B7E\u9875\u88AB Moka \u91CD\u5B9A\u5411\u5230\u767B\u5F55\u9875",
          "\u8BF7\u5728\u540C\u4E00\u4E2A CDP Chrome \u4E2D\u91CD\u65B0\u767B\u5F55 Moka\uFF0C\u7136\u540E\u8FD0\u884C opencli moka status\u3002",
          "command-failed"
        );
      }
      const detail = diagnostics ? `\u9875\u9762\u72B6\u6001\uFF1A${diagnostics.readyState}\uFF0C\u6807\u9898\uFF1A${diagnostics.title || "\u65E0"}\uFF0C\u6B63\u6587\u957F\u5EA6\uFF1A${diagnostics.bodyLength}` : "\u65E0\u6CD5\u8BFB\u53D6\u4E34\u65F6\u9875\u9762\u72B6\u6001";
      throw new TimeoutError(
        `\u70B9\u51FB\u201C\u52A0\u8F7D\u66F4\u591A\u201D\u540E\u6355\u83B7 Moka interviewList \u8BF7\u6C42\uFF08${detail}\uFF09`,
        timeoutSeconds,
        "\u8BF7\u786E\u8BA4\u8BE5\u8D26\u53F7\u80FD\u6B63\u5E38\u6253\u5F00\u201C\u9762\u8BD5\u201D\u603B\u89C8\uFF1B\u4E5F\u53EF\u4ECE DevTools \u590D\u5236 Request Payload \u540E\u901A\u8FC7 --request-json \u8C03\u8BD5\u3002"
      );
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (handler) bridge.off("Network.requestWillBeSent", handler);
  }
}

// src/collector.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, resolve } from "node:path";

// src/moka-api.ts
import { AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";

// src/parsers.ts
function readId(value) {
  return typeof value === "string" || typeof value === "number" ? value : void 0;
}
function applicationFromEntity(value) {
  if (!isRecord(value)) return void 0;
  const applicationId = readId(value.id);
  if (applicationId === void 0) return void 0;
  const job = isRecord(value.job) ? value.job : {};
  const jobId = readId(job.id);
  return {
    applicationId,
    candidateName: asString(value.name),
    jobTitle: asString(job.title),
    ...jobId === void 0 ? {} : { jobId }
  };
}
function parseApplications(response) {
  if (!isRecord(response) || !isRecord(response.data)) return [];
  const result = /* @__PURE__ */ new Map();
  for (const row of asArray(response.data.rows)) {
    if (!isRecord(row)) continue;
    const applicationsInRow = /* @__PURE__ */ new Map();
    for (const entity of asArray(row.applicationEntities)) {
      const application = applicationFromEntity(entity);
      if (application) applicationsInRow.set(String(application.applicationId), application);
    }
    for (const interviewValue of asArray(row.restinterviews)) {
      if (!isRecord(interviewValue)) continue;
      const interviewId = readId(interviewValue.id);
      const startTime = readId(interviewValue.startTime);
      const linkedIds = asArray(interviewValue.validApplicationIds).length ? asArray(interviewValue.validApplicationIds) : asArray(interviewValue.applicationIds);
      for (const linkedId of linkedIds) {
        const id = readId(linkedId);
        if (id === void 0) continue;
        const application = applicationsInRow.get(String(id));
        if (!application || result.has(String(id))) continue;
        const startTimeNumber = asOptionalNumber(startTime);
        result.set(String(id), {
          ...application,
          ...interviewId === void 0 ? {} : { overviewInterviewId: interviewId },
          ...startTime === void 0 ? {} : { overviewStartTime: startTime },
          ...startTimeNumber === void 0 ? {} : { overviewStartTimeIso: new Date(startTimeNumber).toISOString() }
        });
      }
    }
    for (const application of applicationsInRow.values()) {
      const key = String(application.applicationId);
      if (!result.has(key)) result.set(key, application);
    }
  }
  return [...result.values()];
}
function readPagination(response) {
  const data = isRecord(response) && isRecord(response.data) ? response.data : {};
  return {
    currentPage: asOptionalNumber(data.currentPage) ?? 1,
    pageSize: asOptionalNumber(data.pageSize) ?? 10,
    totalPage: Math.max(1, asOptionalNumber(data.totalPage) ?? 1)
  };
}
function interviewerNames(entity) {
  const names = /* @__PURE__ */ new Set();
  for (const feedback of asArray(entity.interviewerFeedbacks)) {
    if (!isRecord(feedback)) continue;
    const interviewer = isRecord(feedback.interviewer) ? feedback.interviewer : feedback;
    const name = asString(interviewer.name);
    if (name) names.add(name);
  }
  for (const interviewer of asArray(entity.interviewers)) {
    if (!isRecord(interviewer)) continue;
    const name = asString(interviewer.name);
    if (name) names.add(name);
  }
  return [...names];
}
function parseInterviews(response, fallback) {
  if (!isRecord(response)) return [];
  const result = /* @__PURE__ */ new Map();
  for (const card of asArray(response.data)) {
    if (!isRecord(card)) continue;
    const parsedApplication = applicationFromEntity(card.application) ?? fallback;
    if (!parsedApplication) continue;
    for (const entityValue of asArray(card.entities)) {
      if (!isRecord(entityValue)) continue;
      const interviewId = readId(entityValue.id);
      if (interviewId === void 0) continue;
      const round = asOptionalNumber(entityValue.round);
      const roundName = asString(entityValue.roundName);
      const startTime = readId(entityValue.startTime);
      const record = {
        ...parsedApplication,
        interviewId,
        interviewerNames: interviewerNames(entityValue),
        ...round === void 0 ? {} : { round },
        ...roundName ? { roundName } : {},
        ...startTime === void 0 ? {} : { startTime }
      };
      result.set(`${String(record.applicationId)}:${String(interviewId)}`, record);
    }
  }
  return [...result.values()];
}
function parseMeetingSummary(response) {
  if (!isRecord(response)) {
    throw new Error("getMeetingSummary \u8FD4\u56DE\u4E86\u65E0\u6CD5\u8BC6\u522B\u7684\u54CD\u5E94");
  }
  const code = asOptionalNumber(response.code);
  const message = asString(response.msg);
  if (code === 103) {
    return {
      transcriptStatus: "not_available",
      mokaCode: code,
      ...message ? { mokaMessage: message } : {}
    };
  }
  if (code !== void 0 && code !== 0) {
    throw new Error(`Moka getMeetingSummary \u5931\u8D25\uFF1A${message || `code=${code}`}`);
  }
  const data = isRecord(response.data) ? response.data : {};
  return {
    transcriptStatus: "available",
    transcript: data.transcript,
    transcriptType: data.transcriptType,
    evaluationSummary: data.evaSummary,
    questionAnalysis: parsePossiblyEncodedJson(data.evaQuestionAnalysis),
    ...code === void 0 ? {} : { mokaCode: code },
    ...message ? { mokaMessage: message } : {}
  };
}

// src/moka-api.ts
var HIRE_MODE_VALUES = {
  campus: 2,
  social: 1
};
var MODE_REFRESH_DELAY_MS = 2e3;
async function setHireMode(page, bridge, mode) {
  const currentHireMode = HIRE_MODE_VALUES[mode];
  const response = await page.evaluate(async ({ path, value }) => {
    const httpResponse = await fetch(path, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentHireMode: value })
    });
    const text = await httpResponse.text();
    let json;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
      }
    }
    return {
      ok: httpResponse.ok,
      status: httpResponse.status,
      statusText: httpResponse.statusText,
      text,
      json
    };
  }, { path: API_PATHS.updateCurrentHireMode, value: currentHireMode });
  if (!response.ok) {
    if (isRecord(response.json)) assertApiResponse(response.json, "update_currenthiremode_fields");
    const detail = response.text.trim() || response.statusText || "unknown error";
    if (response.status === 401 || response.status === 403) {
      throw new AuthRequiredError("app.mokahr.com", `Moka \u767B\u5F55\u72B6\u6001\u5DF2\u5931\u6548\uFF1AHTTP ${response.status} ${detail}`);
    }
    throw new CommandExecutionError(
      `Moka update_currenthiremode_fields \u5931\u8D25\uFF1AHTTP ${response.status} ${detail}`
    );
  }
  if (isRecord(response.json)) assertApiResponse(response.json, "update_currenthiremode_fields");
  await bridge.send("Page.enable");
  await bridge.send("Page.reload");
  await new Promise((resolve2) => setTimeout(resolve2, MODE_REFRESH_DELAY_MS));
  await bridge.send("Page.reload");
  return {
    mode,
    modeLabel: mode === "campus" ? "\u6821\u62DB" : "\u793E\u62DB",
    currentHireMode
  };
}
function assertApiResponse(response, endpoint) {
  if (!isRecord(response)) {
    throw new AuthRequiredError("app.mokahr.com", `${endpoint} \u6CA1\u6709\u8FD4\u56DE JSON\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55 Moka`);
  }
  const code = typeof response.code === "number" ? response.code : void 0;
  if (code !== void 0 && code !== 0) {
    const message = asString(response.msg) || `code=${code}`;
    if (code === 401 || code === 403) {
      throw new AuthRequiredError("app.mokahr.com", `Moka \u767B\u5F55\u72B6\u6001\u5DF2\u5931\u6548\uFF1A${message}`);
    }
    throw new CommandExecutionError(`Moka ${endpoint} \u5931\u8D25\uFF1A${message}`);
  }
}
function bodyForPage(base, page) {
  const result = { ...base };
  const pageKey = ["currentPage", "pageNum", "page"].find((key) => key in result) || "currentPage";
  result[pageKey] = page;
  return result;
}
var SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1e3;
function shanghaiDayBounds(now = Date.now()) {
  const shifted = new Date(now + SHANGHAI_OFFSET_MS);
  const start = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate()
  ) - SHANGHAI_OFFSET_MS;
  return { start, end: start + 24 * 60 * 60 * 1e3 - 1e3 };
}
function defaultInterviewListBody(base, now = Date.now()) {
  const shared = { ...base };
  for (const key of ["countType", "order", "minStartDate", "maxStartDate", "currentPage", "pageNum", "page"]) {
    delete shared[key];
  }
  const { start, end } = shanghaiDayBounds(now);
  return {
    ...shared,
    jobPreference: shared.jobPreference ?? "all",
    countType: "today",
    order: "asc",
    minStartDate: start,
    maxStartDate: end,
    currentPage: 1,
    pageSize: shared.pageSize ?? 10
  };
}
async function resolveBaseBody(options) {
  if (options.requestBody) return { ...options.requestBody };
  const cached = readPayloadBundle();
  if (cached) return { ...cached.body };
  if (options.page && options.bridge) {
    return await discoverInterviewListPayload(options.page, options.bridge);
  }
  throw new CommandExecutionError(
    "Moka interviewList \u8BF7\u6C42\u4F53\u6A21\u677F\u7F3A\u5931\u3002\u8BF7\u5148\u8FD0\u884C opencli moka login \u6216 opencli moka export-transcripts(\u9ED8\u8BA4\u8D70 CDP)\u4E00\u6B21,\u8BA9 CLI \u6293\u53D6\u5E76\u7F13\u5B58\u8BF7\u6C42\u4F53\u6A21\u677F\u3002"
  );
}
async function listApplications(client, options = {}) {
  const capturedBody = await resolveBaseBody(options);
  const queryBodies = options.requestBody ? [capturedBody] : [defaultInterviewListBody(capturedBody)];
  const records = /* @__PURE__ */ new Map();
  for (const baseBody of queryBodies) {
    let currentPage = 1;
    let totalPage = 1;
    do {
      const response = await client.fetchJson(API_PATHS.interviewList, {
        method: "POST",
        body: bodyForPage(baseBody, currentPage),
        timeoutMs: 3e4
      });
      assertApiResponse(response, "interviewList");
      for (const application of parseApplications(response)) {
        const key = String(application.applicationId);
        if (!records.has(key)) records.set(key, application);
      }
      const pagination = readPagination(response);
      totalPage = pagination.totalPage;
      currentPage += 1;
    } while (currentPage <= totalPage);
  }
  const all = [...records.values()];
  const needle = options.candidateName?.trim().toLocaleLowerCase();
  return needle ? all.filter((item) => item.candidateName.toLocaleLowerCase().includes(needle)) : all;
}
async function listInterviews(client, application) {
  const response = await client.fetchJson(API_PATHS.interviewCard, {
    method: "POST",
    body: { applicationIds: [String(application.applicationId)] },
    timeoutMs: 3e4
  });
  assertApiResponse(response, "interviewCard");
  return parseInterviews(response, application);
}
async function getMeetingSummary(client, applicationId, interviewId) {
  const response = await client.fetchJson(API_PATHS.meetingSummary, {
    method: "POST",
    body: { applicationId, interviewId },
    timeoutMs: 6e4
  });
  return parseMeetingSummary(response);
}

// src/collector.ts
async function collectTranscripts(client, options = {}) {
  const applications = await listApplications(client, options);
  const records = [];
  const errors = [];
  let interviewCount = 0;
  for (const application of applications) {
    let interviews;
    try {
      interviews = await listInterviews(client, application);
    } catch (error) {
      errors.push({
        applicationId: application.applicationId,
        stage: "interviewCard",
        message: errorMessage(error)
      });
      continue;
    }
    interviewCount += interviews.length;
    for (const interview of interviews) {
      try {
        const summary = await getMeetingSummary(
          client,
          interview.applicationId,
          interview.interviewId
        );
        records.push({ ...interview, ...summary });
      } catch (error) {
        errors.push({
          applicationId: interview.applicationId,
          interviewId: interview.interviewId,
          stage: "meetingSummary",
          message: errorMessage(error)
        });
      }
    }
  }
  return {
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    source: "https://app.mokahr.com/interviews/overview",
    records,
    errors,
    stats: {
      applications: applications.length,
      interviews: interviewCount,
      transcriptsAvailable: records.filter((item) => item.transcriptStatus === "available").length,
      transcriptsUnavailable: records.filter((item) => item.transcriptStatus === "not_available").length,
      errors: errors.length
    }
  };
}
function recordKey(record) {
  return `${String(record.applicationId)}:${String(record.interviewId)}`;
}
function readExistingCollection(path) {
  if (!existsSync3(path)) return void 0;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync2(path, "utf8"));
  } catch (error) {
    throw new Error(`\u5DF2\u6709\u5BFC\u51FA\u6587\u4EF6\u4E0D\u662F\u6709\u6548 JSON\uFF0C\u5DF2\u505C\u6B62\u5199\u5165\u4EE5\u907F\u514D\u8986\u76D6\uFF1A${path}\uFF08${errorMessage(error)}\uFF09`);
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.records)) {
    throw new Error(`\u5DF2\u6709\u5BFC\u51FA\u6587\u4EF6\u7F3A\u5C11 records \u6570\u7EC4\uFF0C\u5DF2\u505C\u6B62\u5199\u5165\u4EE5\u907F\u514D\u8986\u76D6\uFF1A${path}`);
  }
  return parsed;
}
function mergeCollections(existing, latest) {
  const records = /* @__PURE__ */ new Map();
  for (const record of existing?.records ?? []) records.set(recordKey(record), record);
  for (const record of latest.records) records.set(recordKey(record), record);
  const mergedRecords = [...records.values()];
  const applicationIds = new Set(mergedRecords.map((record) => String(record.applicationId)));
  for (const error of latest.errors) {
    if (error.applicationId !== void 0) applicationIds.add(String(error.applicationId));
  }
  return {
    generatedAt: latest.generatedAt,
    source: latest.source,
    records: mergedRecords,
    errors: latest.errors,
    stats: {
      applications: applicationIds.size,
      interviews: mergedRecords.length,
      transcriptsAvailable: mergedRecords.filter((item) => item.transcriptStatus === "available").length,
      transcriptsUnavailable: mergedRecords.filter((item) => item.transcriptStatus === "not_available").length,
      errors: latest.errors.length
    }
  };
}
function writeCollection(outputPath, latest, options = {}) {
  const absolutePath = resolve(outputPath);
  const parentDirectory = dirname2(absolutePath);
  if (!existsSync3(parentDirectory)) mkdirSync3(parentDirectory, { recursive: true });
  const result = options.overwrite ? latest : mergeCollections(readExistingCollection(absolutePath), latest);
  writeFileSync2(absolutePath, `${JSON.stringify(result, null, 2)}
`, "utf8");
  return { outputPath: absolutePath, result };
}

// src/cookie-store.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync4, readFileSync as readFileSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { dirname as dirname3, join as join3 } from "node:path";
var MOKA_COOKIE_DOMAIN_SUFFIX = ".mokahr.com";
function defaultCookiePath() {
  return join3(homedir3(), ".opencli", "mokaData", "moka-cookies.json");
}
function ensureParentDir2(filePath) {
  const parent = dirname3(filePath);
  if (!existsSync4(parent)) mkdirSync4(parent, { recursive: true });
}
function toStoredCookie(raw) {
  if (!isRecord(raw)) return void 0;
  const name = typeof raw.name === "string" ? raw.name : "";
  const value = typeof raw.value === "string" ? raw.value : "";
  const domain = typeof raw.domain === "string" ? raw.domain : "";
  const path = typeof raw.path === "string" ? raw.path : "/";
  if (!name || !domain) return void 0;
  const cookie = { name, value, domain, path };
  if (typeof raw.expires === "number") cookie.expires = raw.expires;
  if (typeof raw.httpOnly === "boolean") cookie.httpOnly = raw.httpOnly;
  if (typeof raw.secure === "boolean") cookie.secure = raw.secure;
  if (typeof raw.sameSite === "string") cookie.sameSite = raw.sameSite;
  return cookie;
}
function domainMatches(cookieDomain, host) {
  const normalized = cookieDomain.startsWith(".") ? cookieDomain.slice(1) : cookieDomain;
  return host === normalized || host.endsWith(`.${normalized}`);
}
function isSessionCookieValid(cookie) {
  if (typeof cookie.expires !== "number" || cookie.expires <= 0) return true;
  return cookie.expires * 1e3 > Date.now();
}
function readCookieBundle(path = defaultCookiePath()) {
  if (!existsSync4(path)) return void 0;
  try {
    const parsed = JSON.parse(readFileSync3(path, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.cookies)) return void 0;
    const cookies = parsed.cookies.map(toStoredCookie).filter((cookie) => Boolean(cookie));
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : (/* @__PURE__ */ new Date(0)).toISOString();
    return { updatedAt, cookies };
  } catch {
    return void 0;
  }
}
function writeCookieBundle(bundle, path = defaultCookiePath()) {
  ensureParentDir2(path);
  const payload = { updatedAt: bundle.updatedAt, cookies: bundle.cookies };
  writeFileSync3(path, `${JSON.stringify(payload, null, 2)}
`, "utf8");
}
function cookieHeaderFor(host, bundle) {
  const parts = [];
  const seen = /* @__PURE__ */ new Set();
  for (const cookie of bundle.cookies) {
    if (!domainMatches(cookie.domain, host)) continue;
    if (!isSessionCookieValid(cookie)) continue;
    if (seen.has(cookie.name)) continue;
    seen.add(cookie.name);
    parts.push(`${cookie.name}=${cookie.value}`);
  }
  return parts.join("; ");
}
function parseSetCookieAttrs(parts) {
  const attrs = {};
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const key = eq === -1 ? trimmed.toLowerCase() : trimmed.slice(0, eq).trim().toLowerCase();
    const value = eq === -1 ? "" : trimmed.slice(eq + 1).trim();
    if (key === "domain") attrs.domain = value.startsWith(".") ? value : `.${value}`;
    else if (key === "path") attrs.path = value || "/";
    else if (key === "expires") {
      const parsedDate = Date.parse(value);
      if (!Number.isNaN(parsedDate)) attrs.expires = Math.floor(parsedDate / 1e3);
    } else if (key === "max-age") {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) attrs.expires = Math.floor(Date.now() / 1e3) + seconds;
    } else if (key === "httponly") attrs.httpOnly = true;
    else if (key === "secure") attrs.secure = true;
    else if (key === "samesite") attrs.sameSite = value;
  }
  return attrs;
}
function mergeSetCookieHeaders(existing, setCookieHeaders, requestHost) {
  const map = /* @__PURE__ */ new Map();
  for (const cookie of existing?.cookies ?? []) {
    map.set(`${cookie.domain}|${cookie.path}|${cookie.name}`, cookie);
  }
  for (const rawHeader of setCookieHeaders) {
    const [nameValue, ...rest] = rawHeader.split(";");
    if (!nameValue) continue;
    const eq = nameValue.indexOf("=");
    if (eq === -1) continue;
    const name = nameValue.slice(0, eq).trim();
    const value = nameValue.slice(eq + 1).trim();
    if (!name) continue;
    const attrs = parseSetCookieAttrs(rest);
    const cookie = {
      name,
      value,
      domain: attrs.domain || `.${requestHost}`,
      path: attrs.path || "/",
      ...attrs.expires === void 0 ? {} : { expires: attrs.expires },
      ...attrs.httpOnly === void 0 ? {} : { httpOnly: attrs.httpOnly },
      ...attrs.secure === void 0 ? {} : { secure: attrs.secure },
      ...attrs.sameSite === void 0 ? {} : { sameSite: attrs.sameSite }
    };
    if (typeof cookie.expires === "number" && cookie.expires <= Math.floor(Date.now() / 1e3)) {
      map.delete(`${cookie.domain}|${cookie.path}|${cookie.name}`);
      continue;
    }
    map.set(`${cookie.domain}|${cookie.path}|${cookie.name}`, cookie);
  }
  return {
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    cookies: [...map.values()]
  };
}
async function dumpCookiesFromBridge(bridge, path = defaultCookiePath()) {
  const response = await bridge.send("Network.getAllCookies");
  const cookies = isRecord(response) && Array.isArray(response.cookies) ? response.cookies.map(toStoredCookie).filter((cookie) => cookie !== void 0 && cookie.domain.endsWith(MOKA_COOKIE_DOMAIN_SUFFIX)) : [];
  const bundle = {
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    cookies
  };
  writeCookieBundle(bundle, path);
  return { path, cookieCount: cookies.length };
}

// src/http-client.ts
import { AuthRequiredError as AuthRequiredError2, CommandExecutionError as CommandExecutionError2 } from "@jackwener/opencli/errors";
var DEFAULT_HEADERS = {
  "accept": "application/json, text/plain, */*",
  "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  "origin": MOKA_ORIGIN,
  "referer": `${MOKA_ORIGIN}/interviews/overview`,
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
};
function collectSetCookieHeaders(headers) {
  const rawGetter = headers.getSetCookie;
  if (typeof rawGetter === "function") return rawGetter.call(headers);
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}
function createHttpClient(options = {}) {
  const cookiePath = options.cookiePath ?? defaultCookiePath();
  let bundle = options.bundle ?? readCookieBundle(cookiePath);
  if (!bundle || bundle.cookies.length === 0) {
    throw new AuthRequiredError2(
      "app.mokahr.com",
      "\u672C\u5730\u6CA1\u6709\u53EF\u7528\u7684 Moka \u767B\u5F55\u6001\u3002\u8BF7\u5148\u8FD0\u884C opencli moka login \u8BA9 CDP Chrome \u767B\u5F55\u4E00\u6B21\u3002"
    );
  }
  const host = new URL(MOKA_ORIGIN).host;
  async function fetchJson(path, opts = {}) {
    const method = opts.method ?? "POST";
    const cookieHeader = cookieHeaderFor(host, bundle);
    if (!cookieHeader) {
      throw new AuthRequiredError2(
        "app.mokahr.com",
        "\u672C\u5730 Moka cookie \u5DF2\u5168\u90E8\u8FC7\u671F,\u8BF7\u91CD\u65B0\u8FD0\u884C opencli moka login \u4EE5\u5237\u65B0\u767B\u5F55\u6001\u3002"
      );
    }
    const headers = {
      ...DEFAULT_HEADERS,
      ...opts.headers ?? {},
      cookie: cookieHeader
    };
    if (opts.body !== void 0 && !headers["content-type"]) {
      headers["content-type"] = "application/json";
    }
    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? 3e4;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      const init = {
        method,
        headers,
        signal: controller.signal,
        redirect: "manual"
      };
      if (opts.body !== void 0) init.body = JSON.stringify(opts.body);
      response = await fetch(`${MOKA_ORIGIN}${path}`, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CommandExecutionError2(`Moka ${path} \u8BF7\u6C42\u5931\u8D25: ${message}`);
    } finally {
      clearTimeout(timer);
    }
    const setCookies = collectSetCookieHeaders(response.headers);
    if (setCookies.length > 0) {
      bundle = mergeSetCookieHeaders(bundle, setCookies, host);
      writeCookieBundle(bundle, cookiePath);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthRequiredError2(
        "app.mokahr.com",
        `Moka \u767B\u5F55\u6001\u5931\u6548: HTTP ${response.status}\u3002\u8BF7\u91CD\u65B0\u8FD0\u884C opencli moka login\u3002`
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new AuthRequiredError2(
        "app.mokahr.com",
        `Moka \u8FD4\u56DE ${response.status} \u91CD\u5B9A\u5411,\u901A\u5E38\u8868\u793A\u767B\u5F55\u6001\u5DF2\u5931\u6548\u3002\u8BF7\u91CD\u65B0\u8FD0\u884C opencli moka login\u3002`
      );
    }
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    let json;
    if (text && contentType.includes("application/json")) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new CommandExecutionError2(`Moka ${path} \u8FD4\u56DE\u4E86\u975E JSON \u54CD\u5E94`);
      }
    } else if (text) {
      try {
        json = JSON.parse(text);
      } catch {
      }
    }
    if (!response.ok) {
      const detail = isRecord(json) && typeof json.msg === "string" ? json.msg : text.trim() || response.statusText;
      throw new CommandExecutionError2(`Moka ${path} \u5931\u8D25: HTTP ${response.status} ${detail}`);
    }
    return json ?? {};
  }
  return { fetchJson };
}

// src/plugin.ts
var commonPortArg = {
  name: "port",
  type: "int",
  default: DEFAULT_CDP_PORT,
  help: "Chrome CDP \u7AEF\u53E3\uFF0C\u9ED8\u8BA4 9222"
};
var noCdpArg = {
  name: "offline",
  type: "boolean",
  default: false,
  help: "\u8DF3\u8FC7 CDP Chrome\uFF0C\u76F4\u63A5\u7528\u672C\u5730\u7F13\u5B58\u7684\u767B\u5F55\u6001\u53D1 HTTP \u8BF7\u6C42\uFF08\u65E0 Chrome \u573A\u666F\uFF09"
};
function intArg(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new ArgumentError("port \u5FC5\u987B\u662F\u6B63\u6574\u6570");
  return parsed;
}
function idArg(value, name) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new ArgumentError(`${name} \u4E0D\u80FD\u4E3A\u7A7A`);
}
function optionalRequestBody(value) {
  if (typeof value !== "string" || !value.trim()) return void 0;
  return parseJsonObject(value, "--request-json");
}
function hireModeArg(value) {
  if (typeof value !== "string") throw new ArgumentError("mode \u5FC5\u987B\u662F campus/social \u6216\u6821\u62DB/\u793E\u62DB");
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized === "campus" || normalized === "\u6821\u62DB" || normalized === "1") return "campus";
  if (normalized === "social" || normalized === "\u793E\u62DB" || normalized === "2") return "social";
  throw new ArgumentError(`\u4E0D\u652F\u6301\u7684 Moka \u62DB\u8058\u6A21\u5F0F: ${value}\u3002\u8BF7\u4F7F\u7528 campus \u6216 social`);
}
function collectionOptions(kwargs) {
  const candidateName = typeof kwargs.candidate === "string" && kwargs.candidate.trim() ? kwargs.candidate.trim() : void 0;
  const requestBody = optionalRequestBody(kwargs.requestJson);
  return {
    ...candidateName ? { candidateName } : {},
    ...requestBody ? { requestBody } : {}
  };
}
async function withHttpClient(kwargs, fn) {
  const noCdp = Boolean(kwargs["offline"]);
  if (noCdp) {
    const client = createHttpClient();
    return fn(client, {});
  }
  return withMokaPage(intArg(kwargs.port, DEFAULT_CDP_PORT), async (page, bridge) => {
    await dumpCookiesFromBridge(bridge).catch(() => void 0);
    const client = createHttpClient();
    return fn(client, { page, bridge });
  });
}
cli({
  site: "moka",
  name: "login",
  description: "\u6253\u5F00 Moka \u4E13\u7528 Chrome \u767B\u5F55\u7A97\u53E3",
  access: "read",
  example: "opencli moka login -f json",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "json",
  args: [
    commonPortArg,
    { name: "chrome-path", valueRequired: true, help: "chrome.exe \u7684\u5B8C\u6574\u8DEF\u5F84" },
    { name: "profile-dir", valueRequired: true, help: "\u4E13\u7528 Chrome \u7528\u6237\u76EE\u5F55" }
  ],
  columns: ["browser", "mokaLogin", "message", "pageUrl"],
  func: async (kwargs) => {
    const port = intArg(kwargs.port, DEFAULT_CDP_PORT);
    const launch = await ensureChromeWithCdp({
      port,
      url: MOKA_OVERVIEW_URL,
      ...typeof kwargs.chromePath === "string" ? { chromePath: kwargs.chromePath } : {},
      ...typeof kwargs.profileDir === "string" ? { profileDir: kwargs.profileDir } : {}
    });
    const status = await withMokaPage(port, async (page, bridge) => {
      const probe = await probeMokaLogin(page);
      if (probe.mokaLogin === "authenticated") {
        await dumpCookiesFromBridge(bridge).catch(() => void 0);
      }
      return probe;
    });
    return [{
      ...status,
      launched: launch.launched,
      reusedMokaTab: launch.reusedMokaTab,
      refreshedAfterLaunch: launch.refreshedAfterLaunch,
      cdpEndpoint: launch.endpoint,
      profileDir: launch.profileDir
    }];
  }
});
cli({
  site: "moka",
  name: "status",
  description: "\u68C0\u67E5 Moka \u4E13\u7528 Chrome \u548C\u767B\u5F55\u72B6\u6001",
  access: "read",
  example: "opencli moka status -f json",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "json",
  args: [commonPortArg],
  columns: ["browser", "mokaLogin", "message", "pageUrl"],
  func: async (kwargs) => withMokaPage(
    intArg(kwargs.port, DEFAULT_CDP_PORT),
    async (page, bridge) => {
      const probe = await probeMokaLogin(page);
      if (probe.mokaLogin === "authenticated") {
        await dumpCookiesFromBridge(bridge).catch(() => void 0);
      }
      return [probe];
    }
  )
});
cli({
  site: "moka",
  name: "mode",
  description: "\u5207\u6362 Moka \u5F53\u524D\u62DB\u8058\u6A21\u5F0F\uFF08\u6821\u62DB/\u793E\u62DB\uFF09",
  access: "write",
  example: "opencli moka mode campus -f json",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "json",
  args: [
    { name: "mode", positional: true, required: true, help: "campus\uFF08\u6821\u62DB\uFF09\u6216 social\uFF08\u793E\u62DB\uFF09" },
    commonPortArg
  ],
  columns: ["mode", "modeLabel", "currentHireMode"],
  func: async (kwargs) => withMokaPage(
    intArg(kwargs.port, DEFAULT_CDP_PORT),
    async (page, bridge) => {
      const result = await setHireMode(page, bridge, hireModeArg(kwargs.mode));
      await dumpCookiesFromBridge(bridge).catch(() => void 0);
      return [result];
    }
  )
});
cli({
  site: "moka",
  name: "applications",
  description: "\u5217\u51FA\u5019\u9009\u4EBA\u7684\u5E94\u8058\u8BB0\u5F55\u548C\u5C97\u4F4D",
  access: "read",
  example: 'opencli moka applications --candidate "\u5019\u9009\u4EBA\u59D3\u540D" -f json',
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "json",
  args: [
    commonPortArg,
    noCdpArg,
    { name: "candidate", valueRequired: true, help: "\u6309\u5019\u9009\u4EBA\u59D3\u540D\u7B5B\u9009" },
    { name: "request-json", valueRequired: true, help: "\u9AD8\u7EA7\u7528\u6CD5\uFF1A\u8986\u76D6 interviewList \u8BF7\u6C42\u4F53 JSON" }
  ],
  columns: ["applicationId", "candidateName", "jobTitle", "overviewStartTimeIso"],
  func: async (kwargs) => withHttpClient(kwargs, async (client, ctx) => listApplications(client, {
    ...collectionOptions(kwargs),
    ...ctx.page ? { page: ctx.page } : {},
    ...ctx.bridge ? { bridge: ctx.bridge } : {}
  }))
});
cli({
  site: "moka",
  name: "interviews",
  description: "\u5217\u51FA\u4E00\u4E2A\u5E94\u8058\u8BB0\u5F55\u4E0B\u7684\u5168\u90E8\u9762\u8BD5\u548C\u9762\u8BD5\u5B98",
  access: "read",
  example: "opencli moka interviews 123456789 -f json",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "json",
  args: [
    { name: "application-id", positional: true, required: true, help: "\u5E94\u8058\u8BB0\u5F55 ID" },
    commonPortArg,
    noCdpArg
  ],
  columns: ["applicationId", "interviewId", "candidateName", "jobTitle", "interviewerNames", "roundName", "startTime"],
  func: async (kwargs) => withHttpClient(kwargs, async (client) => {
    const application = {
      applicationId: idArg(kwargs["application-id"], "application-id"),
      candidateName: "",
      jobTitle: ""
    };
    return listInterviews(client, application);
  })
});
cli({
  site: "moka",
  name: "transcript",
  description: "\u8BFB\u53D6\u4E00\u573A\u9762\u8BD5\u7684\u9010\u5B57\u7A3F\u548C AI \u603B\u7ED3",
  access: "read",
  example: "opencli moka transcript 123456789 98765432 -f json",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "json",
  args: [
    { name: "application-id", positional: true, required: true, help: "\u5E94\u8058\u8BB0\u5F55 ID" },
    { name: "interview-id", positional: true, required: true, help: "\u9762\u8BD5 ID" },
    commonPortArg,
    noCdpArg
  ],
  func: async (kwargs) => withHttpClient(kwargs, async (client) => {
    const applicationId = idArg(kwargs["application-id"], "application-id");
    const interviewId = idArg(kwargs["interview-id"], "interview-id");
    return [{
      applicationId,
      interviewId,
      ...await getMeetingSummary(client, applicationId, interviewId)
    }];
  })
});
cli({
  site: "moka",
  name: "export-transcripts",
  aliases: ["export"],
  description: "\u5BFC\u51FA\u5019\u9009\u4EBA\u3001\u5C97\u4F4D\u3001\u9762\u8BD5\u5B98\u548C\u5168\u90E8\u9762\u8BD5\u9010\u5B57\u7A3F",
  access: "read",
  example: "opencli moka export-transcripts --output ./moka-transcripts.json -f json",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "json",
  args: [
    commonPortArg,
    noCdpArg,
    { name: "candidate", valueRequired: true, help: "\u6309\u5019\u9009\u4EBA\u59D3\u540D\u7B5B\u9009" },
    { name: "output", valueRequired: true, help: "JSON \u6587\u4EF6\u8F93\u51FA\u8DEF\u5F84" },
    { name: "overwrite", type: "boolean", default: false, help: "\u53EA\u4FDD\u5B58\u672C\u6B21\u7ED3\u679C\uFF0C\u76F4\u63A5\u8986\u76D6\u540C\u540D JSON \u6587\u4EF6" },
    { name: "request-json", valueRequired: true, help: "\u9AD8\u7EA7\u7528\u6CD5\uFF1A\u8986\u76D6 interviewList \u8BF7\u6C42\u4F53 JSON" }
  ],
  func: async (kwargs) => withHttpClient(kwargs, async (client, ctx) => {
    const result = await collectTranscripts(client, {
      ...collectionOptions(kwargs),
      ...ctx.page ? { page: ctx.page } : {},
      ...ctx.bridge ? { bridge: ctx.bridge } : {}
    });
    const written = typeof kwargs.output === "string" && kwargs.output.trim() ? writeCollection(kwargs.output.trim(), result, { overwrite: Boolean(kwargs.overwrite) }) : void 0;
    return written ? { ...written.result, outputPath: written.outputPath } : result;
  })
});
var mokaApiPaths = API_PATHS;
export {
  mokaApiPaths
};
