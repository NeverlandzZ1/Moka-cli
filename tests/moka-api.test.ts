import { describe, expect, it, vi } from 'vitest';
import {
  defaultInterviewListBody,
  getCurrentUser,
  setHireMode,
  setHireModeHttp,
  shanghaiDayBounds,
} from '../src/moka-api.js';
import type { HttpClient } from '../src/http-client.js';

describe('current Moka user', () => {
  it('requests and returns the current logged-in HR user', async () => {
    const fetchJson = vi.fn().mockResolvedValue({
      code: 0,
      msg: '成功',
      data: {
        users: [{
          userId: 8621994,
          name: 'HR User',
          email: 'hr@example.com',
        }],
      },
    });
    const client: HttpClient = { fetchJson };

    await expect(getCurrentUser(client)).resolves.toEqual({
      userId: 8621994,
      name: 'HR User',
      email: 'hr@example.com',
    });
    expect(fetchJson).toHaveBeenCalledWith(
      '/api/outer/ats-warden/businessUnit/users/getCurrent',
      { method: 'POST', timeoutMs: 30_000 },
    );
  });

  it('rejects an otherwise successful response without a current user', async () => {
    const client: HttpClient = {
      fetchJson: vi.fn().mockResolvedValue({ code: 0, data: { users: [] } }),
    };

    await expect(getCurrentUser(client)).rejects.toThrow('没有返回当前登录用户');
  });
});

describe('default interview discovery ranges', () => {
  it('builds the full today range using Asia/Shanghai day boundaries', () => {
    const now = Date.parse('2026-08-25T12:00:00+08:00');
    expect(shanghaiDayBounds(now)).toEqual({
      start: 1787587200000,
      end: 1787673599000,
    });
    expect(defaultInterviewListBody({
      jobPreference: 'all',
      countType: 'afterToday',
      order: 'desc',
      minStartDate: 123,
      currentPage: 9,
      pageSize: 10,
    }, now)).toEqual({
      jobPreference: 'all',
      pageSize: 10,
      countType: 'today',
      order: 'asc',
      minStartDate: 1787587200000,
      maxStartDate: 1787673599000,
      currentPage: 1,
    });
  });
});

describe('hire mode', () => {
  it.each([
    ['campus', 2, '校招'],
    ['social', 1, '社招'],
  ] as const)('switches to %s directly through the HTTP client', async (mode, value, label) => {
    const fetchJson = vi.fn().mockResolvedValue({});
    const client: HttpClient = { fetchJson };

    await expect(setHireModeHttp(client, mode)).resolves.toEqual({
      mode,
      modeLabel: label,
      currentHireMode: value,
    });
    expect(fetchJson).toHaveBeenCalledWith(
      '/api/users/update_currenthiremode_fields',
      {
        method: 'PUT',
        body: { currentHireMode: value },
        timeoutMs: 30_000,
      },
    );
  });

  it.each([
    ['campus', 2, '校招'],
    ['social', 1, '社招'],
  ] as const)('switches to %s using Moka mode value %s', async (mode, value, label) => {
    const evaluate = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: 'success',
    });
    const page = { evaluate } as never;
    const send = vi.fn().mockResolvedValue(undefined);
    const bridge = { send } as never;

    await expect(setHireMode(page, bridge, mode)).resolves.toEqual({
      mode,
      modeLabel: label,
      currentHireMode: value,
    });
    expect(evaluate).toHaveBeenCalledWith(
      expect.any(Function),
      {
        path: '/api/users/update_currenthiremode_fields',
        value,
      },
    );
    expect(send).toHaveBeenNthCalledWith(1, 'Page.enable');
    expect(send).toHaveBeenNthCalledWith(2, 'Page.reload');
    expect(send).toHaveBeenNthCalledWith(3, 'Page.reload');
  });

  it('reports an HTTP error even when Moka returns plain text', async () => {
    const page = {
      evaluate: vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: 'failed',
      }),
    } as never;

    await expect(setHireMode(page, { send: vi.fn() } as never, 'campus'))
      .rejects.toThrow('HTTP 500 failed');
  });
});
