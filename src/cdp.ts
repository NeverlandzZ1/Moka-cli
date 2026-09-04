import { CDPBridge } from '@jackwener/opencli/browser/cdp';
import type { IPage } from '@jackwener/opencli/types';
import { BrowserConnectError, TimeoutError } from '@jackwener/opencli/errors';
import { API_PATHS, DEFAULT_CDP_PORT, MOKA_ORIGIN, MOKA_OVERVIEW_URL } from './constants.js';
import { isRecord, parseJsonObject } from './utils.js';
import type { JsonRecord } from './types.js';
import { writePayloadBundle } from './payload-store.js';

export function endpointForPort(port = DEFAULT_CDP_PORT): string {
  return `http://127.0.0.1:${port}`;
}

export async function withMokaPage<T>(
  port: number,
  operation: (page: IPage, bridge: CDPBridge) => Promise<T>,
): Promise<T> {
  const bridge = new CDPBridge();
  const previousTarget = process.env.OPENCLI_CDP_TARGET;
  process.env.OPENCLI_CDP_TARGET = 'app.mokahr.com';
  try {
    const page = await bridge.connect({ cdpEndpoint: endpointForPort(port), timeout: 10 });
    const currentUrl = await page.getCurrentUrl?.();
    if (!currentUrl?.startsWith(MOKA_ORIGIN)) {
      await page.goto(MOKA_OVERVIEW_URL, { waitUntil: 'none' });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return await operation(page, bridge);
  } catch (error) {
    if (error instanceof BrowserConnectError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/ECONNREFUSED|CDP endpoint|No inspectable targets|fetch failed/i.test(message)) {
      throw new BrowserConnectError(
        `无法连接 Moka 专用 Chrome（端口 ${port}）`,
        '请先运行 opencli moka login，或确认 Chrome 没有被关闭。',
        'daemon-not-running',
      );
    }
    throw error;
  } finally {
    await bridge.close().catch(() => undefined);
    if (previousTarget === undefined) delete process.env.OPENCLI_CDP_TARGET;
    else process.env.OPENCLI_CDP_TARGET = previousTarget;
  }
}

export interface LoginProbe {
  browser: 'connected';
  mokaLogin: 'authenticated' | 'waiting_for_user';
  pageUrl: string;
  message: string;
}

export async function probeMokaLogin(page: IPage): Promise<LoginProbe> {
  const probe = await page.evaluate(async (path: string) => {
    const result: {
      pageUrl: string;
      status?: number;
      contentType?: string;
      json?: unknown;
      error?: string;
    } = { pageUrl: window.location.href };
    try {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationIds: [] }),
      });
      result.status = response.status;
      result.contentType = response.headers.get('content-type') || '';
      const text = await response.text();
      if (result.contentType.includes('application/json')) {
        try { result.json = JSON.parse(text); } catch { result.error = 'invalid-json'; }
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    return result;
  }, API_PATHS.interviewCard);

  const pageUrl = typeof probe.pageUrl === 'string' ? probe.pageUrl : '';
  const pathSuggestsLogin = /login|signin|passport/i.test(pageUrl);
  const json = isRecord(probe.json) ? probe.json : undefined;
  const code = json && typeof json.code === 'number' ? json.code : undefined;
  const authenticated = !pathSuggestsLogin
    && probe.status === 200
    && Boolean(json)
    && code !== 401
    && code !== 403;

  return authenticated
    ? {
        browser: 'connected',
        mokaLogin: 'authenticated',
        pageUrl,
        message: 'Moka 登录成功，可以开始获取面试记录',
      }
    : {
        browser: 'connected',
        mokaLogin: 'waiting_for_user',
        pageUrl,
        message: '请在打开的 Chrome 窗口中完成 Moka 登录',
      };
}

interface RequestWillBeSentEvent {
  request?: {
    url?: string;
    method?: string;
    postData?: string;
  };
}

const INTERVIEW_LIST_PAYLOAD_CACHE_KEY = '__opencli_moka_interview_list_payload__';

export async function discoverInterviewListPayload(
  page: IPage,
  bridge: CDPBridge,
  timeoutSeconds = 15,
): Promise<JsonRecord> {
  const cached = await page.evaluate((key: string) => sessionStorage.getItem(key), INTERVIEW_LIST_PAYLOAD_CACHE_KEY);
  if (cached) return parseJsonObject(cached, '缓存的 Moka interviewList 请求体');

  await bridge.send('Network.enable');
  let handler: ((params: unknown) => void) | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const captured = new Promise<JsonRecord>((resolve, reject) => {
    handler = (params: unknown) => {
      const event = params as RequestWillBeSentEvent;
      const request = event.request;
      if (
        request?.method === 'POST'
        && request.url?.includes(API_PATHS.interviewList)
        && request.postData
      ) {
        try {
          resolve(parseJsonObject(request.postData, 'Moka interviewList 请求体'));
        } catch {
          // Ignore malformed candidates and keep waiting for the real request.
        }
      }
    };
    bridge.on('Network.requestWillBeSent', handler);
    timeoutHandle = setTimeout(
      () => reject(new Error('INTERVIEW_LIST_CAPTURE_TIMEOUT')),
      timeoutSeconds * 1_000,
    );
  });

  try {
    const trigger = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const button = buttons.find((candidate) => (
        candidate.classList.contains('table-load-more')
        || candidate.textContent?.trim() === '加载更多'
      ));
      if (!button || button.hasAttribute('disabled')) {
        return { clicked: false, reason: 'load-more-not-found' };
      }
      button.click();
      return { clicked: true, reason: 'load-more' };
    });
    if (!trigger.clicked) {
      throw new Error(
        '未找到可触发 interviewList 的“加载更多”按钮，且当前标签页没有缓存请求体。请在总览页调整任意筛选条件后立即重试。',
      );
    }
    try {
      const payload = await captured;
      await page.evaluate(
        (key: string, value: string) => sessionStorage.setItem(key, value),
        INTERVIEW_LIST_PAYLOAD_CACHE_KEY,
        JSON.stringify(payload),
      );
      try {
        writePayloadBundle(payload);
      } catch {
        // Persistence is best-effort; keep the freshly captured payload usable in memory.
      }
      return payload;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'INTERVIEW_LIST_CAPTURE_TIMEOUT') throw error;
      const diagnostics = await page.evaluate(() => ({
        url: window.location.href,
        title: document.title,
        readyState: document.readyState,
        bodyLength: document.body?.innerText?.length ?? 0,
        matchingResources: performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .filter((url) => url.includes('interviewList')),
      })).catch(() => undefined);
      if (diagnostics && /login|signin|passport/i.test(diagnostics.url)) {
        throw new BrowserConnectError(
          '临时标签页被 Moka 重定向到登录页',
          '请在同一个 CDP Chrome 中重新登录 Moka，然后运行 opencli moka status。',
          'command-failed',
        );
      }
      const detail = diagnostics
        ? `页面状态：${diagnostics.readyState}，标题：${diagnostics.title || '无'}，正文长度：${diagnostics.bodyLength}`
        : '无法读取临时页面状态';
      throw new TimeoutError(
        `点击“加载更多”后捕获 Moka interviewList 请求（${detail}）`,
        timeoutSeconds,
        '请确认该账号能正常打开“面试”总览；也可从 DevTools 复制 Request Payload 后通过 --request-json 调试。',
      );
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (handler) bridge.off('Network.requestWillBeSent', handler);
  }
}
