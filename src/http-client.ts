import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { AUTH_API_PATHS, MOKA_ORIGIN, MOKA_PASSPORT_ORIGIN } from './constants.js';
import {
  cookieHeaderFor,
  defaultCookiePath,
  mergeSetCookieHeaders,
  readCookieBundle,
  writeCookieBundle,
  type CookieBundle,
} from './cookie-store.js';
import type { JsonRecord } from './types.js';
import { isRecord } from './utils.js';

export interface HttpFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface HttpClient {
  fetchJson(path: string, options?: HttpFetchOptions): Promise<unknown>;
}

const DEFAULT_HEADERS: Record<string, string> = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'origin': MOKA_ORIGIN,
  'referer': `${MOKA_ORIGIN}/interviews/overview`,
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
};

const PASSPORT_HEADERS: Record<string, string> = {
  ...DEFAULT_HEADERS,
  'origin': MOKA_ORIGIN,
  'referer': `${MOKA_PASSPORT_ORIGIN}/passport/unified.html`,
};

interface JsonResponse {
  response: Response;
  text: string;
  json?: unknown;
}

export interface HttpClientOptions {
  cookiePath?: string;
  bundle?: CookieBundle;
}

function collectSetCookieHeaders(headers: Headers): string[] {
  const rawGetter = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof rawGetter === 'function') return rawGetter.call(headers);
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const cookiePath = options.cookiePath ?? defaultCookiePath();
  let bundle = options.bundle ?? readCookieBundle(cookiePath);
  if (!bundle || bundle.cookies.length === 0) {
    throw new AuthRequiredError(
      'app.mokahr.com',
      '本地没有可用的 Moka 登录态。请先运行 opencli moka login 让 CDP Chrome 登录一次。',
    );
  }

  const passportHost = new URL(MOKA_PASSPORT_ORIGIN).host;

  async function requestJson(
    origin: string,
    path: string,
    opts: HttpFetchOptions,
    baseHeaders: Record<string, string>,
  ): Promise<JsonResponse> {
    const method = opts.method ?? 'POST';
    const requestHost = new URL(origin).host;
    const cookieHeader = cookieHeaderFor(requestHost, bundle!);
    if (!cookieHeader) {
      throw new AuthRequiredError(
        requestHost,
        `本地没有 ${requestHost} 的可用 cookie。请更换包含 Moka Passport 登录态的 moka-cookies.json，或重新运行 opencli moka login。`,
      );
    }
    const headers: Record<string, string> = {
      ...baseHeaders,
      ...(opts.headers ?? {}),
      cookie: cookieHeader,
    };
    if (opts.body !== undefined && !headers['content-type']) {
      headers['content-type'] = 'application/json';
    }

    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
        redirect: 'manual',
      };
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
      response = await fetch(`${origin}${path}`, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CommandExecutionError(`Moka ${path} 请求失败: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    const setCookies = collectSetCookieHeaders(response.headers);
    if (setCookies.length > 0) {
      bundle = mergeSetCookieHeaders(bundle, setCookies, requestHost);
      writeCookieBundle(bundle, cookiePath);
    }

    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    let json: unknown;
    if (text && contentType.includes('application/json')) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new CommandExecutionError(`Moka ${path} 返回了非 JSON 响应`);
      }
    } else if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // Some Moka endpoints (like updateCurrentHireMode) reply with plain text on success.
      }
    }

    return { response, text, ...(json === undefined ? {} : { json }) };
  }

  function isLoginRequired(result: JsonResponse): boolean {
    if (result.response.status === 401 || result.response.status === 403) return true;
    if (result.response.status >= 300 && result.response.status < 400) return true;
    if (!isRecord(result.json)) return false;
    if (result.json.code === 401 || result.json.code === 403) return true;
    const message = typeof result.json.msg === 'string' ? result.json.msg : '';
    return /需要登录|请先登录|未登录|登录(?:状态|态)?(?:已)?失效|unauthorized|not logged/i.test(message);
  }

  function assertSuccessfulResponse(result: JsonResponse, path: string): unknown {
    if (isLoginRequired(result)) {
      throw new AuthRequiredError(
        'app.mokahr.com',
        'Moka 应用会话和 Passport 登录态均无法恢复。请更换 moka-cookies.json，或重新运行 opencli moka login。',
      );
    }
    if (!result.response.ok) {
      const detail = isRecord(result.json) && typeof result.json.msg === 'string'
        ? result.json.msg
        : (result.text.trim() || result.response.statusText);
      throw new CommandExecutionError(`Moka ${path} 失败: HTTP ${result.response.status} ${detail}`);
    }
    return result.json ?? {};
  }

  async function refreshAppSession(): Promise<void> {
    const passportCookies = cookieHeaderFor(passportHost, bundle!);
    if (!passportCookies) {
      throw new AuthRequiredError(
        passportHost,
        'cookie 文件中没有可用的 Moka Passport 登录态，无法在无 CDP 模式下静默续期。',
      );
    }

    const ticketResult = await requestJson(
      MOKA_PASSPORT_ORIGIN,
      AUTH_API_PATHS.passportTicket,
      { method: 'POST', body: { bus: 10, isMobile: false } },
      PASSPORT_HEADERS,
    );
    const ticketData = isRecord(ticketResult.json) && isRecord(ticketResult.json.data)
      ? ticketResult.json.data
      : undefined;
    const ticket = ticketData && typeof ticketData.ticket === 'string' ? ticketData.ticket : '';
    if (!ticketResult.response.ok || !ticket) {
      const ticketCode = isRecord(ticketResult.json) && typeof ticketResult.json.code === 'number'
        ? ticketResult.json.code
        : undefined;
      const detail = ticketResult.response.ok && ticketCode === 0
        ? '接口返回成功但没有 ticket，通常表示这份 Passport Cookie 已被退出登录或被服务端注销'
        : (isRecord(ticketResult.json) && typeof ticketResult.json.msg === 'string'
            ? ticketResult.json.msg
            : `HTTP ${ticketResult.response.status}`);
      throw new AuthRequiredError(
        passportHost,
        `Moka Passport 登录态无法换取 ticket：${detail}。请更换 moka-cookies.json，或重新运行 opencli moka login。`,
      );
    }

    const loginResult = await requestJson(
      MOKA_ORIGIN,
      AUTH_API_PATHS.unifiedLogin,
      { method: 'POST', body: { ticket, bus: 10, isMobile: false } },
      DEFAULT_HEADERS,
    );
    const loginCode = isRecord(loginResult.json) && typeof loginResult.json.code === 'number'
      ? loginResult.json.code
      : undefined;
    if (!loginResult.response.ok || (loginCode !== undefined && loginCode !== 0)) {
      const detail = isRecord(loginResult.json) && typeof loginResult.json.msg === 'string'
        ? loginResult.json.msg
        : `HTTP ${loginResult.response.status}`;
      throw new AuthRequiredError(
        'app.mokahr.com',
        `Moka 静默登录失败：${detail}。请更换 moka-cookies.json，或重新运行 opencli moka login。`,
      );
    }
  }

  async function fetchJson(path: string, opts: HttpFetchOptions = {}): Promise<unknown> {
    let result = await requestJson(MOKA_ORIGIN, path, opts, DEFAULT_HEADERS);
    if (isLoginRequired(result)) {
      await refreshAppSession();
      result = await requestJson(MOKA_ORIGIN, path, opts, DEFAULT_HEADERS);
    }
    return assertSuccessfulResponse(result, path);
  }

  return { fetchJson };
}
