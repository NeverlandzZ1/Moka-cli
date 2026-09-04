import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { JsonRecord } from './types.js';
import { isRecord } from './utils.js';

export interface PayloadBundle {
  updatedAt: string;
  body: JsonRecord;
}

export function defaultPayloadPath(): string {
  return join(homedir(), '.opencli', 'mokaData', 'moka-interview-list-payload.json');
}

function ensureParentDir(filePath: string): void {
  const parent = dirname(filePath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
}

export function readPayloadBundle(path: string = defaultPayloadPath()): PayloadBundle | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.body)) return undefined;
    const updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString();
    return { updatedAt, body: parsed.body };
  } catch {
    return undefined;
  }
}

export function writePayloadBundle(body: JsonRecord, path: string = defaultPayloadPath()): PayloadBundle {
  ensureParentDir(path);
  const bundle: PayloadBundle = { updatedAt: new Date().toISOString(), body };
  writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  return bundle;
}
