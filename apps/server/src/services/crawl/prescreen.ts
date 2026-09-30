/**
 * The pre-screen: one small question to a free model about a job the rules let through — is
 * this plausibly worth your time? It sees the posting and your criteria (goals, pay floor,
 * must-haves, deal-breakers), never your resume or career profile. It can only keep a job out
 * for a clear deal-breaker; when unsure it says "maybe", which goes to the inbox like "yes".
 */
import { z } from 'zod';
import type { LLMProvider } from '@jm/ai';
import { splitLines } from '@jm/shared';
import type { Db } from '../../db/client.ts';
import { getProfile } from '../resume.ts';
import { recordUsage } from '../usage.ts';
import type { BoardJob } from './boards.ts';

export const PRESCREEN_SYSTEM_PROMPT = `You screen job postings for one candidate. You are a coarse first filter before the candidate reads the posting themselves, so your job is only to remove postings that clearly cannot fit.

Answer with a verdict:
- "no": the posting clearly fails a must-have or clearly triggers a deal-breaker, or is plainly a different kind of job from the candidate's target (for example a marketing, legal, HR, finance, events or communications program role when the target is technical program management). Name the one criterion in dealBreaker.
- "yes": the role matches the target and nothing in the posting fails a must-have or triggers a deal-breaker.
- "maybe": anything else, including when the posting does not say enough to tell.

Rules:
- Judge only from what the posting says. Missing information is never a reason for "no".
- Known gaps, nice-to-haves and an imperfect match are not reasons for "no".
- When in doubt between "no" and "maybe", answer "maybe". A wrongly rejected job costs the candidate far more than a wrongly kept one.
- reason: one short sentence, in plain words, quoting or pointing at what in the posting decided it.`;

export const prescreenSchema = z.object({
  verdict: z.enum(['yes', 'maybe', 'no']),
  reason: z.string().describe('One short sentence: what in the posting decided it'),
  dealBreaker: z
    .string()
    .nullable()
    .describe('For "no": the must-have failed or deal-breaker triggered; otherwise null'),
});
export type PrescreenResult = z.infer<typeof prescreenSchema>;

/** Enough of a posting to judge it, short enough to stay inside a free tier's token limits. */
const DESCRIPTION_CHARS = 5000;

const bullets = (text: string | null) =>
  splitLines(text)
    .map((l) => `- ${l}`)
    .join('\n') || '(none given)';

export function buildPrescreenPrompt(
  db: Db,
  job: Pick<BoardJob, 'title' | 'location' | 'remoteType' | 'salaryMin' | 'salaryMax'> & {
    company: string;
    descriptionText: string | null;
  },
): string {
  const p = getProfile(db);
  const pay =
    job.salaryMin || job.salaryMax
      ? `$${(job.salaryMin ?? job.salaryMax)!.toLocaleString('en-US')} - $${(job.salaryMax ?? job.salaryMin)!.toLocaleString('en-US')}`
      : 'not posted';
  return `<job>
Company: ${job.company}
Title: ${job.title}
Location: ${job.location ?? 'not stated'}${job.remoteType ? ` (${job.remoteType})` : ''}
Pay: ${pay}

${(job.descriptionText ?? '(no description available)').slice(0, DESCRIPTION_CHARS)}
</job>

<candidate>
<background_and_target>
${p.goals?.trim() || '(not given)'}
</background_and_target>
<minimum_base_salary>${p.minBase ? `$${p.minBase.toLocaleString('en-US')}` : 'not set'}</minimum_base_salary>
<must_haves>
${bullets(p.mustHaves)}
</must_haves>
<deal_breakers>
${bullets(p.dealBreakers)}
</deal_breakers>
</candidate>

Screen this posting for this candidate.`;
}

export interface Prescreener {
  provider: LLMProvider;
  model: string;
}

/** Asks the model once. Throws what the provider throws (a RateLimitError means "try later"). */
export async function prescreenJob(
  db: Db,
  job: Parameters<typeof buildPrescreenPrompt>[1],
  screener: Prescreener,
): Promise<PrescreenResult & { model: string; usageId: number }> {
  const res = await screener.provider.completeStructured({
    system: PRESCREEN_SYSTEM_PROMPT,
    prompt: buildPrescreenPrompt(db, job),
    schema: prescreenSchema,
    model: screener.model,
    maxTokens: 400,
  });
  const usageId = recordUsage(db, {
    feature: 'prescreen',
    provider: res.provider,
    model: res.model,
    usage: res.usage,
    trace: res.trace,
  });
  return { ...res.data, model: res.model, usageId };
}
