import { desc, eq } from 'drizzle-orm';
import { LLMError, getProvider, type LLMProvider } from '@jm/ai';
import {
  RESEARCH_MAX_AGE_DAYS,
  companyResearchSchema,
  estimateCostUsd,
  pricingFor,
  splitLines,
  type CompanyResearch,
} from '@jm/shared';
import type { Db } from '../db/client.ts';
import { companies, companyResearch, jobs } from '../db/schema.ts';
import { startRun } from './aiEvents.ts';
import { NotFoundError } from './applications.ts';
import { getProfile } from './resume.ts';
import { currentEffort, getSettings } from './settings.ts';
import { recordUsage } from './usage.ts';

/** Searches allowed per brief — the main cost driver after tokens. */
export const RESEARCH_MAX_SEARCHES = 8;

export const RESEARCH_SYSTEM_PROMPT = `You research companies for an experienced job seeker deciding whether to pursue a role. Use web search to build a short, factual, cited brief.

How to search (important — the search budget is small):
- Run ONE or TWO searches at a time, read what comes back, then decide the next search. Never fire all your searches at once.
- When you filter or summarize results in code, keep each result's title, URL, date and a snippet so you can cite it; don't filter so strictly that nothing survives.
- If a search returns nothing useful, rephrase it rather than giving up.

Rules:
- Search for: recent news (last ~90 days: earnings, layoffs, reorganizations, leadership changes, funding, launches), employee reviews and culture (Glassdoor, Blind, Comparably, Indeed), return-to-office policy, the TPM / program management org and interview process, TPM pay bands (levels.fyi), and stock or funding status.
- Every claim must be supported by a source you actually read. Give each source a numeric id in "sources" and reference it in sourceIds. Never invent URLs, dates, ratings or numbers; if something isn't found, use null or leave the list empty and say so in the summary.
- Prefer the most recent information and say when something may be out of date.
- Flags are the point of the brief: 3-8 red/green flags about this company that matter to THIS candidate, using their profile (target level, must-haves, deal-breakers, strong pluses, known gaps). E.g. a return-to-office policy that conflicts with their office-day limit is a red flag; an AI/agentic platform push that matches their strengths is a green flag. Most important first.
- Keep every text field concise: one to three sentences.
- Flag titles are 3-6 word labels that read on their own in a short list; the detail goes in the other fields.
- culture.officeDaysPerWeek: the number of office days per week the current policy requires, if a source states it.
- Voice: write to the job seeker directly, in the second person ("you", "your"). Never use their name or "the candidate".`;

export interface ResearchContext {
  applicationId?: number;
  jobTitle?: string | null;
  jobUrl?: string | null;
}

export function buildResearchPrompt(
  company: string,
  ctx: ResearchContext,
  profile: ReturnType<typeof getProfile>,
  today = new Date(),
): string {
  const list = (s: string | null) =>
    splitLines(s)
      .map((l) => `- ${l}`)
      .join('\n') || 'None stated.';
  return `Today is ${today.toISOString().slice(0, 10)}.

Research this company: ${company}
The candidate is looking at: ${ctx.jobTitle ?? 'a role there'}${ctx.jobUrl ? ` (${ctx.jobUrl})` : ''}

<candidate_profile>
<background_and_target>
${profile.goals?.trim() || 'None stated.'}
</background_and_target>
<minimum_base_salary>${profile.minBase ? `$${profile.minBase.toLocaleString('en-US')}` : 'not set'}</minimum_base_salary>
<must_haves>
${list(profile.mustHaves)}
</must_haves>
<deal_breakers>
${list(profile.dealBreakers)}
</deal_breakers>
<strong_pluses>
${list(profile.strongPluses)}
</strong_pluses>
<known_gaps>
${list(profile.knownGaps)}
</known_gaps>
</candidate_profile>

Produce the brief.`;
}

export type ResearchRow = Omit<typeof companyResearch.$inferSelect, 'result'> & {
  result: CompanyResearch;
};

export function latestResearch(db: Db, companyId: number): ResearchRow | null {
  const row = db
    .select()
    .from(companyResearch)
    .where(eq(companyResearch.companyId, companyId))
    .orderBy(desc(companyResearch.createdAt), desc(companyResearch.id))
    .get();
  return row ? (row as ResearchRow) : null;
}

/**
 * Older than RESEARCH_MAX_AGE_DAYS — shown as a hint only. Briefs are never redone
 * automatically; only Refresh (force) replaces one.
 */
export function isStale(row: ResearchRow | null, now = new Date()): boolean {
  if (!row) return true;
  return (now.getTime() - Date.parse(row.createdAt)) / 86_400_000 > RESEARCH_MAX_AGE_DAYS;
}

/** One research run per company at a time — parallel jobs at the same company share it. */
const inflight = new Map<number, Promise<ResearchRow>>();

