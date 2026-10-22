import { and, desc, eq, like } from 'drizzle-orm';
import { z } from 'zod';
import type { MailClient } from '@jm/mail';
import { getProvider, prescreenConfig, type LLMProvider } from '@jm/ai';
import { jobTrack, shortText, type CompanyResearch, type FitResult, type Status } from '@jm/shared';
import type { Db } from '../db/client.ts';
import {
  activities,
  applicationAnswers,
  applications,
  companies,
  fitAssessments,
  jobs,
  siteTemplates,
  statusEvents,
} from '../db/schema.ts';
import { NotFoundError, listApplications, type ApplicationRow } from './applications.ts';
import { latestResearch, isStale } from './research.ts';
import { getProfile, resumeForTrack } from './resume.ts';
import { SHARED_HOSTS, findTrackedByUrl, jobPostingFromJsonLd, normalizeUrl } from './screening.ts';
import { companyFinder, companyKey, resolveIdentity, type KnownCompany } from './jobIdentity.ts';
import { embeddedJobId, fetchJobPosting, oracleJobId, type FetchedJob } from './jobfetch.ts';
import { emailContext, outlookMessageId } from './mail/outlookPage.ts';
import { currentEffort, getSettings } from './settings.ts';
import { getStock, type StockQuote } from './stock.ts';
import { getUsageSummary, recordUsage } from './usage.ts';

// ---------- matching a page to what you already track ----------

export { SHARED_HOSTS };

export { companyKey };

const TITLE_STOP = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'for',
  'to',
  'in',
  'at',
  'remote',
  'us',
  'usa',
]);

/** Words of a job title, normalised: "Sr. TPM, Payments (Remote)" → {senior, tpm, payments}. */
function titleWords(title: string): Set<string> {
  const t = title
    .toLowerCase()
    .replace(/\bsr\b\.?/g, 'senior')
    .replace(/\btechnical program manager\b/g, 'tpm')
    .replace(/[^a-z0-9 ]+/g, ' ');
  return new Set(t.split(/\s+/).filter((w) => w && !TITLE_STOP.has(w)));
}

/** Share of title words in common (Jaccard, 0–1). */
export function titleOverlap(a: string, b: string): number {
  const x = titleWords(a);
  const y = titleWords(b);
  if (!x.size || !y.size) return 0;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared);
}

/** Same role, near enough: most words shared (Jaccard ≥ 0.75). */
export function similarTitles(a: string, b: string): boolean {
  return titleOverlap(a, b) >= 0.75;
}

const hostOf = (url: string | null | undefined) => {
  try {
    return url ? new URL(url).hostname.toLowerCase().replace(/^www\./, '') : null;
  } catch {
    return null;
  }
};

export const pageInputSchema = z.object({
  url: z.string().trim().url(),
  pageTitle: shortText(2000),
  // Oversized or surplus blocks are dropped rather than failing the whole request.
  jsonLd: z
    .array(z.string())
    .nullable()
    .optional()
    .transform((a) => a?.filter((s) => s.length <= 200_000).slice(0, 20)),
  /** Read by a site template or the LinkedIn reader (first line, clipped). */
  fields: z
    .object({
      title: shortText(),
      company: shortText(),
    })
    .nullable()
    .optional(),
});
export type PageInput = z.input<typeof pageInputSchema>;

/** What the side panel shows about one application. */
/**
 * For a closed application (passed, rejected, withdrawn, ghosted): when that happened and, for a
 * pass, the reason you gave ("Passed: 5 days onsite").
 */
const DECIDED: readonly Status[] = ['Passed', 'Rejected', 'Withdrawn', 'Ghosted'];

function decisionOf(db: Db, r: ApplicationRow) {
  if (!DECIDED.includes(r.status)) return null;
  const ev = db
    .select({ at: statusEvents.at })
    .from(statusEvents)
    .where(and(eq(statusEvents.applicationId, r.id), eq(statusEvents.toStatus, r.status)))
    .orderBy(desc(statusEvents.at), desc(statusEvents.id))
    .get();
  const note =
    r.status === 'Passed'
      ? db
          .select({ summary: activities.summary })
          .from(activities)
          .where(and(eq(activities.applicationId, r.id), like(activities.summary, 'Passed%')))
          .orderBy(desc(activities.at), desc(activities.id))
          .get()
      : undefined;
  const reason = note?.summary?.replace(/^Passed(:\s*|\s+at screening\s*)/i, '').trim() || null;
  return { status: r.status, at: ev?.at ?? r.updatedAt, reason };
}

