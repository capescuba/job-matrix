/**
 * The pre-screen: one small question to a free model about a job the rules let through — is
 * this plausibly worth your time? It sees the posting and your criteria (goals, pay floor,
 * must-haves, deal-breakers), never your resume or career profile. It can only keep a job out
 * for a clear deal-breaker; when unsure it says "maybe", which goes to the inbox like "yes".
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { LLMError, getPrescreenProvider, type LLMProvider } from '@jm/ai';
import { splitLines } from '@jm/shared';
import type { Db } from '../../db/client.ts';
import { applications, companies, jobs, prescreens } from '../../db/schema.ts';
import { NotFoundError, addActivity } from '../applications.ts';
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
- reason: one short sentence, in plain words, quoting or pointing at what in the posting decided it.
- score: a rough 0–10 for how well the role matches the candidate's target: 9–10 squarely the target role, level and place; 6–8 a good match with something to check; 4–5 plausible but unclear; 0–3 a poor match or a different kind of job. The verdict, not the score, decides what the candidate sees.`;

export const prescreenSchema = z.object({
  verdict: z.enum(['yes', 'maybe', 'no']),
  reason: z.string().describe('One short sentence: what in the posting decided it'),
  score: z
    .number()
    .min(0)
    .max(10)
    .optional()
    .describe('Rough 0–10 match with the target (not a deal-breaker check)'),
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
  applicationId?: number,
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
    applicationId,
  });
  return { ...res.data, model: res.model, usageId };
}

/** No pre-screen model is set up (or its key is missing). */
export class PrescreenNotSetUp extends LLMError {}

/**
 * A pre-screen you ask for on a job you already track (from the Chrome extension or the inbox):
 * the free model's quick answer before you pay for a fit score. Kept, and noted on the timeline.
 */
export async function prescreenApplication(
  db: Db,
  applicationId: number,
  opts: { screener?: Prescreener | null } = {},
) {
  const screener = opts.screener === undefined ? getPrescreenProvider() : opts.screener;
  if (!screener)
    throw new PrescreenNotSetUp(
      'No pre-screen model is set up yet. Choose one (Groq is free) on the Watchlist page.',
    );
  const row = db
    .select({ app: applications, job: jobs, company: companies.name })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(eq(applications.id, applicationId))
    .get();
  if (!row) throw new NotFoundError(`Application ${applicationId} not found`);
  const r = await prescreenJob(
    db,
    {
      company: row.company,
      title: row.job.title,
      location: row.job.location,
      remoteType: row.job.remoteType as BoardJob['remoteType'],
      salaryMin: row.job.salaryMin,
      salaryMax: row.job.salaryMax,
      descriptionText: row.job.descriptionText,
    },
    screener,
    applicationId,
  );
  const score = r.score == null ? null : Math.round(r.score * 10) / 10;
  const saved = db
    .insert(prescreens)
    .values({
      applicationId,
      verdict: r.verdict,
      score,
      reason: r.reason,
      model: r.model,
      usageId: r.usageId,
    })
    .returning()
    .get();
  addActivity(db, applicationId, {
    at: new Date().toISOString().slice(0, 10),
    kind: 'Note',
    summary: `Pre-screen (${r.model}): ${r.verdict}${score != null ? `, ${score}/10` : ''} — ${r.reason}`,
  });
  return saved;
}
