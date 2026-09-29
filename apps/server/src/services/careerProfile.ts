/**
 * The career profile: a detailed, factual inventory of your career built from your resume and
 * LinkedIn profile (one AI call, only when you ask). Fit scoring reads it next to the resume;
 * you can edit it.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { LLMError, getProvider, type LLMProvider } from '@jm/ai';
import { estimateCostUsd } from '@jm/shared';
import type { Db } from '../db/client.ts';
import { aiUsage, profile } from '../db/schema.ts';
import { getDefaultResume, getProfile, updateProfile } from './resume.ts';
import { currentEffort, getSettings } from './settings.ts';
import { recordUsage, repricedAverage } from './usage.ts';

export class CareerProfileError extends Error {}

export const CAREER_PROFILE_SYSTEM_PROMPT = `You turn a job seeker's resume and LinkedIn profile into one detailed, factual career inventory that a recruiter or an AI can use to judge fit for senior Technical Program Manager roles.

Write it in Markdown, in this order:
1. Summary: 3-4 lines — level, years, the kinds of programs and domains.
2. Roles, most recent first. For each: company, title, dates (and location if given), then bullets for scope (teams, people led or influenced, budget, scale of users/systems/revenue), the programs run, outcomes with numbers, domains and technology. Keep every concrete detail the sources give; merge what the resume and LinkedIn say about the same role.
3. Skills and strengths: each with where it is shown (company or project).
4. Leadership and ways of working: how they lead programs, influence, process, stakeholders — only as evidenced.
5. Certifications, education, awards.
6. What others say: short quotes (one line each) from recommendations, with who said them.

Rules:
- Use only facts in the sources. Never invent, round up or embellish. If a detail is vague in the source, keep it vague.
- Write in the third person, plainly, without adjectives the sources don't support.
- Be complete rather than short: this replaces reading the full profile.
- List in conflicts any place where the resume and LinkedIn disagree (dates, titles, numbers).`;

export const careerProfileSchema = z.object({
  profile: z.string().describe('The career inventory, in Markdown'),
  conflicts: z.array(z.string()).describe('Where the resume and LinkedIn disagree'),
});

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[…cut]` : s);

export function buildCareerProfilePrompt(resume: string | null, linkedin: string | null) {
  return `<resume>
${resume ? clip(resume, 40_000) : 'None uploaded.'}
</resume>

<linkedin_profile>
${linkedin ? clip(linkedin, 120_000) : 'Not imported.'}
</linkedin_profile>

Build the career inventory.`;
}

/** Output tokens a career profile typically takes (incl. thinking), for the estimate. */
const OUTPUT_GUESS = 7_000;

/** What building (or rebuilding) it is likely to cost now. */
export function careerProfileCostUsd(db: Db): number | null {
  const model = getSettings().model;
  const rows = db.select().from(aiUsage).where(eq(aiUsage.feature, 'profile')).all();
  const history = repricedAverage(rows, 'profile', model);
  if (history != null) return history;
  const p = getProfile(db);
  const chars =
    CAREER_PROFILE_SYSTEM_PROMPT.length +
    (getDefaultResume(db)?.rawText.length ?? 0) +
    (p.linkedinText?.length ?? 0);
  return estimateCostUsd(model, { inputTokens: Math.round(chars / 4), outputTokens: OUTPUT_GUESS });
}

export async function buildCareerProfile(db: Db, opts: { provider?: LLMProvider } = {}) {
  const resume = getDefaultResume(db)?.rawText ?? null;
  const linkedin = getProfile(db).linkedinText ?? null;
  if (!linkedin && !resume)
    throw new CareerProfileError('Upload a resume or import your LinkedIn profile first.');
  const provider = opts.provider ?? getProvider();
  const model = getSettings().model;
  let res;
  try {
    res = await provider.completeStructured({
      system: CAREER_PROFILE_SYSTEM_PROMPT,
      prompt: buildCareerProfilePrompt(resume, linkedin),
      schema: careerProfileSchema,
      model,
      effort: currentEffort(),
      maxTokens: 24_000,
    });
  } catch (err) {
    if (err instanceof LLMError && err.trace)
      recordUsage(db, {
        feature: 'profile',
        provider: provider.name,
        model,
        trace: err.trace,
        error: err.message,
      });
    throw err;
  }
  const usageId = recordUsage(db, {
    feature: 'profile',
    provider: res.provider,
    model: res.model,
    usage: res.usage,
    trace: res.trace,
  });
  const conflicts = res.data.conflicts.filter((c) => c.trim());
  const text =
    res.data.profile.trim() +
    (conflicts.length
      ? `\n\n## Resume and LinkedIn disagree\n${conflicts.map((c) => `- ${c}`).join('\n')}`
      : '');
  updateProfile(db, {});
  db.update(profile)
    .set({
      careerProfile: text,
      careerProfileAt: new Date().toISOString(),
      careerProfileUsageId: usageId,
    })
    .where(eq(profile.id, 1))
    .run();
  return { careerProfile: text, conflicts, usageId };
}
