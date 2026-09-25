import { and, desc, eq, like } from 'drizzle-orm';
import { z } from 'zod';
import { getProvider, type LLMProvider } from '@jm/ai';
import type { CompanyResearch, FitResult, Status } from '@jm/shared';
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
import { getDefaultResume, getProfile } from './resume.ts';
import {
  companyFromBoardUrl,
  findTrackedByUrl,
  jobPostingFromJsonLd,
  normalizeUrl,
  parsePageTitle,
} from './screening.ts';
import { currentEffort, getSettings } from './settings.ts';
import { getStock, type StockQuote } from './stock.ts';
import { getUsageSummary, recordUsage } from './usage.ts';

// ---------- matching a page to what you already track ----------

/** Hosts that serve many companies' jobs — a hostname there says nothing about the company. */
const SHARED_HOSTS =
  /(^|\.)(linkedin\.com|indeed\.com|glassdoor\.com|greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|workable\.com|wellfound\.com|builtin\.com|ziprecruiter\.com|google\.com|dice\.com|monster\.com|simplyhired\.com|otta\.com|welcometothejungle\.com)$/i;

/** "DocuSign, Inc." and "Docusign" → "docusign". */
export function companyKey(name: string | null | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(
      /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|ag|sa)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

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

/** Same role, near enough: most words shared (Jaccard ≥ 0.75). */
export function similarTitles(a: string, b: string): boolean {
  const x = titleWords(a);
  const y = titleWords(b);
  if (!x.size || !y.size) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared) >= 0.75;
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
  pageTitle: z.string().max(2000).nullable().optional(),
  jsonLd: z.array(z.string().max(200_000)).max(20).nullable().optional(),
  /** Read by a site template or the LinkedIn reader. */
  fields: z
    .object({
      title: z.string().max(500).nullable().optional(),
      company: z.string().max(500).nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type PageInput = z.infer<typeof pageInputSchema>;

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
    title: r.title,
    company: r.company,
    status: r.status,
    appliedAt: r.appliedAt,
    url: r.url,
    fitScore: r.fitScore,
    fitVerdict: r.fitVerdict,
    fitGate: r.fitGate,
    fitGateReasons: r.fitGateReasons,
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
export async function pageContext(db: Db, input: PageInput, opts: { fetchFn?: typeof fetch } = {}) {
  const url = normalizeUrl(input.url);
  const rows = listApplications(db);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const hit = findTrackedByUrl(db, url);
  const tracked = hit ? byId.get(hit.applicationId) : undefined;

  // What the page says it is (no network, no AI).
  const ld = jobPostingFromJsonLd(input.jsonLd);
  const fromTitle = parsePageTitle(input.pageTitle);
  const ldOrg =
    typeof ld?.hiringOrganization === 'string'
      ? ld.hiringOrganization
      : ld?.hiringOrganization?.name;
  const detected = {
    title: input.fields?.title?.trim() || ld?.title?.trim() || fromTitle.title || null,
    company: input.fields?.company?.trim() || ldOrg?.trim() || null,
  };

  // Which company: the tracked job's, then names the page states, then what the address says.
  const all = db
    .select({ id: companies.id, name: companies.name, website: companies.website })
    .from(companies)
    .all();
  const byKey = (name: string | null | undefined) => {
    const k = companyKey(name);
    return k ? all.find((c) => companyKey(c.name) === k) : undefined;
  };
  const host = hostOf(url);
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
    byKey(detected.company) ??
    hostCompany ??
    byKey(companyFromBoardUrl(url)) ??
    (host ? all.find((c) => hostOf(c.website) === host) : undefined) ??
    byKey(fromTitle.company);
  if (!detected.company)
    detected.company = company?.name ?? fromTitle.company ?? companyFromBoardUrl(url) ?? null;

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
    },
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

export const answerRequestSchema = z.object({
  applicationId: z.number().int(),
  question: z.string().trim().min(3).max(2000),
  /** The form field's maxlength, if it has one. */
  maxLength: z.number().int().positive().max(20_000).nullable().optional(),
});

export const answerSchema = z.object({
  answer: z.string().describe('The answer, plain text, ready to paste'),
  basedOn: z
    .string()
    .describe(
      'One short line: what the answer draws on, e.g. "Your agentic AI work + their AI agents launch"',
    ),
});

export const ANSWER_SYSTEM_PROMPT = `You draft answers to job application questions for a job seeker, written as them.

Rules:
- First person, as the applicant ("I led…"). Warm, direct and specific; no clichés ("I'm passionate about", "I'm excited to", "fast-paced environment"), no flattery, no filler.
- Use only facts from the resume, profile and fit notes for claims about the applicant — never invent employers, numbers or projects. Use the company brief and job description for why this company and role; name concrete things (a product, a program, a stated priority) rather than generic praise.
- Tie the applicant's strongest relevant evidence to what this role needs.
- Fit the length: stay under the character limit when one is given (aim for ~85% of it); otherwise 80–150 words for "why" questions, 1–3 sentences for short factual ones.
- If the question asks for something the inputs don't cover (salary expectations, visa status, start date, references), give a short, sensible answer with a [fill in] placeholder instead of guessing.
- Plain text only: no markdown, no headings, no bullet symbols unless the question asks for a list.`;

const clip = (s: string | null | undefined, n: number) =>
  !s ? '' : s.length > n ? `${s.slice(0, n)}…` : s;

export function buildAnswerPrompt(i: {
  question: string;
  maxLength?: number | null;
  company: string;
  title: string;
  description: string | null;
  resume: string | null;
  goals: string | null;
  fit: FitResult | null;
  brief: CompanyResearch | null;
}): string {
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
  return `<question>${i.question}</question>
<character_limit>${i.maxLength ?? 'none'}</character_limit>

<role>${i.title} at ${i.company}</role>

<job_description>
${clip(i.description, 12_000)}
</job_description>

<applicant_resume>
${clip(i.resume, 15_000)}
</applicant_resume>

<applicant_goals>
${clip(i.goals, 3_000) || 'none'}
</applicant_goals>

<fit_notes>
${fit}
</fit_notes>

<company_brief>
${brief}
</company_brief>

Draft the applicant's answer to the question.`;
}

/** Drafts an answer for a question on this application's form, saves it, and records the cost. */
export async function suggestAnswer(
  db: Db,
  req: z.infer<typeof answerRequestSchema>,
  opts: { provider?: LLMProvider } = {},
) {
  const row = db
    .select({ job: jobs, company: companies })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(eq(applications.id, req.applicationId))
    .get();
  if (!row) throw new NotFoundError(`Application ${req.applicationId} not found`);
  const fit = db
    .select({ result: fitAssessments.result })
    .from(fitAssessments)
    .where(eq(fitAssessments.jobId, row.job.id))
    .orderBy(desc(fitAssessments.createdAt), desc(fitAssessments.id))
    .get();
  const research = latestResearch(db, row.company.id);

  const provider = opts.provider ?? getProvider();
  const model = getSettings().model;
  const res = await provider.completeStructured({
    system: ANSWER_SYSTEM_PROMPT,
    prompt: buildAnswerPrompt({
      question: req.question,
      maxLength: req.maxLength,
      company: row.company.name,
      title: row.job.title,
      description: row.job.descriptionText,
      resume: getDefaultResume(db)?.rawText ?? null,
      goals: getProfile(db).goals,
      fit: (fit?.result as FitResult | undefined)?.parts ? (fit!.result as FitResult) : null,
      brief: (research?.result as CompanyResearch | undefined) ?? null,
    }),
    schema: answerSchema,
    model,
    effort: currentEffort(),
    maxTokens: 4000,
  });
  const usageId = recordUsage(db, {
    feature: 'answer',
    provider: res.provider,
    model: res.model,
    usage: res.usage,
    applicationId: req.applicationId,
    companyId: row.company.id,
    trace: res.trace,
  });
  let answer = res.data.answer.trim();
  if (req.maxLength && answer.length > req.maxLength)
    answer = answer.slice(0, req.maxLength).trimEnd();
  const saved = db
    .insert(applicationAnswers)
    .values({ applicationId: req.applicationId, question: req.question, answer, usageId })
    .returning()
    .get();
  return { ...saved, basedOn: res.data.basedOn };
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

const questionWords = (q: string) =>
  new Set(
    q
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter(
        (w) =>
          w.length > 2 &&
          !['you', 'your', 'the', 'and', 'for', 'why', 'what', 'this', 'with'].includes(w),
      ),
  );

/** Your earlier answers to questions like this one, best match first (free to reuse). */
export function similarAnswers(db: Db, question: string, limit = 3) {
  const q = questionWords(question);
  if (!q.size) return [];
  return db
    .select({
      id: applicationAnswers.id,
      question: applicationAnswers.question,
      answer: applicationAnswers.answer,
      createdAt: applicationAnswers.createdAt,
      applicationId: applicationAnswers.applicationId,
      company: companies.name,
      title: jobs.title,
    })
    .from(applicationAnswers)
    .innerJoin(applications, eq(applications.id, applicationAnswers.applicationId))
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .all()
    .map((a) => {
      const w = questionWords(a.question);
      const shared = [...q].filter((x) => w.has(x)).length;
      return { ...a, score: shared / (q.size + w.size - shared || 1) };
    })
    .filter((a) => a.score >= 0.5)
    .sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}
