import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { IPage } from '@jackwener/opencli/types';
import type { CDPBridge } from '@jackwener/opencli/browser/cdp';
import type { CollectionResult, JsonRecord, TranscriptRecord } from './types.js';
import { getMeetingSummary, listApplications, listInterviews } from './moka-api.js';
import { errorMessage } from './utils.js';

export interface CollectOptions {
  requestBody?: JsonRecord;
  candidateName?: string;
}

export async function collectTranscripts(
  page: IPage,
  bridge: CDPBridge,
  options: CollectOptions = {},
): Promise<CollectionResult> {
  const applications = await listApplications(page, bridge, options);
  const records: CollectionResult['records'] = [];
  const errors: CollectionResult['errors'] = [];
  let interviewCount = 0;

  for (const application of applications) {
    let interviews;
    try {
      interviews = await listInterviews(page, application);
    } catch (error) {
      errors.push({
        applicationId: application.applicationId,
        stage: 'interviewCard',
        message: errorMessage(error),
      });
      continue;
    }
    interviewCount += interviews.length;
    for (const interview of interviews) {
      try {
        const summary = await getMeetingSummary(
          page,
          interview.applicationId,
          interview.interviewId,
        );
        records.push({ ...interview, ...summary });
      } catch (error) {
        errors.push({
          applicationId: interview.applicationId,
          interviewId: interview.interviewId,
          stage: 'meetingSummary',
          message: errorMessage(error),
        });
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    source: 'https://app.mokahr.com/interviews/overview',
    records,
    errors,
    stats: {
      applications: applications.length,
      interviews: interviewCount,
      transcriptsAvailable: records.filter((item) => item.transcriptStatus === 'available').length,
      transcriptsUnavailable: records.filter((item) => item.transcriptStatus === 'not_available').length,
      errors: errors.length,
    },
  };
}

function recordKey(record: Pick<TranscriptRecord, 'applicationId' | 'interviewId'>): string {
  return `${String(record.applicationId)}:${String(record.interviewId)}`;
}

function readExistingCollection(path: string): CollectionResult | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`已有导出文件不是有效 JSON，已停止写入以避免覆盖：${path}（${errorMessage(error)}）`);
  }
  if (
    typeof parsed !== 'object'
    || parsed === null
    || !Array.isArray((parsed as Partial<CollectionResult>).records)
  ) {
    throw new Error(`已有导出文件缺少 records 数组，已停止写入以避免覆盖：${path}`);
  }
  return parsed as CollectionResult;
}

export function mergeCollections(
  existing: CollectionResult | undefined,
  latest: CollectionResult,
): CollectionResult {
  const records = new Map<string, TranscriptRecord>();
  for (const record of existing?.records ?? []) records.set(recordKey(record), record);
  // Map.set updates an existing pair without moving it; unseen interviews append.
  for (const record of latest.records) records.set(recordKey(record), record);
  const mergedRecords = [...records.values()];
  const applicationIds = new Set(mergedRecords.map((record) => String(record.applicationId)));
  for (const error of latest.errors) {
    if (error.applicationId !== undefined) applicationIds.add(String(error.applicationId));
  }
  return {
    generatedAt: latest.generatedAt,
    source: latest.source,
    records: mergedRecords,
    errors: latest.errors,
    stats: {
      applications: applicationIds.size,
      interviews: mergedRecords.length,
      transcriptsAvailable: mergedRecords.filter((item) => item.transcriptStatus === 'available').length,
      transcriptsUnavailable: mergedRecords.filter((item) => item.transcriptStatus === 'not_available').length,
      errors: latest.errors.length,
    },
  };
}

export function writeCollection(
  outputPath: string,
  latest: CollectionResult,
  options: { overwrite?: boolean } = {},
): { outputPath: string; result: CollectionResult } {
  const absolutePath = resolve(outputPath);
  const parentDirectory = dirname(absolutePath);
  // Windows drive roots (D:\) and POSIX root (/) already exist and should not
  // be passed to mkdirSync, which can raise EPERM on some Windows setups.
  if (!existsSync(parentDirectory)) mkdirSync(parentDirectory, { recursive: true });
  const result = options.overwrite
    ? latest
    : mergeCollections(readExistingCollection(absolutePath), latest);
  writeFileSync(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return { outputPath: absolutePath, result };
}
