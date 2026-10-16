import { and, desc, eq, isNotNull } from 'drizzle-orm';
import {
  jobTrack,
  type CompanyResearch,
  type Debrief,
  type FitResult,
  type PrepCard,
} from '@jm/shared';
import type { Db } from '../../db/client.ts';
import {
  applicationAnswers,
  applications,
  companies,
  contacts,
  fitAssessments,
  interviewSessions,
  jobs,
} from '../../db/schema.ts';
import { NotFoundError } from '../applications.ts';
import { latestResearch } from '../research.ts';
import { getProfile, resumeForTrack } from '../resume.ts';
import { getSessionRow } from './store.ts';

/** Everything the coach knows about the applicant and the role, gathered once per call. */
export interface CoachContext {
  applicationId: number;
  companyId: number;
  company: string;
  title: string;
  round: string;
  description: string | null;
  resume: string | null;
  careerProfile: string | null;
  goals: string | null;
  fit: FitResult | null;
  brief: CompanyResearch | null;
  answers: { question: string; answer: string }[];
  /** Names on file at the company, so the transcriber spells them right. */
  contactNames: string[];
  earlier: { round: string; date: string; summary: Debrief }[];
  prep: PrepCard | null;
}

export function loadCoachContext(db: Db, sessionId: number): CoachContext {
  const session = getSessionRow(db, sessionId);
  const row = db
    .select({ job: jobs, company: companies })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(eq(applications.id, session.applicationId))
    .get();
  if (!row) throw new NotFoundError(`Application ${session.applicationId} not found`);

  const fit = db
    .select({ result: fitAssessments.result })
    .from(fitAssessments)
    .where(eq(fitAssessments.jobId, row.job.id))
    .orderBy(desc(fitAssessments.createdAt), desc(fitAssessments.id))
    .get();
  const research = latestResearch(db, row.company.id);
  const profile = getProfile(db);
  const earlier = db
    .select()
    .from(interviewSessions)
    .where(
      and(
        eq(interviewSessions.applicationId, session.applicationId),
        isNotNull(interviewSessions.summary),
      ),
    )
    .orderBy(interviewSessions.id)
    .all()
    .filter((s) => s.id !== sessionId);

  return {
    applicationId: session.applicationId,
    companyId: row.company.id,
    company: row.company.name,
    title: row.job.title,
    round: session.round,
    description: row.job.descriptionText,
    resume: resumeForTrack(db, jobTrack(row.job))?.rawText ?? null,
    careerProfile: profile.careerProfile,
    goals: profile.goals,
    fit: (fit?.result as FitResult | undefined)?.parts ? (fit!.result as FitResult) : null,
    brief: (research?.result as CompanyResearch | undefined) ?? null,
    answers: db
      .select({ question: applicationAnswers.question, answer: applicationAnswers.answer })
      .from(applicationAnswers)
      .where(eq(applicationAnswers.applicationId, session.applicationId))
      .orderBy(applicationAnswers.id)
      .all(),
    contactNames: db
      .select({ name: contacts.name })
      .from(contacts)
      .where(eq(contacts.companyId, row.company.id))
      .all()
      .map((c) => c.name),
    earlier: earlier.map((s) => ({
      round: s.round,
      date: (s.startedAt ?? s.createdAt).slice(0, 10),
      summary: s.summary as Debrief,
    })),
    prep: (session.prep as PrepCard | null) ?? null,
  };
}

const clip = (s: string | null | undefined, n: number) =>
  !s ? '' : s.length > n ? `${s.slice(0, n)}…` : s;

/**
 * The applicant context as one stable block. It is the cached prefix of every coach call, so it
 * must render byte-for-byte the same each time: no timestamps, no ids, fixed clip sizes.
 */
export function renderContext(c: CoachContext): string {
  const b = c.brief;
  const brief = b
    ? [
        `What they do: ${b.snapshot.whatTheyDo}`,
        `Momentum: ${b.momentum.summary}`,
        ...b.flags.map((f) => `${f.tone === 'green' ? '+' : '-'} ${f.title}: ${f.detail}`),
        b.interview.process ? `Interview process: ${b.interview.process}` : '',
        b.interview.rounds.length ? `Rounds: ${b.interview.rounds.join(' → ')}` : '',
        ...b.interview.tips.map((t) => `Interview tip: ${t}`),
        ...b.questionsToAsk.map((q) => `Question to ask: ${q}`),
      ]
        .filter(Boolean)
        .join('\n')
    : 'none';
  const fit = c.fit
    ? [
        `Summary: ${c.fit.summary}`,
        ...c.fit.strengths.map((s) => `Strength: ${s.point} (evidence: ${s.evidence})`),
        ...c.fit.gaps.map((g) => `Gap (${g.severity}): ${g.gap}. Handle it: ${g.mitigation}`),
        ...c.fit.interviewFocus.map((t) => `They will probe: ${t}`),
        ...c.fit.talkingPoints.map((t) => `Talking point: ${t}`),
      ].join('\n')
    : 'none';
  const answers = c.answers.length
    ? clip(c.answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n'), 6_000)
    : 'none';
  const earlier = c.earlier.length
    ? c.earlier
        .map(
          (e) =>
            `${e.round} (${e.date}): ${e.summary.summary}\nThey shared: ${e.summary.theyShared.join('; ') || 'nothing noted'}\nYou promised: ${e.summary.followUps.join('; ') || 'nothing'}`,
        )
        .join('\n\n')
    : 'none';
  return `<role>${c.title} at ${c.company}</role>
<round>${c.round}</round>

<job_description>
${clip(c.description, 12_000)}
</job_description>

<applicant_resume>
${clip(c.resume, 15_000)}
</applicant_resume>

<applicant_career_profile>
${clip(c.careerProfile, 15_000) || 'none'}
</applicant_career_profile>

<applicant_goals>
${clip(c.goals, 3_000) || 'none'}
</applicant_goals>

<fit_notes>
${fit}
</fit_notes>

<company_brief>
${brief}
</company_brief>

<drafted_answers>
${answers}
</drafted_answers>

<earlier_rounds>
${earlier}
</earlier_rounds>

<prep_card>
${c.prep ? JSON.stringify(c.prep) : 'none'}
</prep_card>`;
}
