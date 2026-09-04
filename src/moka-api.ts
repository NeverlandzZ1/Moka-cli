import type { IPage } from '@jackwener/opencli/types';
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { API_PATHS } from './constants.js';
import { discoverInterviewListPayload } from './cdp.js';
import type { CDPBridge } from '@jackwener/opencli/browser/cdp';
import type {
  ApplicationRecord,
  HireMode,
  HireModeResult,
  InterviewRecord,
  JsonRecord,
  MeetingSummaryRecord,
} from './types.js';
import { parseApplications, parseInterviews, parseMeetingSummary, readPagination } from './parsers.js';
import { asString, isRecord } from './utils.js';
import type { HttpClient } from './http-client.js';
import { readPayloadBundle } from './payload-store.js';

const HIRE_MODE_VALUES: Record<HireMode, 1 | 2> = {
  campus: 2,
  social: 1,
};

const MODE_REFRESH_DELAY_MS = 2_000;

export async function setHireMode(
  page: IPage,
  bridge: CDPBridge,
  mode: HireMode,
): Promise<HireModeResult> {
  const currentHireMode = HIRE_MODE_VALUES[mode];
  const response = await page.evaluate(async ({ path, value }) => {
    const httpResponse = await fetch(path, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentHireMode: value }),
    });
    const text = await httpResponse.text();
    let json: unknown;
    if (text) {
      try { json = JSON.parse(text); } catch { /* Moka normally returns text/plain here. */ }
    }
    return {
      ok: httpResponse.ok,
      status: httpResponse.status,
      statusText: httpResponse.statusText,
      text,
      json,
    };
  }, { path: API_PATHS.updateCurrentHireMode, value: currentHireMode });

  if (!response.ok) {
    if (isRecord(response.json)) assertApiResponse(response.json, 'update_currenthiremode_fields');
    const detail = response.text.trim() || response.statusText || 'unknown error';
    if (response.status === 401 || response.status === 403) {
      throw new AuthRequiredError('app.mokahr.com', `Moka 登录状态已失效：HTTP ${response.status} ${detail}`);
    }
    throw new CommandExecutionError(
      `Moka update_currenthiremode_fields 失败：HTTP ${response.status} ${detail}`,
    );
  }
  if (isRecord(response.json)) assertApiResponse(response.json, 'update_currenthiremode_fields');

  // Page.navigate to the current SPA URL is not equivalent to Chrome's refresh
  // button. Use CDP Page.reload twice because Moka's first reload can stall while
  // rebuilding its mode-dependent application state.
  await bridge.send('Page.enable');
  await bridge.send('Page.reload');
  await new Promise((resolve) => setTimeout(resolve, MODE_REFRESH_DELAY_MS));
  await bridge.send('Page.reload');

  return {
    mode,
    modeLabel: mode === 'campus' ? '校招' : '社招',
    currentHireMode,
  };
}

function assertApiResponse(response: unknown, endpoint: string): void {
  if (!isRecord(response)) {
    throw new AuthRequiredError('app.mokahr.com', `${endpoint} 没有返回 JSON，请重新登录 Moka`);
  }
  const code = typeof response.code === 'number' ? response.code : undefined;
  if (code !== undefined && code !== 0) {
    const message = asString(response.msg) || `code=${code}`;
    if (code === 401 || code === 403) {
      throw new AuthRequiredError('app.mokahr.com', `Moka 登录状态已失效：${message}`);
    }
    throw new CommandExecutionError(`Moka ${endpoint} 失败：${message}`);
  }
}

function bodyForPage(base: JsonRecord, page: number): JsonRecord {
  const result = { ...base };
  const pageKey = ['currentPage', 'pageNum', 'page'].find((key) => key in result) || 'currentPage';
  result[pageKey] = page;
  return result;
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function shanghaiDayBounds(now = Date.now()): { start: number; end: number } {
  const shifted = new Date(now + SHANGHAI_OFFSET_MS);
  const start = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  ) - SHANGHAI_OFFSET_MS;
  return { start, end: start + 24 * 60 * 60 * 1000 - 1000 };
}

export function defaultInterviewListBody(base: JsonRecord, now = Date.now()): JsonRecord {
  const shared = { ...base };
  for (const key of ['countType', 'order', 'minStartDate', 'maxStartDate', 'currentPage', 'pageNum', 'page']) {
    delete shared[key];
  }
  const { start, end } = shanghaiDayBounds(now);
  return {
    ...shared,
    jobPreference: shared.jobPreference ?? 'all',
    countType: 'today',
    order: 'asc',
    minStartDate: start,
    maxStartDate: end,
    currentPage: 1,
    pageSize: shared.pageSize ?? 10,
  };
}

export interface ListApplicationsOptions {
  requestBody?: JsonRecord;
  candidateName?: string;
  page?: IPage;
  bridge?: CDPBridge;
}

async function resolveBaseBody(options: ListApplicationsOptions): Promise<JsonRecord> {
  if (options.requestBody) return { ...options.requestBody };
  const cached = readPayloadBundle();
  if (cached) return { ...cached.body };
  if (options.page && options.bridge) {
    // CDP path (login/status flow) — capture and rely on caller to persist.
    return await discoverInterviewListPayload(options.page, options.bridge);
  }
  throw new CommandExecutionError(
    'Moka interviewList 请求体模板缺失。请先运行 opencli moka login 或 opencli moka export-transcripts(默认走 CDP)一次,让 CLI 抓取并缓存请求体模板。',
  );
}

export async function listApplications(
  client: HttpClient,
  options: ListApplicationsOptions = {},
): Promise<ApplicationRecord[]> {
  const capturedBody = await resolveBaseBody(options);
  const queryBodies = options.requestBody
    ? [capturedBody]
    : [defaultInterviewListBody(capturedBody)];
  const records = new Map<string, ApplicationRecord>();
  for (const baseBody of queryBodies) {
    let currentPage = 1;
    let totalPage = 1;
    do {
      const response = await client.fetchJson(API_PATHS.interviewList, {
        method: 'POST',
        body: bodyForPage(baseBody, currentPage),
        timeoutMs: 30_000,
      });
      assertApiResponse(response, 'interviewList');
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
  return needle
    ? all.filter((item) => item.candidateName.toLocaleLowerCase().includes(needle))
    : all;
}

export async function listInterviews(
  client: HttpClient,
  application: ApplicationRecord,
): Promise<InterviewRecord[]> {
  const response = await client.fetchJson(API_PATHS.interviewCard, {
    method: 'POST',
    body: { applicationIds: [String(application.applicationId)] },
    timeoutMs: 30_000,
  });
  assertApiResponse(response, 'interviewCard');
  return parseInterviews(response, application);
}

export async function getMeetingSummary(
  client: HttpClient,
  applicationId: string | number,
  interviewId: string | number,
): Promise<MeetingSummaryRecord> {
  const response = await client.fetchJson(API_PATHS.meetingSummary, {
    method: 'POST',
    body: { applicationId, interviewId },
    timeoutMs: 60_000,
  });
  return parseMeetingSummary(response);
}
