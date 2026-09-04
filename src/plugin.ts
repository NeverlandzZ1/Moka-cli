import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { API_PATHS, DEFAULT_CDP_PORT, MOKA_OVERVIEW_URL } from './constants.js';
import { ensureChromeWithCdp } from './chrome.js';
import { probeMokaLogin, withMokaPage } from './cdp.js';
import { collectTranscripts, writeCollection } from './collector.js';
import { getMeetingSummary, listApplications, listInterviews, setHireMode } from './moka-api.js';
import { parseJsonObject } from './utils.js';
import { dumpCookiesFromBridge } from './cookie-store.js';
import { createHttpClient, type HttpClient } from './http-client.js';
import type { CDPBridge } from '@jackwener/opencli/browser/cdp';
import type { IPage } from '@jackwener/opencli/types';
import type { ApplicationRecord, HireMode, Id, JsonRecord } from './types.js';

const commonPortArg = {
  name: 'port',
  type: 'int',
  default: DEFAULT_CDP_PORT,
  help: 'Chrome CDP 端口，默认 9222',
};

const noCdpArg = {
  name: 'offline',
  type: 'boolean',
  default: false,
  help: '跳过 CDP Chrome，直接用本地缓存的登录态发 HTTP 请求（无 Chrome 场景）',
};

function intArg(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new ArgumentError('port 必须是正整数');
  return parsed;
}

function idArg(value: unknown, name: string): Id {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new ArgumentError(`${name} 不能为空`);
}

function optionalRequestBody(value: unknown): JsonRecord | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return parseJsonObject(value, '--request-json');
}

function hireModeArg(value: unknown): HireMode {
  if (typeof value !== 'string') throw new ArgumentError('mode 必须是 campus/social 或校招/社招');
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized === 'campus' || normalized === '校招' || normalized === '1') return 'campus';
  if (normalized === 'social' || normalized === '社招' || normalized === '2') return 'social';
  throw new ArgumentError(`不支持的 Moka 招聘模式: ${value}。请使用 campus 或 social`);
}

function collectionOptions(kwargs: Record<string, unknown>): {
  candidateName?: string;
  requestBody?: JsonRecord;
} {
  const candidateName = typeof kwargs.candidate === 'string' && kwargs.candidate.trim()
    ? kwargs.candidate.trim()
    : undefined;
  const requestBody = optionalRequestBody(kwargs.requestJson);
  return {
    ...(candidateName ? { candidateName } : {}),
    ...(requestBody ? { requestBody } : {}),
  };
}

async function withHttpClient<T>(
  kwargs: Record<string, unknown>,
  fn: (client: HttpClient, ctx: { page?: IPage; bridge?: CDPBridge }) => Promise<T>,
): Promise<T> {
  const noCdp = Boolean(kwargs['offline']);
  if (noCdp) {
    const client = createHttpClient();
    return fn(client, {});
  }
  return withMokaPage(intArg(kwargs.port, DEFAULT_CDP_PORT), async (page, bridge) => {
    await dumpCookiesFromBridge(bridge).catch(() => undefined);
    const client = createHttpClient();
    return fn(client, { page, bridge });
  });
}

cli({
  site: 'moka',
  name: 'login',
  description: '打开 Moka 专用 Chrome 登录窗口',
  access: 'read',
  example: 'opencli moka login -f json',
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: 'json',
  args: [
    commonPortArg,
    { name: 'chrome-path', valueRequired: true, help: 'chrome.exe 的完整路径' },
    { name: 'profile-dir', valueRequired: true, help: '专用 Chrome 用户目录' },
  ],
  columns: ['browser', 'mokaLogin', 'message', 'pageUrl'],
  func: async (kwargs) => {
    const port = intArg(kwargs.port, DEFAULT_CDP_PORT);
    const launch = await ensureChromeWithCdp({
      port,
      url: MOKA_OVERVIEW_URL,
      ...(typeof kwargs.chromePath === 'string' ? { chromePath: kwargs.chromePath } : {}),
      ...(typeof kwargs.profileDir === 'string' ? { profileDir: kwargs.profileDir } : {}),
    });
    const status = await withMokaPage(port, async (page, bridge) => {
      const probe = await probeMokaLogin(page);
      if (probe.mokaLogin === 'authenticated') {
        await dumpCookiesFromBridge(bridge).catch(() => undefined);
      }
      return probe;
    });
    return [{
      ...status,
      launched: launch.launched,
      reusedMokaTab: launch.reusedMokaTab,
      refreshedAfterLaunch: launch.refreshedAfterLaunch,
      cdpEndpoint: launch.endpoint,
      profileDir: launch.profileDir,
    }];
  },
});

cli({
  site: 'moka',
  name: 'status',
  description: '检查 Moka 专用 Chrome 和登录状态',
  access: 'read',
  example: 'opencli moka status -f json',
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: 'json',
  args: [commonPortArg],
  columns: ['browser', 'mokaLogin', 'message', 'pageUrl'],
  func: async (kwargs) => withMokaPage(
    intArg(kwargs.port, DEFAULT_CDP_PORT),
    async (page, bridge) => {
      const probe = await probeMokaLogin(page);
      if (probe.mokaLogin === 'authenticated') {
        await dumpCookiesFromBridge(bridge).catch(() => undefined);
      }
      return [probe];
    },
  ),
});

