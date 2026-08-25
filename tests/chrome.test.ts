import { describe, expect, it } from 'vitest';
import { selectReusableMokaTarget } from '../src/chrome.js';

describe('selectReusableMokaTarget', () => {
  it('prefers the existing interview overview and ignores API tabs', () => {
    const selected = selectReusableMokaTarget([
      {
        type: 'page',
        url: 'https://app.mokahr.com/api/outer/ats-interview/interview/hr/interviewList',
        webSocketDebuggerUrl: 'ws://api',
      },
      {
        type: 'page',
        url: 'https://app.mokahr.com/login',
        webSocketDebuggerUrl: 'ws://login',
      },
      {
        type: 'page',
        url: 'https://app.mokahr.com/interviews/overview',
        webSocketDebuggerUrl: 'ws://overview',
      },
    ]);

    expect(selected?.webSocketDebuggerUrl).toBe('ws://overview');
  });

  it('falls back to the existing login page', () => {
    const selected = selectReusableMokaTarget([
      {
        type: 'page',
        url: 'https://app.mokahr.com/login?redirectUrl=%2Finterviews%2Foverview',
        webSocketDebuggerUrl: 'ws://login',
      },
    ]);

    expect(selected?.webSocketDebuggerUrl).toBe('ws://login');
  });
});
