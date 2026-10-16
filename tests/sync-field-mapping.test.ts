import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '..');
const scriptUrl = new URL('../skills/moka-transcript/scripts/sync-lark-base.mjs', import.meta.url).href;

describe('sync-lark-base field mapping', () => {
  it('copies the top-level scheduling HR into every transcript row', async () => {
    const expression = [
      `import { transcriptFields } from ${JSON.stringify(scriptUrl)};`,
      `const fields = transcriptFields({ applicationId: 1, interviewId: 2, interviewerNames: [], reviewScores: {} }, 'HR User');`,
      `process.stdout.write(JSON.stringify(fields));`,
    ].join('\n');
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', expression], {
      cwd: repoRoot,
    });
    const fields = JSON.parse(stdout) as Record<string, unknown>;

    expect(fields['面试安排HR']).toBe('HR User');
  });
});
