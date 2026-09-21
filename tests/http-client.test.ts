import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../src/http-client.js';
import type { CookieBundle } from '../src/cookie-store.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { ...init, headers });
}

describe('offline Moka session renewal', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the Passport cookie to renew the app session and retries once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'moka-http-'));
    const cookiePath = join(directory, 'moka-cookies.json');
    const bundle: CookieBundle = {
      updatedAt: new Date().toISOString(),
      cookies: [{
        name: 'moka-jwt',
        value: 'passport-cookie',
        domain: '.mokahr.com',
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 3600,
      }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 10001, msg: '需要登录才能进行该操作' }))
      .mockResolvedValueOnce(jsonResponse(
        { code: 0, msg: '成功', data: { ticket: 'one-time-ticket' } },
        { headers: { 'set-cookie': 'acw_tc=renewed; Domain=.mokahr.com; Path=/' } },
      ))
      .mockResolvedValueOnce(jsonResponse(
        { code: 0, msg: '成功', data: {} },
        { headers: { 'set-cookie': 'connect.sid=new-session; Domain=.mokahr.com; Path=/' } },
      ))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { rows: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const client = createHttpClient({ bundle, cookiePath });
      await expect(client.fetchJson('/api/test', { body: { page: 1 } }))
        .resolves.toEqual({ code: 0, data: { rows: [] } });

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        'https://app.mokahr.com/api/test',
        'https://passport.mokahr.com/api/outer/moka-unified-account/mokaUid/ticket',
        'https://app.mokahr.com/api/outer/moka-unified-account/mokaUid/uniLogin',
        'https://app.mokahr.com/api/test',
      ]);
      expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({
        bus: 10,
        isMobile: false,
      });
      expect(JSON.parse(String(fetchMock.mock.calls[2]![1]!.body))).toEqual({
        ticket: 'one-time-ticket',
        bus: 10,
        isMobile: false,
      });
      const retryHeaders = fetchMock.mock.calls[3]![1]!.headers as Record<string, string>;
      expect(retryHeaders.cookie).toContain('connect.sid=new-session');

      const stored = JSON.parse(readFileSync(cookiePath, 'utf8')) as CookieBundle;
      expect(stored.cookies).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'connect.sid', value: 'new-session' }),
      ]));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('explains a successful ticket response without a ticket as a revoked Passport session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'moka-http-'));
    const cookiePath = join(directory, 'moka-cookies.json');
    const bundle: CookieBundle = {
      updatedAt: new Date().toISOString(),
      cookies: [{
        name: 'moka-jwt',
        value: 'revoked-passport-cookie',
        domain: 'passport.mokahr.com',
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 3600,
      }, {
        name: 'connect.sid',
        value: 'expired-app-session',
        domain: 'app.mokahr.com',
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 3600,
      }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 10001, msg: '需要登录才能进行该操作' }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: '成功' }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const client = createHttpClient({ bundle, cookiePath });
      await expect(client.fetchJson('/api/test'))
        .rejects.toThrow('接口返回成功但没有 ticket');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
