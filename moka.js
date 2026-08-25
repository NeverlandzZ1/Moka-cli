// src/plugin.ts
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError } from "@jackwener/opencli/errors";

// src/constants.ts
var MOKA_ORIGIN = "https://app.mokahr.com";
var MOKA_OVERVIEW_URL = `${MOKA_ORIGIN}/interviews/overview`;
var API_PATHS = {
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
async function openOrReuseCdpTab(endpoint, url) {
  const targetsResponse = await fetch(`${endpoint}/json`, {
    signal: AbortSignal.timeout(3e3)
  });
  if (targetsResponse.ok) {
    const targets = await targetsResponse.json();
    const existing = selectReusableMokaTarget(Array.isArray(targets) ? targets : []);
    if (existing) {
      await bringTargetToFront(existing);
      return true;
    }
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
  if (await probeCDP(options.port, 800)) {
    const reusedMokaTab = await openOrReuseCdpTab(endpoint, options.url);
    return { endpoint, launched: false, profileDir, reusedMokaTab };
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
      return { endpoint, launched: true, profileDir, reusedMokaTab: false };
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
import { mkdirSync as mkdirSync2, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
    for (const entity of asArray(row.applicationEntities)) {
      const application = applicationFromEntity(entity);
      if (application) result.set(String(application.applicationId), application);
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
async function listApplications(page, bridge, options = {}) {
  const baseBody = options.requestBody ? { ...options.requestBody } : await discoverInterviewListPayload(page, bridge);
  const records = /* @__PURE__ */ new Map();
  let currentPage = 1;
  let totalPage = 1;
  do {
    const response = await page.fetchJson(API_PATHS.interviewList, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyForPage(baseBody, currentPage),
      timeoutMs: 3e4
    });
    assertApiResponse(response, "interviewList");
    for (const application of parseApplications(response)) {
      records.set(String(application.applicationId), application);
    }
    const pagination = readPagination(response);
    totalPage = pagination.totalPage;
    currentPage += 1;
  } while (currentPage <= totalPage && (!options.maxPages || currentPage <= options.maxPages));
  const all = [...records.values()];
  const needle = options.candidateName?.trim().toLocaleLowerCase();
  return needle ? all.filter((item) => item.candidateName.toLocaleLowerCase().includes(needle)) : all;
}
async function listInterviews(page, application) {
  const response = await page.fetchJson(API_PATHS.interviewCard, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: { applicationIds: [String(application.applicationId)] },
    timeoutMs: 3e4
  });
  assertApiResponse(response, "interviewCard");
  return parseInterviews(response, application);
}
async function getMeetingSummary(page, applicationId, interviewId) {
  const response = await page.fetchJson(API_PATHS.meetingSummary, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: { applicationId, interviewId },
    timeoutMs: 6e4
  });
  return parseMeetingSummary(response);
}

// src/collector.ts
async function collectTranscripts(page, bridge, options = {}) {
  const applications = await listApplications(page, bridge, options);
  const records = [];
  const errors = [];
  let interviewCount = 0;
  for (const application of applications) {
    let interviews;
    try {
      interviews = await listInterviews(page, application);
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
          page,
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
function writeCollection(outputPath, result) {
  const absolutePath = resolve(outputPath);
  mkdirSync2(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(result, null, 2)}
`, "utf8");
  return absolutePath;
}

// src/plugin.ts
var commonPortArg = {
  name: "port",
  type: "int",
  default: DEFAULT_CDP_PORT,
  help: "Chrome CDP \u7AEF\u53E3\uFF0C\u9ED8\u8BA4 9222"
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
function collectionOptions(kwargs) {
  const candidateName = typeof kwargs.candidate === "string" && kwargs.candidate.trim() ? kwargs.candidate.trim() : void 0;
  const maxPages = Number(kwargs.maxPages) || void 0;
  const requestBody = optionalRequestBody(kwargs.requestJson);
  return {
    ...candidateName ? { candidateName } : {},
    ...maxPages ? { maxPages } : {},
    ...requestBody ? { requestBody } : {}
  };
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
    const status = await withMokaPage(port, async (page) => probeMokaLogin(page));
    return [{
      ...status,
      launched: launch.launched,
      reusedMokaTab: launch.reusedMokaTab,
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
    async (page) => [await probeMokaLogin(page)]
  )
});
cli({
  site: "moka",
  name: "applications",
  description: "\u5217\u51FA\u5019\u9009\u4EBA\u7684\u5E94\u8058\u8BB0\u5F55\u548C\u5C97\u4F4D",
  access: "read",
  example: "opencli moka applications --candidate \u674E\u9F99\u4E00 -f json",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "json",
  args: [
    commonPortArg,
    { name: "candidate", valueRequired: true, help: "\u6309\u5019\u9009\u4EBA\u59D3\u540D\u7B5B\u9009" },
    { name: "max-pages", type: "int", default: 0, help: "\u6700\u591A\u8BFB\u53D6\u9875\u6570\uFF1B0 \u8868\u793A\u5168\u90E8" },
    { name: "request-json", valueRequired: true, help: "\u9AD8\u7EA7\u7528\u6CD5\uFF1A\u8986\u76D6 interviewList \u8BF7\u6C42\u4F53 JSON" }
  ],
  columns: ["applicationId", "candidateName", "jobTitle"],
  func: async (kwargs) => withMokaPage(
    intArg(kwargs.port, DEFAULT_CDP_PORT),
    async (page, bridge) => listApplications(page, bridge, collectionOptions(kwargs))
  )
});
cli({
  site: "moka",
  name: "interviews",
  description: "\u5217\u51FA\u4E00\u4E2A\u5E94\u8058\u8BB0\u5F55\u4E0B\u7684\u5168\u90E8\u9762\u8BD5\u548C\u9762\u8BD5\u5B98",
  access: "read",
  example: "opencli moka interviews 813749158 -f json",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "json",
  args: [
    { name: "application-id", positional: true, required: true, help: "\u5E94\u8058\u8BB0\u5F55 ID" },
    commonPortArg
  ],
  columns: ["applicationId", "interviewId", "candidateName", "jobTitle", "interviewerNames", "roundName", "startTime"],
  func: async (kwargs) => withMokaPage(
    intArg(kwargs.port, DEFAULT_CDP_PORT),
    async (page) => {
      const application = {
        applicationId: idArg(kwargs.applicationId, "application-id"),
        candidateName: "",
        jobTitle: ""
      };
      return listInterviews(page, application);
    }
  )
});
cli({
  site: "moka",
  name: "transcript",
  description: "\u8BFB\u53D6\u4E00\u573A\u9762\u8BD5\u7684\u9010\u5B57\u7A3F\u548C AI \u603B\u7ED3",
  access: "read",
  example: "opencli moka transcript 813749158 45796202 -f json",
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: "json",
  args: [
    { name: "application-id", positional: true, required: true, help: "\u5E94\u8058\u8BB0\u5F55 ID" },
    { name: "interview-id", positional: true, required: true, help: "\u9762\u8BD5 ID" },
    commonPortArg
  ],
  func: async (kwargs) => withMokaPage(
    intArg(kwargs.port, DEFAULT_CDP_PORT),
    async (page) => [{
      applicationId: idArg(kwargs.applicationId, "application-id"),
      interviewId: idArg(kwargs.interviewId, "interview-id"),
      ...await getMeetingSummary(
        page,
        idArg(kwargs.applicationId, "application-id"),
        idArg(kwargs.interviewId, "interview-id")
      )
    }]
  )
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
    { name: "candidate", valueRequired: true, help: "\u6309\u5019\u9009\u4EBA\u59D3\u540D\u7B5B\u9009" },
    { name: "max-pages", type: "int", default: 0, help: "\u6700\u591A\u8BFB\u53D6\u9875\u6570\uFF1B0 \u8868\u793A\u5168\u90E8" },
    { name: "output", valueRequired: true, help: "JSON \u6587\u4EF6\u8F93\u51FA\u8DEF\u5F84" },
    { name: "request-json", valueRequired: true, help: "\u9AD8\u7EA7\u7528\u6CD5\uFF1A\u8986\u76D6 interviewList \u8BF7\u6C42\u4F53 JSON" }
  ],
  func: async (kwargs) => withMokaPage(
    intArg(kwargs.port, DEFAULT_CDP_PORT),
    async (page, bridge) => {
      const result = await collectTranscripts(page, bridge, collectionOptions(kwargs));
      const outputPath = typeof kwargs.output === "string" && kwargs.output.trim() ? writeCollection(kwargs.output.trim(), result) : void 0;
      return { ...result, ...outputPath ? { outputPath } : {} };
    }
  )
});
var mokaApiPaths = API_PATHS;
export {
  mokaApiPaths
};