cli({
  site: 'moka',
  name: 'mode',
  description: '切换 Moka 当前招聘模式（校招/社招）',
  access: 'write',
  example: 'opencli moka mode campus -f json',
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: 'json',
  args: [
    { name: 'mode', positional: true, required: true, help: 'campus（校招）或 social（社招）' },
    commonPortArg,
  ],
  columns: ['mode', 'modeLabel', 'currentHireMode'],
  func: async (kwargs) => withMokaPage(
    intArg(kwargs.port, DEFAULT_CDP_PORT),
    async (page, bridge) => {
      const result = await setHireMode(page, bridge, hireModeArg(kwargs.mode));
      await dumpCookiesFromBridge(bridge).catch(() => undefined);
      return [result];
    },
  ),
});

cli({
  site: 'moka',
  name: 'applications',
  description: '列出候选人的应聘记录和岗位',
  access: 'read',
  example: 'opencli moka applications --candidate "候选人姓名" -f json',
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: 'json',
  args: [
    commonPortArg,
    noCdpArg,
    { name: 'candidate', valueRequired: true, help: '按候选人姓名筛选' },
    { name: 'request-json', valueRequired: true, help: '高级用法：覆盖 interviewList 请求体 JSON' },
  ],
  columns: ['applicationId', 'candidateName', 'jobTitle', 'overviewStartTimeIso'],
  func: async (kwargs) => withHttpClient(kwargs, async (client, ctx) => listApplications(client, {
    ...collectionOptions(kwargs),
    ...(ctx.page ? { page: ctx.page } : {}),
    ...(ctx.bridge ? { bridge: ctx.bridge } : {}),
  })),
});

cli({
  site: 'moka',
  name: 'interviews',
  description: '列出一个应聘记录下的全部面试和面试官',
  access: 'read',
  example: 'opencli moka interviews 123456789 -f json',
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: 'json',
  args: [
    { name: 'application-id', positional: true, required: true, help: '应聘记录 ID' },
    commonPortArg,
    noCdpArg,
  ],
  columns: ['applicationId', 'interviewId', 'candidateName', 'jobTitle', 'interviewerNames', 'roundName', 'startTime'],
  func: async (kwargs) => withHttpClient(kwargs, async (client) => {
    const application: ApplicationRecord = {
      applicationId: idArg(kwargs['application-id'], 'application-id'),
      candidateName: '',
      jobTitle: '',
    };
    return listInterviews(client, application);
  }),
});

cli({
  site: 'moka',
  name: 'transcript',
  description: '读取一场面试的逐字稿和 AI 总结',
  access: 'read',
  example: 'opencli moka transcript 123456789 98765432 -f json',
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: 'json',
  args: [
    { name: 'application-id', positional: true, required: true, help: '应聘记录 ID' },
    { name: 'interview-id', positional: true, required: true, help: '面试 ID' },
    commonPortArg,
    noCdpArg,
  ],
  func: async (kwargs) => withHttpClient(kwargs, async (client) => {
    const applicationId = idArg(kwargs['application-id'], 'application-id');
    const interviewId = idArg(kwargs['interview-id'], 'interview-id');
    return [{
      applicationId,
      interviewId,
      ...await getMeetingSummary(client, applicationId, interviewId),
    }];
  }),
});

cli({
  site: 'moka',
  name: 'export-transcripts',
  aliases: ['export'],
  description: '导出候选人、岗位、面试官和全部面试逐字稿',
  access: 'read',
  example: 'opencli moka export-transcripts --output ./moka-transcripts.json -f json',
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: 'json',
  args: [
    commonPortArg,
    noCdpArg,
    { name: 'candidate', valueRequired: true, help: '按候选人姓名筛选' },
    { name: 'output', valueRequired: true, help: 'JSON 文件输出路径' },
    { name: 'overwrite', type: 'boolean', default: false, help: '只保存本次结果，直接覆盖同名 JSON 文件' },
    { name: 'request-json', valueRequired: true, help: '高级用法：覆盖 interviewList 请求体 JSON' },
  ],
  func: async (kwargs) => withHttpClient(kwargs, async (client, ctx) => {
    const result = await collectTranscripts(client, {
      ...collectionOptions(kwargs),
      ...(ctx.page ? { page: ctx.page } : {}),
      ...(ctx.bridge ? { bridge: ctx.bridge } : {}),
    });
    const written = typeof kwargs.output === 'string' && kwargs.output.trim()
      ? writeCollection(kwargs.output.trim(), result, { overwrite: Boolean(kwargs.overwrite) })
      : undefined;
    return written
      ? { ...written.result, outputPath: written.outputPath }
      : result;
  }),
});

export const mokaApiPaths = API_PATHS;
