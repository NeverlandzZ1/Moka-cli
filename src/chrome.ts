import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchDetachedApp, probeCDP } from '@jackwener/opencli/launcher';
import { CDPBridge } from '@jackwener/opencli/browser/cdp';
import { ConfigError } from '@jackwener/opencli/errors';
import { MOKA_ORIGIN, MOKA_OVERVIEW_URL } from './constants.js';

export interface ChromeLaunchOptions {
  port: number;
  url: string;
  profileDir?: string;
  chromePath?: string;
}

interface ChromeTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export function selectReusableMokaTarget(targets: ChromeTarget[]): ChromeTarget | undefined {
  return targets
    .filter((target) => (
      target.type === 'page'
      && target.url?.startsWith(MOKA_ORIGIN)
      && !target.url.includes('/api/')
      && target.webSocketDebuggerUrl
    ))
    .sort((left, right) => {
      const score = (target: ChromeTarget): number => {
        if (target.url?.startsWith(MOKA_OVERVIEW_URL)) return 3;
        if (target.url?.includes('/login')) return 2;
        return 1;
      };
      return score(right) - score(left);
    })[0];
}

async function bringTargetToFront(target: ChromeTarget): Promise<void> {
  if (!target.webSocketDebuggerUrl) return;
  const bridge = new CDPBridge();
  try {
    await bridge.connect({ cdpEndpoint: target.webSocketDebuggerUrl, timeout: 5 });
    await bridge.send('Page.bringToFront');
  } finally {
    await bridge.close().catch(() => undefined);
  }
}

async function openOrReuseCdpTab(endpoint: string, url: string): Promise<boolean> {
  const targetsResponse = await fetch(`${endpoint}/json`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (targetsResponse.ok) {
    const targets = await targetsResponse.json();
    const existing = selectReusableMokaTarget(Array.isArray(targets) ? targets : []);
    if (existing) {
      await bringTargetToFront(existing);
      return true;
    }
  }

  const response = await fetch(`${endpoint}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`CDP new tab failed: HTTP ${response.status}`);
  const created = await response.json() as ChromeTarget;
  await bringTargetToFront(created);
  return false;
}

export function defaultProfileDir(): string {
  const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  return join(base, 'MokaTranscriptGetter', 'ChromeProfile');
}

export function findChromeExecutable(explicitPath?: string): string {
  if (explicitPath) {
    if (existsSync(explicitPath)) return explicitPath;
    throw new ConfigError(`找不到指定的 Chrome：${explicitPath}`);
  }

  const candidates = process.platform === 'win32'
    ? [
        process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

  const found = candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  if (found) return found;
  throw new ConfigError(
    '没有找到 Google Chrome',
    '请安装 Chrome，或使用 --chrome-path 指定 chrome.exe 的完整路径。',
  );
}

export async function ensureChromeWithCdp(options: ChromeLaunchOptions): Promise<{
  endpoint: string;
  launched: boolean;
  profileDir: string;
  reusedMokaTab: boolean;
}> {
  const endpoint = `http://127.0.0.1:${options.port}`;
  const profileDir = options.profileDir || defaultProfileDir();
  if (await probeCDP(options.port, 800)) {
    const reusedMokaTab = await openOrReuseCdpTab(endpoint, options.url);
    return { endpoint, launched: false, profileDir, reusedMokaTab };
  }

  const executable = findChromeExecutable(options.chromePath);
  mkdirSync(profileDir, { recursive: true });
  await launchDetachedApp(executable, [
    `--remote-debugging-port=${options.port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    options.url,
  ], 'Google Chrome');

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await probeCDP(options.port, 800)) {
      return { endpoint, launched: true, profileDir, reusedMokaTab: false };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new ConfigError(
    `Chrome 已启动，但 CDP 端口 ${options.port} 未就绪`,
    '请关闭刚打开的 Chrome 后重试，或通过 --port 使用另一个端口。',
  );
}
