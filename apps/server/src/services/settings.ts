import fs from 'node:fs';
import path from 'node:path';
import { EFFORTS, PRESCREEN_PRESETS, prescreenConfig, resetProvider, type Effort } from '@jm/ai';
import { ENV_FILE, REPO_ROOT } from '../paths.ts';

/** Keys the Settings UI may write to .env. */
const EDITABLE = [
  'ANTHROPIC_API_KEY',
  'AI_MODEL',
  'AI_RESEARCH_MODEL',
  'AI_CLIENT_MODEL',
  'AI_EMAIL_MODEL',
  'AI_EFFORT',
  'AI_COACH_MODEL',
  'TRANSCRIBER_MODEL',
  'AUDIO_MIC_DEVICE',
  'AUDIO_OUTPUT_DEVICE',
  'PRESCREEN_PROVIDER',
  'PRESCREEN_BASE_URL',
  'PRESCREEN_API_KEY',
  'PRESCREEN_MODEL',
] as const;
type Key = (typeof EDITABLE)[number];

export const DEFAULT_MODEL = 'claude-opus-5-5';
/** Finding an agency's client is a few searches and a short answer: no need for the top model. */
export const DEFAULT_CLIENT_MODEL = 'claude-sonnet-5-5';
/** Reading an unclear email is a small job: the cheapest model is plenty. */
export const DEFAULT_EMAIL_MODEL = 'claude-haiku-4-5';
/** Fit scoring doesn't need deep deliberation; low effort is ~3x faster than the model default. */
export const DEFAULT_EFFORT: Effort = 'low';
/** The live interview coach answers in seconds, so a fast model at low effort. */
export const DEFAULT_COACH_MODEL = 'claude-sonnet-5-5';
export const COACH_EFFORT: Effort = 'low';
export const DEFAULT_TRANSCRIBER_MODEL = 'large-v3-turbo';

/** Python inside the audio engine's venv (or AUDIO_ENGINE_PYTHON), and whether it exists yet. */
export function audioEngineInstall() {
  const python =
    process.env.AUDIO_ENGINE_PYTHON ||
    path.join(REPO_ROOT, 'apps', 'audio-engine', '.venv', 'Scripts', 'python.exe');
  return { python, installed: fs.existsSync(python) };
}

export function currentEffort(): Effort {
  const e = process.env.AI_EFFORT as Effort | undefined;
  return e && EFFORTS.includes(e) ? e : DEFAULT_EFFORT;
}

/** Pre-screen settings for the UI: never the key itself, just enough to recognise it. */
function prescreenSettings() {
  const { apiKey, ...c } = prescreenConfig();
  return { ...c, apiKeyHint: apiKey ? `…${apiKey.slice(-4)}` : null, presets: PRESCREEN_PRESETS };
}

export function getSettings() {
  const key = process.env.ANTHROPIC_API_KEY ?? '';
  return {
    aiConfigured: Boolean(key || process.env.ANTHROPIC_AUTH_TOKEN),
    // Never send the key back — just enough to recognise it.
    apiKeyHint: key ? `…${key.slice(-4)}` : null,
    model: process.env.AI_MODEL || DEFAULT_MODEL,
    /** Company research (web search) — its own setting since it costs several times a fit score. */
    researchModel: process.env.AI_RESEARCH_MODEL || process.env.AI_MODEL || DEFAULT_MODEL,
    /** False when research just follows the fit model. */
    researchModelSet: Boolean(process.env.AI_RESEARCH_MODEL),
    /** Find client: who an agency's job is really for (web search). */
    clientModel: process.env.AI_CLIENT_MODEL || DEFAULT_CLIENT_MODEL,
    /** Ask AI on an unclear email (Email page). */
    emailModel: process.env.AI_EMAIL_MODEL || DEFAULT_EMAIL_MODEL,
    effort: currentEffort(),
    /** Live interview coach (hints during a call). */
    coachModel: process.env.AI_COACH_MODEL || DEFAULT_COACH_MODEL,
    transcriberModel: process.env.TRANSCRIBER_MODEL || DEFAULT_TRANSCRIBER_MODEL,
    /** Last-used audio devices, by name; empty = the system defaults. */
    micDevice: process.env.AUDIO_MIC_DEVICE || null,
    outputDevice: process.env.AUDIO_OUTPUT_DEVICE || null,
    audioEngine: audioEngineInstall(),
    /** The model that pre-screens watchlist jobs (a free one, by default off). */
    prescreen: prescreenSettings(),
  };
}

/** Upserts values in .env (keeping other lines) and applies them to this process. */
export function updateSettings(values: Partial<Record<Key, string | null>>, file = ENV_FILE) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  while (lines.length && !lines.at(-1)) lines.pop();
  for (const k of EDITABLE) {
    if (!(k in values)) continue;
    const v = values[k]?.trim() ?? '';
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
    if (v) process.env[k] = v;
    else delete process.env[k];
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  resetProvider();
  return getSettings();
}
