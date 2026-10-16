import { getProvider, type LLMProvider } from '@jm/ai';
import { prepCardSchema, type PrepCard } from '@jm/shared';
import type { Db } from '../../db/client.ts';
import { COACH_EFFORT } from '../settings.ts';
import { recordUsage } from '../usage.ts';
import { renderContext, loadCoachContext } from './context.ts';
import { getSessionRow, savePrep } from './store.ts';

export const PREP_SYSTEM_PROMPT = `You prepare a job seeker for an upcoming interview call.

Rules:
- Use only facts from the applicant's resume, career profile, drafted answers and fit notes when you refer to their experience. Never invent employers, numbers or projects.
- Tailor everything to the round named in <round>. A recruiter screen is about logistics, motivation, level, compensation and timeline. A hiring manager or technical round is about depth, numbers and trade-offs.
- Be concrete and short. Every item should be something they can glance at once and use.
- likelyQuestions: the questions this interviewer is most likely to ask, each with a one-line approach that names the story or fact to use.
- stories: experiences from the career profile worth having ready, each with what it is good for.
- risks: gaps, level mismatches or red flags that could come up, each with how to handle it.
- askThem: questions to ask, drawn from the company brief where they fit this round.
- logistics: process, rounds, compensation or timeline facts from the company brief; leave empty when there are none.
- Plain text, no markdown.`;

/** Builds the prep card for a session (once; a second call returns the saved one). */
export async function generatePrep(
  db: Db,
  sessionId: number,
  opts: { provider?: LLMProvider } = {},
): Promise<PrepCard> {
  const session = getSessionRow(db, sessionId);
  if (session.prep) return session.prep as PrepCard;
  const ctx = loadCoachContext(db, sessionId);
  const provider = opts.provider ?? getProvider();
  const res = await provider.completeStructured({
    system: PREP_SYSTEM_PROMPT,
    prompt: `${renderContext(ctx)}\n\nPrepare the applicant for this call.`,
    schema: prepCardSchema,
    model: session.coachModel,
    effort: COACH_EFFORT,
    maxTokens: 6000,
  });
  const usageId = recordUsage(db, {
    feature: 'prep',
    provider: res.provider,
    model: res.model,
    usage: res.usage,
    applicationId: ctx.applicationId,
    companyId: ctx.companyId,
    trace: res.trace,
  });
  savePrep(db, sessionId, res.data, usageId);
  return res.data;
}
