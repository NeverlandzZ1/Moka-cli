import { describe, expect, it } from 'vitest';
import type { IPage } from '@jackwener/opencli/types';
import type { CDPBridge } from '@jackwener/opencli/browser/cdp';
import { collectTranscripts } from '../src/collector.js';

describe('collectTranscripts', () => {
  it('joins application, interview and transcript data', async () => {
    const page = {
      fetchJson: async (url: string, options: { body?: unknown }) => {
        if (url.endsWith('/interviewList')) {
          return {
            code: 0,
            data: {
              currentPage: 1,
              pageSize: 10,
              totalPage: 1,
              rows: [{
                applicationEntities: [{
                  id: 101,
                  name: '候选人甲',
                  job: { title: '产品经理' },
                }],
              }],
            },
          };
        }
        if (url.endsWith('/interviewCard')) {
          expect(options.body).toEqual({ applicationIds: ['101'] });
          return {
            code: 0,
            data: [{
              application: { id: 101, name: '候选人甲', job: { title: '产品经理' } },
              entities: [{
                id: 9001,
                roundName: '一面',
                interviewerFeedbacks: [{ interviewer: { name: '面试官 A' } }],
              }],
            }],
          };
        }
        if (url.endsWith('/getMeetingSummary')) {
          expect(options.body).toEqual({ applicationId: 101, interviewId: 9001 });
          return { code: 0, data: { transcript: '逐字稿' } };
        }
        throw new Error(`unexpected URL: ${url}`);
      },
    } as unknown as IPage;

    const result = await collectTranscripts(page, {} as CDPBridge, {
      requestBody: { currentPage: 1, pageSize: 10 },
    });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      applicationId: 101,
      interviewId: 9001,
      candidateName: '候选人甲',
      jobTitle: '产品经理',
      interviewerNames: ['面试官 A'],
      transcript: '逐字稿',
      transcriptStatus: 'available',
    });
    expect(result.stats).toEqual({
      applications: 1,
      interviews: 1,
      transcriptsAvailable: 1,
      transcriptsUnavailable: 0,
      errors: 0,
    });
  });
});
