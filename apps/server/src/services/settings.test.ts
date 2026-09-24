import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getSettings, updateSettings } from './settings.ts';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('updateSettings', () => {
  it('upserts keys in .env, keeps other lines, and never echoes the key', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jm-')), '.env');
    fs.writeFileSync(file, '# comment\nAI_PROVIDER=anthropic\nANTHROPIC_API_KEY=\n');

    const s = updateSettings({ ANTHROPIC_API_KEY: 'sk-ant-secret-1234' }, file);
    expect(s).toMatchObject({ aiConfigured: true, apiKeyHint: '…1234' });
    expect(JSON.stringify(s)).not.toContain('secret');

    updateSettings({ AI_MODEL: 'claude-sonnet-5' }, file);
    expect(fs.readFileSync(file, 'utf8')).toBe(
      '# comment\nAI_PROVIDER=anthropic\nANTHROPIC_API_KEY=sk-ant-secret-1234\nAI_MODEL=claude-sonnet-5\n',
    );

    updateSettings({ ANTHROPIC_API_KEY: null }, file);
    expect(getSettings()).toMatchObject({
      aiConfigured: false,
      apiKeyHint: null,
      model: 'claude-sonnet-5',
    });
  });
});
