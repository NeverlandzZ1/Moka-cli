import { describe, expect, it } from 'vitest';
import { parseApplications, parseInterviews, parseMeetingSummary, readPagination } from '../src/parsers.js';

describe('Moka response parsers', () => {
  it('extracts and deduplicates applications', () => {
    const response = {
      data: {
        currentPage: 1,
        pageSize: 10,
        totalPage: 3,
        rows: [
          {
            applicationEntities: [
              { id: 101, name: '候选人甲', job: { id: 'job-1', title: '产品经理' } },
              { id: 101, name: '候选人甲', job: { id: 'job-1', title: '产品经理' } },
            ],
          },
        ],
      },
    };

    expect(parseApplications(response)).toEqual([
      {
        applicationId: 101,
        candidateName: '候选人甲',
        jobTitle: '产品经理',
        jobId: 'job-1',
      },
    ]);
    expect(readPagination(response)).toEqual({ currentPage: 1, pageSize: 10, totalPage: 3 });
  });

  it('orders applications by restinterviews instead of the lookup array', () => {
    const response = {
      data: {
        rows: [{
          applicationEntities: [
            { id: 101, name: '候选人甲', job: { title: '岗位甲' } },
            { id: 202, name: '候选人乙', job: { title: '岗位乙' } },
          ],
          restinterviews: [
            { id: 9002, applicationIds: [202], startTime: 1787562000000 },
            { id: 9001, applicationIds: [101], startTime: 1787538600000 },
          ],
        }],
      },
    };

    expect(parseApplications(response)).toEqual([
      {
        applicationId: 202,
        candidateName: '候选人乙',
        jobTitle: '岗位乙',
        overviewInterviewId: 9002,
        overviewStartTime: 1787562000000,
        overviewStartTimeIso: '2026-08-24T09:00:00.000Z',
      },
      {
        applicationId: 101,
        candidateName: '候选人甲',
        jobTitle: '岗位甲',
        overviewInterviewId: 9001,
        overviewStartTime: 1787538600000,
        overviewStartTimeIso: '2026-08-24T02:30:00.000Z',
      },
    ]);
  });

  it('uses entities[].id as interviewId and keeps all interviewers', () => {
    const response = {
      data: [
        {
          application: { id: 101, name: '候选人甲', job: { title: '产品经理' } },
          entities: [
            {
              id: 9001,
              groupInterviewId: 123,
              round: 2,
              roundName: '二面',
              startTime: 1780000000000,
              interviewerFeedbacks: [
                { interviewer: { id: 1, name: '面试官 A' } },
                { interviewer: { id: 2, name: '面试官 B' } },
                { interviewer: { id: 1, name: '面试官 A' } },
              ],
            },
          ],
        },
      ],
    };

    expect(parseInterviews(response)).toEqual([
      {
        applicationId: 101,
        candidateName: '候选人甲',
        jobTitle: '产品经理',
        interviewId: 9001,
        interviewerNames: ['面试官 A', '面试官 B'],
        round: 2,
        roundName: '二面',
        startTime: 1780000000000,
      },
    ]);
  });

  it('parses available and unavailable meeting summaries', () => {
    expect(parseMeetingSummary({
      code: 0,
      msg: '成功',
      data: {
        transcript: '逐字稿',
        transcriptType: 1,
        evaSummary: '总结',
        evaQuestionAnalysis: '{"result":[{"question":"问题"}]}',
      },
    })).toEqual({
      transcriptStatus: 'available',
      transcript: '逐字稿',
      transcriptType: 1,
      evaluationSummary: '总结',
      questionAnalysis: { result: [{ question: '问题' }] },
      mokaCode: 0,
      mokaMessage: '成功',
    });

    expect(parseMeetingSummary({ code: 103, msg: '数据不存在' })).toEqual({
      transcriptStatus: 'not_available',
      mokaCode: 103,
      mokaMessage: '数据不存在',
    });
  });
});