/** The latest fit score's short form for the panel: labels, not paragraphs. */
function fitDetail(db: Db, jobId: number) {
  const row = db
    .select({ result: fitAssessments.result, createdAt: fitAssessments.createdAt })
    .from(fitAssessments)
    .where(eq(fitAssessments.jobId, jobId))
    .orderBy(desc(fitAssessments.createdAt), desc(fitAssessments.id))
    .get();
  const f = row?.result as FitResult | undefined;
  if (!f?.parts) return null;
  return {
    scoredAt: row!.createdAt,
    verdict: f.verdict,
    whyNotHigher: f.whyNotHigher,
    strengths: f.strengths.map((s) => s.label ?? s.point).slice(0, 4),
    gaps: f.gaps
      .filter((g) => g.severity !== 'Minor')
      .map((g) => g.label ?? g.gap)
      .slice(0, 4),
    levelMismatch: f.flags.levelMismatch,
    parts: Object.fromEntries(Object.entries(f.parts).map(([k, v]) => [k, v.score])),
  };
}

function summary(db: Db, r: ApplicationRow) {
  return {
    decision: decisionOf(db, r),
    applicationId: r.id,
    createdAt: r.createdAt,
    title: r.title,
    company: r.company,
    status: r.status,
    appliedAt: r.appliedAt,
    url: r.url,
    fitScore: r.fitScore,
    fitVerdict: r.fitVerdict,
    fitGate: r.fitGate,
    fitGateReasons: r.fitGateReasons,
    prescreenVerdict: r.prescreenVerdict,
    prescreenScore: r.prescreenScore,
    prescreenReason: r.prescreenReason,
    prescreenModel: r.prescreenModel,
    nextAction: r.nextAction,
    nextActionDate: r.nextActionDate,
    lastActivityAt: r.lastActivityAt,
  };
}
export type AppSummary = ReturnType<typeof summary>;

/** The company brief boiled down for a narrow panel. */
function briefSummary(r: NonNullable<ReturnType<typeof latestResearch>>) {
  const b = r.result as CompanyResearch;
  const rating = b.culture.ratings[0];
  return {
    researchedAt: r.createdAt,
    stale: isStale(r),
    green: b.flags.filter((f) => f.tone === 'green').map((f) => f.title),
    red: b.flags.filter((f) => f.tone === 'red').map((f) => f.title),
    trend: b.momentum.trend,
    momentum: b.momentum.summary,
    rating: rating ? { site: rating.site, rating: rating.rating } : null,
    officeDaysPerWeek: b.culture.officeDaysPerWeek ?? null,
    ownership: b.snapshot.ownership,
    ticker: b.snapshot.ticker,
    fundingStage: b.snapshot.fundingStage,
    lastFunding: b.snapshot.lastFunding,
    whatTheyDo: b.snapshot.whatTheyDo,
  };
}

/**
 * Everything the side panel needs for the page you're on: is this posting tracked (or one very
 * like it), which company is it, what do we know about that company, and what would scoring cost.
 */
const boardCache = new Map<string, { at: number; job: FetchedJob | null }>();
/**
 * The posting behind an embedded job board on a careers page, or behind an Oracle Recruiting
 * page (whose address and tab title don't name the employer); null if neither, or it failed.
 */
async function boardPosting(url: string, fetchFn?: typeof fetch) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!embeddedJobId(u) && !oracleJobId(u)) return null;
  const hit = boardCache.get(url);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.job;
  const job = await fetchJobPosting(url, fetchFn).catch(() => null);
  const found = job && /API/.test(job.via) ? job : null;
  boardCache.set(url, { at: Date.now(), job: found });
  return found;
}

