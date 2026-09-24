import fs from 'node:fs';
import { EFFORTS, resetProvider, type Effort } from '@jm/ai';
import { ENV_FILE } from '../paths.ts';

/** Keys the Settings UI may write to .env. */
const EDITABLE = ['ANTHROPIC_API_KEY', 'AI_MODEL', 'AI_RESEARCH_MODEL', 'AI_EFFORT'] as const;
type Key = (typeof EDITABLE)[number];

export const DEFAULT_MODEL = 'claude-opus-5-5';
/** Fit scoring doesn't need deep deliberation; low effort is ~3x faster than the model default. */
export const DEFAULT_EFFORT: Effort = 'low';

export function currentEffort(): Effort {
  const e = process.env.AI_EFFORT as Effort | undefined;
  return e && EFFORTS.includes(e) ? e : DEFAULT_EFFORT;
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
    effort: currentEffort(),
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
