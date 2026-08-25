import type { IPage } from '@jackwener/opencli/types';
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { API_PATHS } from './constants.js';
import { discoverInterviewListPayload } from './cdp.js';
import type { CDPBridge } from '@jackwener/opencli/browser/cdp';
import type {
  ApplicationRecord,
  InterviewRecord,
  JsonRecord,
  MeetingSummaryRecord,
} from './types.js';
import { parseApplications, parseInterviews, parseMeetingSummary, readPagination } from './parsers.js';
import { asString, isRecord } from './utils.js';

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
}

export async function listApplications(
  page: IPage,
  bridge: CDPBridge,
  options: ListApplicationsOptions = {},
): Promise<ApplicationRecord[]> {
  const capturedBody = options.requestBody
    ? { ...options.requestBody }
    : await discoverInterviewListPayload(page, bridge);
  const queryBodies = options.requestBody
    ? [capturedBody]
    : [defaultInterviewListBody(capturedBody)];
  const records = new Map<string, ApplicationRecord>();
  for (const baseBody of queryBodies) {
    let currentPage = 1;
    let totalPage = 1;
    do {
      const response = await page.fetchJson(API_PATHS.interviewList, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
  page: IPage,
  application: ApplicationRecord,
): Promise<InterviewRecord[]> {
  const response = await page.fetchJson(API_PATHS.interviewCard, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { applicationIds: [String(application.applicationId)] },
    timeoutMs: 30_000,
  });
  assertApiResponse(response, 'interviewCard');
  return parseInterviews(response, application);
}

export async function getMeetingSummary(
  page: IPage,
  applicationId: string | number,
  interviewId: string | number,
): Promise<MeetingSummaryRecord> {
  const response = await page.fetchJson(API_PATHS.meetingSummary, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { applicationId, interviewId },
    timeoutMs: 60_000,
  });
  return parseMeetingSummary(response);
}
