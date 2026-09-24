import { eq } from 'drizzle-orm';
import type { LLMProvider } from '@jm/ai';
import type { Db } from '../db/client.ts';
import { applications, jobs } from '../db/schema.ts';
import { NotFoundError } from './applications.ts';
import { assessFit } from './fit.ts';
import { ensureResearch } from './research.ts';

/**
 * "Score" on a Screening card: the fit score and — when the company has no fresh brief — company
 * research, side by side so it takes no longer than scoring alone. A research failure doesn't
 * lose the score (and vice versa); errors come back per part.
 */
export async function analyzeApplication(
  db: Db,
  applicationId: number,
  opts: { force?: boolean; provider?: LLMProvider } = {},
) {
  const row = db
    .select({ companyId: jobs.companyId, title: jobs.title, url: jobs.url })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(eq(applications.id, applicationId))
    .get();
  if (!row) throw new NotFoundError(`Application ${applicationId} not found`);

  const [fit, research] = await Promise.allSettled([
    assessFit(db, applicationId, { force: opts.force, provider: opts.provider }),
    ensureResearch(db, row.companyId, {
      provider: opts.provider,
      applicationId,
      jobTitle: row.title,
      jobUrl: row.url,
    }),
  ]);
  if (fit.status === 'rejected' && research.status === 'rejected') throw fit.reason;
  return {
    fit: fit.status === 'fulfilled' ? fit.value : null,
    fitError: fit.status === 'rejected' ? (fit.reason as Error).message : null,
    researchReused: research.status === 'fulfilled' ? research.value.reused : null,
    researchError: research.status === 'rejected' ? (research.reason as Error).message : null,
  };
}
