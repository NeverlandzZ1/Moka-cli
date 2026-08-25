import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { IPage } from '@jackwener/opencli/types';
import type { CDPBridge } from '@jackwener/opencli/browser/cdp';
import type { CollectionResult, JsonRecord } from './types.js';
import { getMeetingSummary, listApplications, listInterviews } from './moka-api.js';
import { errorMessage } from './utils.js';

export interface CollectOptions {
  requestBody?: JsonRecord;
  maxPages?: number;
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

export function writeCollection(outputPath: string, result: CollectionResult): string {
  const absolutePath = resolve(outputPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return absolutePath;
}
