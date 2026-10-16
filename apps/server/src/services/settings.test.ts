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

  it('research follows the fit model until it has its own; Opus 5.5 by default', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jm-')), '.env');
    delete process.env.AI_MODEL;
    delete process.env.AI_RESEARCH_MODEL;
    expect(getSettings()).toMatchObject({
      model: 'claude-opus-5-5',
      researchModel: 'claude-opus-5-5',
      researchModelSet: false,
    });
    updateSettings({ AI_MODEL: 'claude-opus-5' }, file);
    expect(getSettings().researchModel).toBe('claude-opus-5');
    updateSettings({ AI_RESEARCH_MODEL: 'claude-sonnet-5' }, file);
    expect(getSettings()).toMatchObject({
      model: 'claude-opus-5',
      researchModel: 'claude-sonnet-5',
      researchModelSet: true,
    });
    updateSettings({ AI_RESEARCH_MODEL: null }, file);
    expect(getSettings()).toMatchObject({
      researchModel: 'claude-opus-5',
      researchModelSet: false,
    });
  });
});

describe('interview coach settings', () => {
  it('defaults to Sonnet 5.5, keeps device names, and reports the audio engine', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jm-')), '.env');
    delete process.env.AI_COACH_MODEL;
    delete process.env.AUDIO_MIC_DEVICE;
    expect(getSettings()).toMatchObject({
      coachModel: 'claude-sonnet-5-5',
      transcriberModel: 'large-v3-turbo',
      micDevice: null,
      outputDevice: null,
    });
    updateSettings(
      { AI_COACH_MODEL: 'claude-haiku-5-5', AUDIO_MIC_DEVICE: 'Headset Mic (USB)' },
      file,
    );
    expect(getSettings()).toMatchObject({
      coachModel: 'claude-haiku-5-5',
      micDevice: 'Headset Mic (USB)',
    });
    expect(typeof getSettings().audioEngine.installed).toBe('boolean');
  });
});
