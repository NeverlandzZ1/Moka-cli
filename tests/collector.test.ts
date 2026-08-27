import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IPage } from '@jackwener/opencli/types';
import type { CDPBridge } from '@jackwener/opencli/browser/cdp';
import { collectTranscripts, mergeCollections, writeCollection } from '../src/collector.js';
import type { CollectionResult, TranscriptRecord } from '../src/types.js';

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

describe('mergeCollections', () => {
  it('updates matching application/interview pairs and appends new interviews', () => {
    const existing = {
      generatedAt: 'old',
      source: 'old-source',
      records: [
        {
          applicationId: 101,
          interviewId: 9001,
          candidateName: '候选人甲',
          jobTitle: '旧岗位',
          interviewerNames: ['旧面试官'],
          transcriptStatus: 'available',
          transcript: '旧逐字稿',
        },
      ],
      errors: [],
      stats: { applications: 1, interviews: 1, transcriptsAvailable: 1, transcriptsUnavailable: 0, errors: 0 },
    } satisfies CollectionResult;
    const latest = {
      generatedAt: 'new',
      source: 'new-source',
      records: [
        {
          applicationId: '101',
          interviewId: '9001',
          candidateName: '候选人甲',
          jobTitle: '新岗位',
          interviewerNames: ['新面试官'],
          transcriptStatus: 'available',
          transcript: '新逐字稿',
        },
        {
          applicationId: 202,
          interviewId: 9002,
          candidateName: '候选人乙',
          jobTitle: '岗位乙',
          interviewerNames: [],
          transcriptStatus: 'not_available',
        },
      ],
      errors: [],
      stats: { applications: 2, interviews: 2, transcriptsAvailable: 1, transcriptsUnavailable: 1, errors: 0 },
    } satisfies CollectionResult;

    const merged = mergeCollections(existing, latest);
    expect(merged.generatedAt).toBe('new');
    expect(merged.source).toBe('new-source');
    expect(merged.records).toHaveLength(2);
    expect(merged.records[0]).toMatchObject({
      applicationId: '101',
      interviewId: '9001',
      jobTitle: '新岗位',
      transcript: '新逐字稿',
    });
    expect(merged.records[1]).toMatchObject({ applicationId: 202, interviewId: 9002 });
    expect(merged.stats).toEqual({
      applications: 2,
      interviews: 2,
      transcriptsAvailable: 1,
      transcriptsUnavailable: 1,
      errors: 0,
    });
  });

  it('incrementally updates an existing JSON file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'moka-merge-'));
    const outputPath = join(directory, 'moka-transcripts.json');
    const baseRecord: TranscriptRecord = {
      applicationId: 101,
      interviewId: 9001,
      candidateName: '候选人甲',
      jobTitle: '岗位甲',
      interviewerNames: [],
      transcriptStatus: 'available',
      transcript: '旧内容',
    };
    const base: CollectionResult = {
      generatedAt: 'old',
      source: 'source',
      records: [baseRecord],
      errors: [],
      stats: { applications: 1, interviews: 1, transcriptsAvailable: 1, transcriptsUnavailable: 0, errors: 0 },
    };
    const latest: CollectionResult = {
      ...base,
      generatedAt: 'new',
      records: [
        { ...baseRecord, transcript: '新内容' },
        { ...baseRecord, interviewId: 9002, transcript: '第二场' },
      ],
    };

    try {
      writeCollection(outputPath, base);
      const written = writeCollection(outputPath, latest);
      const stored = JSON.parse(readFileSync(outputPath, 'utf8')) as CollectionResult;
      expect(written.outputPath).toBe(outputPath);
      expect(stored.generatedAt).toBe('new');
      expect(stored.records).toHaveLength(2);
      expect(stored.records[0]!.transcript).toBe('新内容');
      expect(stored.records[1]!.interviewId).toBe(9002);
      expect(stored.stats.interviews).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('overwrites an existing JSON file with only the latest collection', () => {
    const directory = mkdtempSync(join(tmpdir(), 'moka-overwrite-'));
    const outputPath = join(directory, 'moka-transcripts.json');
    const oldRecord: TranscriptRecord = {
      applicationId: 101,
      interviewId: 9001,
      candidateName: '旧候选人',
      jobTitle: '旧岗位',
      interviewerNames: [],
      transcriptStatus: 'available',
      transcript: '旧内容',
    };
    const newRecord: TranscriptRecord = {
      applicationId: 202,
      interviewId: 9002,
      candidateName: '新候选人',
      jobTitle: '新岗位',
      interviewerNames: ['新面试官'],
      transcriptStatus: 'available',
      transcript: '新内容',
    };
    const base: CollectionResult = {
      generatedAt: 'old',
      source: 'source',
      records: [oldRecord],
      errors: [],
      stats: { applications: 1, interviews: 1, transcriptsAvailable: 1, transcriptsUnavailable: 0, errors: 0 },
    };
    const latest: CollectionResult = {
      generatedAt: 'new',
      source: 'source',
      records: [newRecord],
      errors: [],
      stats: { applications: 1, interviews: 1, transcriptsAvailable: 1, transcriptsUnavailable: 0, errors: 0 },
    };

    try {
      writeCollection(outputPath, base);
      const written = writeCollection(outputPath, latest, { overwrite: true });
      const stored = JSON.parse(readFileSync(outputPath, 'utf8')) as CollectionResult;
      expect(written.result).toEqual(latest);
      expect(stored.generatedAt).toBe('new');
      expect(stored.records).toEqual([newRecord]);
      expect(stored.records).not.toContainEqual(oldRecord);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
