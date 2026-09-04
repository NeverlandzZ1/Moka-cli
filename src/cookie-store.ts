import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CDPBridge } from '@jackwener/opencli/browser/cdp';
import { isRecord } from './utils.js';

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface CookieBundle {
  updatedAt: string;
  cookies: StoredCookie[];
}

const MOKA_COOKIE_DOMAIN_SUFFIX = '.mokahr.com';

export function defaultCookiePath(): string {
  return join(homedir(), '.opencli', 'mokaData', 'moka-cookies.json');
}

function ensureParentDir(filePath: string): void {
  const parent = dirname(filePath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
}

function toStoredCookie(raw: unknown): StoredCookie | undefined {
  if (!isRecord(raw)) return undefined;
  const name = typeof raw.name === 'string' ? raw.name : '';
  const value = typeof raw.value === 'string' ? raw.value : '';
  const domain = typeof raw.domain === 'string' ? raw.domain : '';
  const path = typeof raw.path === 'string' ? raw.path : '/';
  if (!name || !domain) return undefined;
  const cookie: StoredCookie = { name, value, domain, path };
  if (typeof raw.expires === 'number') cookie.expires = raw.expires;
  if (typeof raw.httpOnly === 'boolean') cookie.httpOnly = raw.httpOnly;
  if (typeof raw.secure === 'boolean') cookie.secure = raw.secure;
  if (typeof raw.sameSite === 'string') cookie.sameSite = raw.sameSite;
  return cookie;
}

function domainMatches(cookieDomain: string, host: string): boolean {
  const normalized = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
  return host === normalized || host.endsWith(`.${normalized}`);
}

function isSessionCookieValid(cookie: StoredCookie): boolean {
  if (typeof cookie.expires !== 'number' || cookie.expires <= 0) return true;
  return cookie.expires * 1000 > Date.now();
}

export function readCookieBundle(path: string = defaultCookiePath()): CookieBundle | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.cookies)) return undefined;
    const cookies = parsed.cookies
      .map(toStoredCookie)
      .filter((cookie): cookie is StoredCookie => Boolean(cookie));
    const updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString();
    return { updatedAt, cookies };
  } catch {
    return undefined;
  }
}

export function writeCookieBundle(bundle: CookieBundle, path: string = defaultCookiePath()): void {
  ensureParentDir(path);
  const payload = { updatedAt: bundle.updatedAt, cookies: bundle.cookies };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export function cookieHeaderFor(host: string, bundle: CookieBundle): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const cookie of bundle.cookies) {
    if (!domainMatches(cookie.domain, host)) continue;
    if (!isSessionCookieValid(cookie)) continue;
    if (seen.has(cookie.name)) continue;
    seen.add(cookie.name);
    parts.push(`${cookie.name}=${cookie.value}`);
  }
  return parts.join('; ');
}

function parseSetCookieAttrs(parts: string[]): Partial<StoredCookie> {
  const attrs: Partial<StoredCookie> = {};
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    const key = eq === -1 ? trimmed.toLowerCase() : trimmed.slice(0, eq).trim().toLowerCase();
    const value = eq === -1 ? '' : trimmed.slice(eq + 1).trim();
    if (key === 'domain') attrs.domain = value.startsWith('.') ? value : `.${value}`;
    else if (key === 'path') attrs.path = value || '/';
    else if (key === 'expires') {
      const parsedDate = Date.parse(value);
      if (!Number.isNaN(parsedDate)) attrs.expires = Math.floor(parsedDate / 1000);
    } else if (key === 'max-age') {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) attrs.expires = Math.floor(Date.now() / 1000) + seconds;
    } else if (key === 'httponly') attrs.httpOnly = true;
    else if (key === 'secure') attrs.secure = true;
    else if (key === 'samesite') attrs.sameSite = value;
  }
  return attrs;
}

export function mergeSetCookieHeaders(
  existing: CookieBundle | undefined,
  setCookieHeaders: string[],
  requestHost: string,
): CookieBundle {
  const map = new Map<string, StoredCookie>();
  for (const cookie of existing?.cookies ?? []) {
    map.set(`${cookie.domain}|${cookie.path}|${cookie.name}`, cookie);
  }

  for (const rawHeader of setCookieHeaders) {
    const [nameValue, ...rest] = rawHeader.split(';');
    if (!nameValue) continue;
    const eq = nameValue.indexOf('=');
    if (eq === -1) continue;
    const name = nameValue.slice(0, eq).trim();
    const value = nameValue.slice(eq + 1).trim();
    if (!name) continue;
    const attrs = parseSetCookieAttrs(rest);
    const cookie: StoredCookie = {
      name,
      value,
      domain: attrs.domain || `.${requestHost}`,
      path: attrs.path || '/',
      ...(attrs.expires === undefined ? {} : { expires: attrs.expires }),
      ...(attrs.httpOnly === undefined ? {} : { httpOnly: attrs.httpOnly }),
      ...(attrs.secure === undefined ? {} : { secure: attrs.secure }),
      ...(attrs.sameSite === undefined ? {} : { sameSite: attrs.sameSite }),
    };
    if (typeof cookie.expires === 'number' && cookie.expires <= Math.floor(Date.now() / 1000)) {
      map.delete(`${cookie.domain}|${cookie.path}|${cookie.name}`);
      continue;
    }
    map.set(`${cookie.domain}|${cookie.path}|${cookie.name}`, cookie);
  }

  return {
    updatedAt: new Date().toISOString(),
    cookies: [...map.values()],
  };
}

export async function dumpCookiesFromBridge(
  bridge: CDPBridge,
  path: string = defaultCookiePath(),
): Promise<{ path: string; cookieCount: number }> {
  const response = await bridge.send('Network.getAllCookies');
  const cookies = isRecord(response) && Array.isArray(response.cookies)
    ? response.cookies
        .map(toStoredCookie)
        .filter((cookie): cookie is StoredCookie =>
          cookie !== undefined && cookie.domain.endsWith(MOKA_COOKIE_DOMAIN_SUFFIX))
    : [];
  const bundle: CookieBundle = {
    updatedAt: new Date().toISOString(),
    cookies,
  };
  writeCookieBundle(bundle, path);
  return { path, cookieCount: cookies.length };
}