export async function pageContext(
  db: Db,
  raw: PageInput,
  opts: { fetchFn?: typeof fetch; mail?: MailClient } = {},
) {
  const input = pageInputSchema.parse(raw);
  const url = normalizeUrl(input.url);
  const rows = listApplications(db);
  const byId = new Map(rows.map((r) => [r.id, r]));
  // An email open in Outlook on the web: the job it became, or the posting it links to.
  const emailId = outlookMessageId(input.url);
  const email = emailId ? await emailContext(db, opts.mail, emailId) : null;
  const hit = email
    ? email.applicationId
      ? { applicationId: email.applicationId }
      : email.detected.postingUrl
        ? findTrackedByUrl(db, normalizeUrl(email.detected.postingUrl))
        : null
    : findTrackedByUrl(db, url);
  const tracked = hit ? byId.get(hit.applicationId) : undefined;

  // What the page says it is (no network, no AI). Outlook's own page says nothing about the job.
  const ld = email ? null : jobPostingFromJsonLd(input.jsonLd);
  // A careers page embedding a job board (?ashby_jid=, ?gh_jid=): the page is only a shell, so
  // ask the board what the job is (cached briefly; no AI).
  const board = tracked || email ? null : await boardPosting(url, opts.fetchFn);
  const find = companyFinder(db);
  // Checked the same way as a capture, so the panel shows what Save would store.
  const who = email
    ? null
    : resolveIdentity(
        { url, template: input.fields, fetched: board, ld, pageTitle: input.pageTitle },
        find,
      );
  const detected = {
    title: email?.detected.title || who?.title || null,
    company: email?.detected.company || (who?.stated ? who.company : null) || null,
  };

  // Which company: the tracked job's, then names the page states, then what the address says.
  const all = db
    .select({ id: companies.id, name: companies.name, website: companies.website })
    .from(companies)
    .all();
  const asRow = (k: KnownCompany | null | undefined) =>
    k ? all.find((c) => c.id === k.id) : undefined;
  // Outlook's address says nothing about the company.
  const host = email ? null : hostOf(url);
  const learnedHosts = new Map<string, Set<number>>();
  for (const r of rows) {
    const h = hostOf(r.url);
    if (h && !SHARED_HOSTS.test(h))
      learnedHosts.set(h, (learnedHosts.get(h) ?? new Set()).add(r.companyId));
  }
  const hostCompany = (() => {
    const ids = host ? learnedHosts.get(host) : undefined;
    return ids?.size === 1 ? all.find((c) => c.id === [...ids][0]) : undefined;
  })();
  const company =
    (tracked && all.find((c) => c.id === tracked.companyId)) ??
    asRow(email ? find(email.detected.company) : who?.stated ? who.known : undefined) ??
    hostCompany ??
    // What the address or tab title suggests: careers.oracle.com → Oracle.
    asRow(who && !who.stated ? who.known : undefined) ??
    (host ? all.find((c) => hostOf(c.website) === host) : undefined);
  if (!detected.company && !email) detected.company = company?.name ?? who?.company ?? null;

  // The same role under another address (e.g. the LinkedIn copy of a company-site posting).
  const similar =
    tracked || !company || !detected.title
      ? []
      : rows.filter((r) => r.companyId === company.id && similarTitles(r.title, detected.title!));

  const research = company ? latestResearch(db, company.id) : null;
  const brief = research ? briefSummary(research) : null;
  let stock: StockQuote | null = null;
  if (brief?.ownership === 'Public' && brief.ticker) {
    try {
      stock = await getStock(brief.ticker, opts.fetchFn);
    } catch {
      // price is a nice-to-have
    }
  }

  const { forecast } = getUsageSummary(db);
  const tpl = host ? getTemplate(db, host) : null;
  return {
    url,
    detected,
    email,
    tracked: tracked ? { ...summary(db, tracked), fit: fitDetail(db, tracked.jobId) } : null,
    similar: similar.map((r) => summary(db, r)),
    company: company
      ? {
          id: company.id,
          name: company.name,
          brief,
          stock: stock && {
            ticker: stock.ticker,
            price: stock.price,
            currency: stock.currency,
            change1yPct: stock.change1yPct,
            series: stock.series.map((p) => p.close),
          },
          applications: rows
            .filter((r) => r.companyId === company.id && r.id !== tracked?.id)
            .map((r) => summary(db, r)),
        }
      : null,
    costs: {
      fit: forecast.perCallUsd,
      research: forecast.researchPerCallUsd,
      /** Scoring researches the company only when it has no brief yet. */
      researchNeeded: !research,
      answer: ANSWER_ESTIMATE_USD,
      /** Each question after the first, when drafting the whole form at once. */
      answerEachExtra: ANSWER_EACH_EXTRA_USD,
    },
    /** The free pre-screen model, when one is set up (null = not yet). */
    prescreen: prescreenConfig().ready ? { model: prescreenConfig().model } : null,
    template: tpl,
  };
}
export type PageContext = Awaited<ReturnType<typeof pageContext>>;

