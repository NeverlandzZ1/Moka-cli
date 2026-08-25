import { describe, expect, it } from 'vitest';
import type { IPage } from '@jackwener/opencli/types';
import type { CDPBridge } from '@jackwener/opencli/browser/cdp';
import { discoverInterviewListPayload } from '../src/cdp.js';

describe('discoverInterviewListPayload', () => {
  it('reuses the payload cached in the current Moka tab', async () => {
    const page = {
      evaluate: async () => '{"currentPage":2,"pageSize":10}',
    } as unknown as IPage;
    const bridge = {
      send: async () => { throw new Error('Network should not be enabled for a cache hit'); },
    } as unknown as CDPBridge;

    await expect(discoverInterviewListPayload(page, bridge)).resolves.toEqual({
      currentPage: 2,
      pageSize: 10,
    });
  });

  it('captures the request triggered by loading more and caches it', async () => {
    let call = 0;
    let networkHandler: ((params: unknown) => void) | undefined;
    const page = {
      evaluate: async () => {
        call += 1;
        if (call === 1) return null;
        if (call === 2) {
          queueMicrotask(() => networkHandler?.({
            request: {
              method: 'POST',
              url: 'https://app.mokahr.com/api/outer/ats-interview/interview/hr/interviewList',
              postData: '{"currentPage":2,"pageSize":10,"filters":[]}',
            },
          }));
          return { clicked: true, reason: 'load-more' };
        }
        return undefined;
      },
    } as unknown as IPage;
    const bridge = {
      send: async () => ({}),
      on: (_event: string, handler: (params: unknown) => void) => { networkHandler = handler; },
      off: () => { networkHandler = undefined; },
    } as unknown as CDPBridge;

    await expect(discoverInterviewListPayload(page, bridge)).resolves.toEqual({
      currentPage: 2,
      pageSize: 10,
      filters: [],
    });
    expect(call).toBe(3);
  });
});

