import type {
  ApplicationRecord,
  Id,
  InterviewRecord,
  MeetingSummaryRecord,
} from './types.js';
import {
  asArray,
  asOptionalNumber,
  asString,
  isRecord,
  parsePossiblyEncodedJson,
} from './utils.js';

function readId(value: unknown): Id | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function applicationFromEntity(value: unknown): ApplicationRecord | undefined {
  if (!isRecord(value)) return undefined;
  const applicationId = readId(value.id);
  if (applicationId === undefined) return undefined;
  const job = isRecord(value.job) ? value.job : {};
  const jobId = readId(job.id);
  return {
    applicationId,
    candidateName: asString(value.name),
    jobTitle: asString(job.title),
    ...(jobId === undefined ? {} : { jobId }),
  };
}

export function parseApplications(response: unknown): ApplicationRecord[] {
  if (!isRecord(response) || !isRecord(response.data)) return [];
  const result = new Map<string, ApplicationRecord>();
  for (const row of asArray(response.data.rows)) {
    if (!isRecord(row)) continue;
    for (const entity of asArray(row.applicationEntities)) {
      const application = applicationFromEntity(entity);
      if (application) result.set(String(application.applicationId), application);
    }
  }
  return [...result.values()];
}

export function readPagination(response: unknown): {
  currentPage: number;
  pageSize: number;
  totalPage: number;
} {
  const data = isRecord(response) && isRecord(response.data) ? response.data : {};
  return {
    currentPage: asOptionalNumber(data.currentPage) ?? 1,
    pageSize: asOptionalNumber(data.pageSize) ?? 10,
    totalPage: Math.max(1, asOptionalNumber(data.totalPage) ?? 1),
  };
}

function interviewerNames(entity: Record<string, unknown>): string[] {
  const names = new Set<string>();
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

export function parseInterviews(
  response: unknown,
  fallback?: ApplicationRecord,
): InterviewRecord[] {
  if (!isRecord(response)) return [];
  const result = new Map<string, InterviewRecord>();
  for (const card of asArray(response.data)) {
    if (!isRecord(card)) continue;
    const parsedApplication = applicationFromEntity(card.application) ?? fallback;
    if (!parsedApplication) continue;
    for (const entityValue of asArray(card.entities)) {
      if (!isRecord(entityValue)) continue;
      const interviewId = readId(entityValue.id);
      if (interviewId === undefined) continue;
      const round = asOptionalNumber(entityValue.round);
      const roundName = asString(entityValue.roundName);
      const startTime = readId(entityValue.startTime);
      const record: InterviewRecord = {
        ...parsedApplication,
        interviewId,
        interviewerNames: interviewerNames(entityValue),
        ...(round === undefined ? {} : { round }),
        ...(roundName ? { roundName } : {}),
        ...(startTime === undefined ? {} : { startTime }),
      };
      result.set(`${String(record.applicationId)}:${String(interviewId)}`, record);
    }
  }
  return [...result.values()];
}

export function parseMeetingSummary(response: unknown): MeetingSummaryRecord {
  if (!isRecord(response)) {
    throw new Error('getMeetingSummary 返回了无法识别的响应');
  }
  const code = asOptionalNumber(response.code);
  const message = asString(response.msg);
  if (code === 103) {
    return {
      transcriptStatus: 'not_available',
      mokaCode: code,
      ...(message ? { mokaMessage: message } : {}),
    };
  }
  if (code !== undefined && code !== 0) {
    throw new Error(`Moka getMeetingSummary 失败：${message || `code=${code}`}`);
  }
  const data = isRecord(response.data) ? response.data : {};
  return {
    transcriptStatus: 'available',
    transcript: data.transcript,
    transcriptType: data.transcriptType,
    evaluationSummary: data.evaSummary,
    questionAnalysis: parsePossiblyEncodedJson(data.evaQuestionAnalysis),
    ...(code === undefined ? {} : { mokaCode: code }),
    ...(message ? { mokaMessage: message } : {}),
  };
}