// ---------- site templates ----------

export const TEMPLATE_FIELDS = ['title', 'company', 'location', 'salary', 'description'] as const;
export const templateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  selectors: z.partialRecord(z.enum(TEMPLATE_FIELDS), z.string().trim().min(1).max(1000)),
});

export function getTemplate(db: Db, host: string) {
  const row = db
    .select()
    .from(siteTemplates)
    .where(eq(siteTemplates.host, host.toLowerCase()))
    .get();
  return row
    ? {
        host: row.host,
        name: row.name,
        selectors: row.selectors as z.infer<typeof templateSchema>['selectors'],
        updatedAt: row.updatedAt,
      }
    : null;
}

export function saveTemplate(db: Db, host: string, t: z.infer<typeof templateSchema>) {
  const h = host.toLowerCase();
  const now = new Date().toISOString();
  db.insert(siteTemplates)
    .values({ host: h, name: t.name, selectors: t.selectors, updatedAt: now })
    .onConflictDoUpdate({
      target: siteTemplates.host,
      set: { name: t.name, selectors: t.selectors, updatedAt: now },
    })
    .run();
  return getTemplate(db, h)!;
}

export function deleteTemplate(db: Db, host: string) {
  db.delete(siteTemplates).where(eq(siteTemplates.host, host.toLowerCase())).run();
}

// ---------- application answers ----------

/** Before any history: ~12k tokens in, ~600 out on Opus 5.5. */
const ANSWER_ESTIMATE_USD = 0.06;
/** Drafting the whole form in one go: the context once, then each further answer's output. */
const ANSWER_EACH_EXTRA_USD = 0.02;

const maxLengthSchema = z.number().int().positive().max(20_000).nullable().optional();

export const answerRequestSchema = z.object({
  applicationId: z.number().int(),
  question: z.string().trim().min(3).max(2000),
  /** The form field's maxlength, if it has one. */
  maxLength: maxLengthSchema,
  /** The form's other questions, with what's drafted or typed for them so far. */
  otherQuestions: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(2000),
        answer: z.string().max(20_000).nullable().optional(),
      }),
    )
    .max(20)
    .optional(),
});

/** Every written question on the form, drafted together. */
export const answersRequestSchema = z.object({
  applicationId: z.number().int(),
  questions: z
    .array(z.object({ question: z.string().trim().min(3).max(2000), maxLength: maxLengthSchema }))
    .min(1)
    .max(15),
});

export const answerSchema = z.object({
  answer: z.string().describe('The answer, plain text, ready to paste'),
  basedOn: z
    .string()
    .describe(
      'One short line: what the answer draws on, e.g. "Your agentic AI work + their AI agents launch"',
    ),
});

export const allAnswersSchema = z.object({
  plan: z
    .string()
    .describe(
      'Written first, before any answer: one line per question naming what it is really asking and the evidence it gets. Each story, project and number goes to the one question it answers best.',
    ),
  answers: z.array(
    answerSchema.extend({ number: z.number().int().describe('The question number, from 1') }),
  ),
});

const ANSWER_RULES = `- First person, as the applicant ("I led…"). Warm, direct and specific; no clichés ("I'm passionate about", "I'm excited to", "fast-paced environment"), no flattery, no filler.
- Use only facts from the resume, career profile, LinkedIn profile, goals and fit notes for claims about the applicant — never invent employers, numbers or projects. Use the company brief and job description for why this company and role; name concrete things (a product, a program, a stated priority) rather than generic praise.
- Tie the applicant's strongest relevant evidence to what this role needs.
- Fit the length: stay under the character limit when one is given (aim for ~85% of it); otherwise 80–150 words for "why" questions, 1–3 sentences for short factual ones.
- If the question asks for something the inputs don't cover (salary expectations, visa status, start date, references), give a short, sensible answer with a [fill in] placeholder instead of guessing.
- Plain text only: no markdown, no headings, no bullet symbols unless the question asks for a list.`;

export const ANSWER_SYSTEM_PROMPT = `You draft answers to job application questions for a job seeker, written as them.

Rules:
${ANSWER_RULES}
- The form's other questions are answered separately, and a reader sees them all together. Answer only what this question asks: leave a topic another question asks for directly (why this company, a specific project, logistics) to that question. Don't reuse the stories, projects, numbers or phrasing already in the other answers; pick different evidence. Mention something again only when this question can't be answered without it, and then briefly.`;