/**
 * Returns the company's brief, researching only when it has none — or when forced (Refresh).
 * An existing brief is reused however old it is; `reused` means no AI call, no cost.
 */
export async function ensureResearch(
  db: Db,
  companyId: number,
  opts: { force?: boolean; provider?: LLMProvider } & ResearchContext = {},
): Promise<{ research: ResearchRow; reused: boolean }> {
  const provider = opts.provider ?? getProvider();
  const current = latestResearch(db, companyId);
  if (!opts.force && current) return { research: current, reused: true };
  const running = inflight.get(companyId);
  if (running) return { research: await running, reused: true };
  const p = researchCompany(db, companyId, { ...opts, provider }).finally(() =>
    inflight.delete(companyId),
  );
  inflight.set(companyId, p);
  return { research: await p, reused: false };
}

async function researchCompany(
  db: Db,
  companyId: number,
  opts: { provider: LLMProvider } & ResearchContext,
): Promise<ResearchRow> {
  const company = db.select().from(companies).where(eq(companies.id, companyId)).get();
  if (!company) throw new NotFoundError(`Company ${companyId} not found`);
  // Default context: the company's most recent job.
  const job =
    opts.jobTitle !== undefined
      ? { title: opts.jobTitle, url: opts.jobUrl ?? null }
      : db
          .select({ title: jobs.title, url: jobs.url })
          .from(jobs)
          .where(eq(jobs.companyId, companyId))
          .orderBy(desc(jobs.id))
          .get();
  const { provider } = opts;
  const model = getSettings().researchModel;
  const run = startRun(`Researching ${company.name}`, opts.applicationId ?? null, companyId);
  run.step(
    `Researching ${company.name} with web search`,
    `up to ${RESEARCH_MAX_SEARCHES} searches · ${pricingFor(model)?.label ?? model}`,
  );

  let phase: 'searching' | 'writing' = 'searching';
  let res: Awaited<ReturnType<typeof provider.completeStructured<typeof companyResearchSchema>>>;
  try {
    res = await provider.completeStructured({
      system: RESEARCH_SYSTEM_PROMPT,
      prompt: buildResearchPrompt(
        company.name,
        { jobTitle: job?.title, jobUrl: job?.url },
        getProfile(db),
      ),
      schema: companyResearchSchema,
      model,
      effort: currentEffort(),
      maxTokens: 16000,
      webSearch: { maxUses: RESEARCH_MAX_SEARCHES },
      // The brief's schema is too large for the API's enforced-JSON grammar (it returns
      // "compiled grammar is too large"), so the schema goes in the prompt and is validated.
      constrained: false,
      onEvent: (e) => {
        if (e.type === 'search') run.step(`Searching: "${e.query}"`);
        else if (e.type === 'searchResults') run.step(`${e.count} results`);
        else if (e.type === 'thinking') run.emit({ type: 'thinking', text: e.text });
        else if (e.type === 'output') {
          if (phase !== 'writing' && e.text.includes('{')) {
            run.step('Writing the brief…');
            phase = 'writing';
          }
          run.emit({ type: 'output', text: e.text });
        }
      },
    });
  } catch (err) {
    const trace = err instanceof LLMError ? err.trace : undefined;
    const usageId = trace
      ? recordUsage(db, {
          feature: 'research',
          provider: provider.name,
          model,
          applicationId: opts.applicationId,
          companyId,
          trace,
          error: (err as Error).message,
        })
      : null;
    run.emit({ type: 'error', text: (err as Error).message, usageId });
    throw err;
  }

  const r = res.data;
  const empty = r.sources.length === 0;
  const usageId = recordUsage(db, {
    feature: 'research',
    provider: res.provider,
    model: res.model,
    usage: res.usage,
    applicationId: opts.applicationId,
    companyId,
    trace: res.trace,
    ...(empty && { error: 'No sources found — brief not saved' }),
  });
  if (empty) {
    const msg = `Research found no usable sources (${res.usage?.webSearches ?? 0} searches) — nothing saved. Try Refresh.`;
    run.emit({ type: 'error', text: msg, usageId });
    throw new LLMError(msg);
  }
  const row = db
    .insert(companyResearch)
    .values({
      companyId,
      model: res.model,
      usageId,
      ticker: r.snapshot.ticker?.trim().toUpperCase() || null,
      result: r,
    })
    .returning()
    .get() as ResearchRow;
  const cost = res.usage ? estimateCostUsd(res.model, res.usage) : null;
  run.emit({
    type: 'done',
    text: `Brief ready: ${r.flags.length} flags, ${r.news.length} news items, ${r.sources.length} sources · ${res.usage?.webSearches ?? 0} searches${cost != null ? ` · ~$${cost.toFixed(2)}` : ''}`,
    usageId,
  });
  return row;
}
