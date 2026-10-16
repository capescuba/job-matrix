import { getProvider, type LLMProvider } from '@jm/ai';
import { debriefSchema, type CoachHint, type Debrief } from '@jm/shared';
import type { Db } from '../../db/client.ts';
import { addActivity } from '../applications.ts';
import { getSettings } from '../settings.ts';
import { recordUsage } from '../usage.ts';
import { loadCoachContext, renderContext } from './context.ts';
import { getSession, saveDebrief } from './store.ts';

export const DEBRIEF_SYSTEM_PROMPT = `You debrief a job seeker right after an interview call.

You get the applicant's context and the full transcript, with timestamps. Lines are tagged THEM (the interviewer) and ME (the applicant). Some lines are followed by the coach card that was on screen at that moment.

Rules:
- Write in the second person to the applicant. Be honest and specific: quote or paraphrase what was actually said, not what would have been ideal.
- summary: 3 to 5 sentences. How the call went, the interviewer's apparent view, and the one thing that matters most for the next step.
- questions: every real question the interviewer asked, in order, with one sentence on what the applicant said, how it landed (strong, ok, weak or unclear), and for weak or ok answers what would have been stronger, using facts from the resume and career profile only. Skip small talk.
- theyShared: facts the interviewer volunteered: process, timeline, team, compensation, priorities.
- followUps: anything the applicant promised to send or do, or that was promised to them.
- thankYouPoints: 3 to 4 specific points for the thank-you email that refer to things actually discussed.
- nextRound: what the next step is and when, if it was said; otherwise null.
- Never invent facts about the applicant or the call. If the transcript is thin, say so in the summary.`;

const stamp = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export function renderTranscript(
  segments: { id: number; speaker: string; text: string; startMs: number }[],
  hints: { segmentId: number | null; hint: CoachHint }[],
): string {
  const byTurn = new Map<number, CoachHint>();
  for (const h of hints) if (h.segmentId != null) byTurn.set(h.segmentId, h.hint);
  return segments
    .map((s) => {
      const line = `[${stamp(s.startMs)}] ${s.speaker === 'them' ? 'THEM' : 'ME'}: ${s.text}`;
      const h = byTurn.get(s.id);
      return h?.probing ? `${line}\n   (coach card: probing "${h.probing}")` : line;
    })
    .join('\n');
}

/** Writes the debrief for an ended session and logs it as an Interview activity. */
export async function debriefSession(
  db: Db,
  sessionId: number,
  opts: { provider?: LLMProvider; now?: Date } = {},
): Promise<Debrief> {
  const session = getSession(db, sessionId);
  if (!session.endedAt) throw new DebriefNotReadyError('The call has not ended yet.');
  if (session.summary) return session.summary;
  const ctx = loadCoachContext(db, sessionId);
  const provider = opts.provider ?? getProvider();
  const model = getSettings().model;
  const asked = session.askedQuestions;
  const res = await provider.completeStructured({
    system: DEBRIEF_SYSTEM_PROMPT,
    prompt: `${renderContext(ctx)}

<questions_the_applicant_asked>
${asked.length ? asked.join('\n') : 'none recorded'}
</questions_the_applicant_asked>

<transcript>
${renderTranscript(session.segments, session.hints) || '(no speech was transcribed)'}
</transcript>

Write the debrief.`,
    schema: debriefSchema,
    model,
    effort: 'medium',
    maxTokens: 8000,
  });
  const usageId = recordUsage(db, {
    feature: 'debrief',
    provider: res.provider,
    model: res.model,
    usage: res.usage,
    applicationId: ctx.applicationId,
    companyId: ctx.companyId,
    trace: res.trace,
  });
  const first = res.data.summary.split(/(?<=[.!?])\s/)[0] ?? res.data.summary;
  const activity = addActivity(
    db,
    ctx.applicationId,
    {
      at: (session.startedAt ?? session.createdAt).slice(0, 10),
      kind: 'Interview',
      summary: `${session.round}: ${first}`.slice(0, 500),
    },
    opts.now,
  );
  saveDebrief(db, sessionId, res.data, usageId, activity.id);
  return res.data;
}

export class DebriefNotReadyError extends Error {}