export const ALL_ANSWERS_SYSTEM_PROMPT = `You draft every written answer on a job application form at once, for a job seeker, written as them. A reader sees the answers side by side, so together they should read as one application that covers the most ground, not one pitch repeated.

Plan before writing. Work out what each question is really asking, then share out the applicant's evidence: every story, project and number goes to the one question it answers best and appears only there. A topic a question asks for directly (why this company, a specific project, logistics) belongs to that question alone. Don't spend the strongest material on the first question by default — give it to the question it fits. Then write each answer from its share.

Rules:
${ANSWER_RULES}`;

const clip = (s: string | null | undefined, n: number) =>
  !s ? '' : s.length > n ? `${s.slice(0, n)}…` : s;

/** What every answer draws on: the role, the applicant and the company. */
type AnswerContext = {
  company: string;
  title: string;
  description: string | null;
  resume: string | null;
  /** Built from resume + LinkedIn (see careerProfile.ts). */
  careerProfile?: string | null;
  /** The full LinkedIn profile text, for detail the resume leaves out. */
  linkedin?: string | null;
  goals: string | null;
  fit: FitResult | null;
  brief: CompanyResearch | null;
};

function answerContext(i: AnswerContext): string {
  const brief = i.brief
    ? [
        `What they do: ${i.brief.snapshot.whatTheyDo}`,
        `Momentum: ${i.brief.momentum.summary}`,
        ...i.brief.flags.map((f) => `${f.tone === 'green' ? '+' : '-'} ${f.title}: ${f.detail}`),
        ...i.brief.news.slice(0, 5).map((n) => `News ${n.date}: ${n.headline} — ${n.summary}`),
      ].join('\n')
    : 'none';
  const fit = i.fit
    ? [
        `Summary: ${i.fit.summary}`,
        ...i.fit.strengths.map((s) => `Strength: ${s.point} (evidence: ${s.evidence})`),
        ...i.fit.talkingPoints.map((t) => `Talking point: ${t}`),
      ].join('\n')
    : 'none';
  return `<role>${i.title} at ${i.company}</role>

<job_description>
${clip(i.description, 12_000)}
</job_description>

<applicant_resume>
${clip(i.resume, 15_000)}
</applicant_resume>

<applicant_career_profile>
${clip(i.careerProfile, 15_000) || 'none'}
</applicant_career_profile>

<applicant_linkedin>
${clip(i.linkedin, 20_000) || 'none'}
</applicant_linkedin>

<applicant_goals>
${clip(i.goals, 3_000) || 'none'}
</applicant_goals>

<fit_notes>
${fit}
</fit_notes>

<company_brief>
${brief}
</company_brief>`;
}

export function buildAnswerPrompt(
  i: AnswerContext & {
    question: string;
    maxLength?: number | null;
    otherQuestions?: { question: string; answer?: string | null }[];
  },
): string {
  const others = i.otherQuestions?.length
    ? i.otherQuestions
        .map(
          (o) =>
            `<other_question>\nQ: ${o.question}\nA: ${clip(o.answer?.trim(), 3_000) || '(not answered yet)'}\n</other_question>`,
        )
        .join('\n')
    : 'none';
  return `<question>${i.question}</question>
<character_limit>${i.maxLength ?? 'none'}</character_limit>

${answerContext(i)}

<rest_of_this_form>
${others}
</rest_of_this_form>

Draft the applicant's answer to the question.`;
}

export function buildAllAnswersPrompt(
  i: AnswerContext & { questions: { question: string; maxLength?: number | null }[] },
): string {
  const questions = i.questions
    .map(
      (q, n) =>
        `<question number="${n + 1}" character_limit="${q.maxLength ?? 'none'}">${q.question}</question>`,
    )
    .join('\n');
  return `<questions>
${questions}
</questions>

${answerContext(i)}

Plan how the evidence is shared out, then draft the applicant's answer to every question.`;
}

