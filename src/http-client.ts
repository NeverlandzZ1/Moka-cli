import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { MOKA_ORIGIN } from './constants.js';
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

  const host = new URL(MOKA_ORIGIN).host;

  async function fetchJson(path: string, opts: HttpFetchOptions = {}): Promise<unknown> {
    const method = opts.method ?? 'POST';
    const cookieHeader = cookieHeaderFor(host, bundle!);
    if (!cookieHeader) {
      throw new AuthRequiredError(
        'app.mokahr.com',
        '本地 Moka cookie 已全部过期,请重新运行 opencli moka login 以刷新登录态。',
      );
    }
    const headers: Record<string, string> = {
      ...DEFAULT_HEADERS,
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
      response = await fetch(`${MOKA_ORIGIN}${path}`, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CommandExecutionError(`Moka ${path} 请求失败: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    const setCookies = collectSetCookieHeaders(response.headers);
    if (setCookies.length > 0) {
      bundle = mergeSetCookieHeaders(bundle, setCookies, host);
      writeCookieBundle(bundle, cookiePath);
    }

    if (response.status === 401 || response.status === 403) {
      throw new AuthRequiredError(
        'app.mokahr.com',
        `Moka 登录态失效: HTTP ${response.status}。请重新运行 opencli moka login。`,
      );
    }

    if (response.status >= 300 && response.status < 400) {
      throw new AuthRequiredError(
        'app.mokahr.com',
        `Moka 返回 ${response.status} 重定向,通常表示登录态已失效。请重新运行 opencli moka login。`,
      );
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

    if (!response.ok) {
      const detail = isRecord(json) && typeof json.msg === 'string' ? json.msg : (text.trim() || response.statusText);
      throw new CommandExecutionError(`Moka ${path} 失败: HTTP ${response.status} ${detail}`);
    }

    return json ?? {};
  }

  return { fetchJson };
}
