import fs from 'node:fs';
import { EFFORTS, PRESCREEN_PRESETS, prescreenConfig, resetProvider, type Effort } from '@jm/ai';
import { ENV_FILE } from '../paths.ts';

/** Keys the Settings UI may write to .env. */
const EDITABLE = [
  'ANTHROPIC_API_KEY',
  'AI_MODEL',
  'AI_RESEARCH_MODEL',
  'AI_EMAIL_MODEL',
  'AI_EFFORT',
  'PRESCREEN_PROVIDER',
  'PRESCREEN_BASE_URL',
  'PRESCREEN_API_KEY',
  'PRESCREEN_MODEL',
] as const;
type Key = (typeof EDITABLE)[number];

export const DEFAULT_MODEL = 'claude-opus-5-5';
/** Reading an unclear email is a small job: the cheapest model is plenty. */
export const DEFAULT_EMAIL_MODEL = 'claude-haiku-4-5';
/** Fit scoring doesn't need deep deliberation; low effort is ~3x faster than the model default. */
export const DEFAULT_EFFORT: Effort = 'low';

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
    /** Ask AI on an unclear email (Email page). */
    emailModel: process.env.AI_EMAIL_MODEL || DEFAULT_EMAIL_MODEL,
    effort: currentEffort(),
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