/** The application's role, company, fit and brief, and your resume and profile. */
function loadAnswerContext(db: Db, applicationId: number) {
  const row = db
    .select({ job: jobs, company: companies })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(eq(applications.id, applicationId))
    .get();
  if (!row) throw new NotFoundError(`Application ${applicationId} not found`);
  const fit = db
    .select({ result: fitAssessments.result })
    .from(fitAssessments)
    .where(eq(fitAssessments.jobId, row.job.id))
    .orderBy(desc(fitAssessments.createdAt), desc(fitAssessments.id))
    .get();
  const research = latestResearch(db, row.company.id);
  const profile = getProfile(db);
  const context: AnswerContext = {
    company: row.company.name,
    title: row.job.title,
    description: row.job.descriptionText,
    resume: resumeForTrack(db, jobTrack(row.job))?.rawText ?? null,
    careerProfile: profile.careerProfile,
    linkedin: profile.linkedinText,
    goals: profile.goals,
    fit: (fit?.result as FitResult | undefined)?.parts ? (fit!.result as FitResult) : null,
    brief: (research?.result as CompanyResearch | undefined) ?? null,
  };
  return { companyId: row.company.id, context };
}

function saveAnswer(
  db: Db,
  a: { applicationId: number; question: string; maxLength?: number | null; answer: string },
  usageId: number,
) {
  let answer = a.answer.trim();
  if (a.maxLength && answer.length > a.maxLength) answer = answer.slice(0, a.maxLength).trimEnd();
  return db
    .insert(applicationAnswers)
    .values({ applicationId: a.applicationId, question: a.question, answer, usageId })
    .returning()
    .get();
}

/** Drafts an answer for a question on this application's form, saves it, and records the cost. */
export async function suggestAnswer(
  db: Db,
  req: z.infer<typeof answerRequestSchema>,
  opts: { provider?: LLMProvider } = {},
) {
  const { companyId, context } = loadAnswerContext(db, req.applicationId);
  const provider = opts.provider ?? getProvider();
  const res = await provider.completeStructured({
    system: ANSWER_SYSTEM_PROMPT,
    prompt: buildAnswerPrompt({
      ...context,
      question: req.question,
      maxLength: req.maxLength,
      otherQuestions: req.otherQuestions,
    }),
    schema: answerSchema,
    model: getSettings().model,
    effort: currentEffort(),
    maxTokens: 4000,
  });
  const usageId = recordUsage(db, {
    feature: 'answer',
    provider: res.provider,
    model: res.model,
    usage: res.usage,
    applicationId: req.applicationId,
    companyId,
    trace: res.trace,
  });
  const saved = saveAnswer(db, { ...req, answer: res.data.answer }, usageId);
  return { ...saved, basedOn: res.data.basedOn };
}

/**
 * Drafts every question on the form in one call, so the evidence is shared out across them
 * rather than the first answer taking the best of it. Saves each; a question the model skipped
 * comes back null.
 */
export async function suggestAllAnswers(
  db: Db,
  req: z.infer<typeof answersRequestSchema>,
  opts: { provider?: LLMProvider } = {},
) {
  const { companyId, context } = loadAnswerContext(db, req.applicationId);
  const provider = opts.provider ?? getProvider();
  const res = await provider.completeStructured({
    system: ALL_ANSWERS_SYSTEM_PROMPT,
    prompt: buildAllAnswersPrompt({ ...context, questions: req.questions }),
    schema: allAnswersSchema,
    model: getSettings().model,
    effort: currentEffort(),
    maxTokens: Math.min(4000 + 1500 * req.questions.length, 32_000),
  });
  const usageId = recordUsage(db, {
    feature: 'answer',
    provider: res.provider,
    model: res.model,
    usage: res.usage,
    applicationId: req.applicationId,
    companyId,
    trace: res.trace,
  });
  return {
    plan: res.data.plan,
    answers: req.questions.map((q, n) => {
      const a = res.data.answers.find((x) => x.number === n + 1);
      if (!a?.answer.trim()) return null;
      const saved = saveAnswer(
        db,
        { applicationId: req.applicationId, ...q, answer: a.answer },
        usageId,
      );
      return { ...saved, basedOn: a.basedOn };
    }),
  };
}

export function listAnswers(db: Db, applicationId: number) {
  return db
    .select()
    .from(applicationAnswers)
    .where(eq(applicationAnswers.applicationId, applicationId))
    .orderBy(desc(applicationAnswers.createdAt), desc(applicationAnswers.id))
    .all();
}

export function deleteAnswer(db: Db, id: number) {
  db.delete(applicationAnswers).where(eq(applicationAnswers.id, id)).run();
}
