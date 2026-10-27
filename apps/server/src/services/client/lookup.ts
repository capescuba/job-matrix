/**
 * Find client: a short web-search run that looks for the original posting behind an agency's
 * job. Paid, so it only runs when you press the button; the answer is kept on the job.
 */
import { and, eq } from 'drizzle-orm';
import { LLMError, getProvider, type LLMProvider } from '@jm/ai';
import {
  CLIENT_RUN_LABEL,
  clientGuessSchema,
  estimateCostUsd,
  pricingFor,
  type ClientCandidate,
} from '@jm/shared';
import type { Db } from '../../db/client.ts';
import { aiUsage, clientLookups } from '../../db/schema.ts';
import { startRun } from '../aiEvents.ts';
import type { FetchFn } from '../jobfetch.ts';
import { currentEffort, getSettings } from '../settings.ts';
import { recordUsage, repricedAverage } from '../usage.ts';
import { checkDirect } from './direct.ts';
import { agencyJob, clientState, jobOf, mergeCandidates, saveLookup } from './index.ts';

/** Searches allowed per lookup — the main cost driver after tokens. */
export const CLIENT_MAX_SEARCHES = 5;
/** Cost before any history exists, on Sonnet (scaled for other models). */
const CLIENT_ESTIMATE_USD = 0.3;
/** Enough of the email to carry the JD; agency emails are rarely longer. */
const MAX_BODY_CHARS = 8000;

export const CLIENT_SYSTEM_PROMPT = `A staffing agency is recruiting for a role on behalf of a client it doesn't name. Use web search to work out who the client is, so the job seeker can check whether the client posts the role itself and apply directly.

How to search (the search budget is small):
- Run ONE or TWO searches at a time, read the results, then decide the next one.
- Agencies usually paste the client's own job description. Search for distinctive exact phrases from it (in quotes): unusual product names, team names, internal jargon, specific tech stacks or numbers. Generic phrases ("cross-functional teams") find nothing useful.
- Combine what the email says about the client (industry, size, "Fortune N", location, products) with the role to narrow it down.
- Look for the role on company careers pages and job boards (Greenhouse, Lever, Ashby, Workday, LinkedIn). A posting with the same wording is the strongest evidence.

Rules:
- Only name a company the evidence points to. Never invent URLs; every evidence url must be a page you actually saw. If nothing credible turns up, return no candidates and say so in notes.
- careersUrl: the client's own posting for this role if you found it; otherwise its careers page or job board; null if unknown.
- confidence: high = the same posting or near-identical wording found at the client; medium = several specific details fit; low = a plausible guess.
- Keep evidence text to one sentence each.`;

export function buildClientPrompt(input: {
  agency: string;
  title: string;
  location: string | null;
  pay: string | null;
  body: string | null;
  clues: string[];
  known: ClientCandidate[];
}): string {
  const body = (input.body ?? '').slice(0, MAX_BODY_CHARS);
  return `Agency: ${input.agency}
Role: ${input.title}
Location: ${input.location ?? 'not stated'}
Pay: ${input.pay ?? 'not stated'}

What the email says about the client:
${input.clues.map((c) => `- ${c}`).join('\n') || '- nothing specific'}
${
  input.known.length
    ? `\nAlready suspected (check these, but look further if they don't fit):\n${input.known.map((c) => `- ${c.company} (${c.confidence})`).join('\n')}\n`
    : ''
}
<email>
${body || '(no text)'}
</email>

Who is the client?`;
}

/** What a lookup costs, from past runs when there are any. */
export function clientEstimateUsd(db: Db): number {
  const model = getSettings().clientModel;
  const rows = db.select().from(aiUsage).where(eq(aiUsage.feature, 'client')).all();
  return (
    repricedAverage(rows, 'client', model) ??
    (CLIENT_ESTIMATE_USD * (pricingFor(model)?.input ?? 2)) / 2
  );
}

/** Has a paid lookup already run on this job? */
export function hasAiLookup(db: Db, jobId: number): boolean {
  return Boolean(
    db
      .select({ id: clientLookups.id })
      .from(clientLookups)
      .where(and(eq(clientLookups.jobId, jobId), eq(clientLookups.source, 'ai')))
      .get(),
  );
}

/** One lookup per job at a time. */
const inflight = new Map<number, Promise<unknown>>();

/**
 * Runs the paid lookup — once per job unless forced (Search again) — then checks each
 * candidate's own board (free).
 */
export async function findClient(
  db: Db,
  applicationId: number,
  opts: { force?: boolean; provider?: LLMProvider; fetchFn?: FetchFn } = {},
) {
  const { job } = jobOf(db, applicationId);
  if (!opts.force && hasAiLookup(db, job.id)) return clientState(db, applicationId);
  const running = inflight.get(job.id);
  if (running) {
    await running;
    return clientState(db, applicationId);
  }
  const p = lookUp(db, applicationId, opts).finally(() => inflight.delete(job.id));
  inflight.set(job.id, p);
  await p;
  return clientState(db, applicationId);
}

async function lookUp(
  db: Db,
  applicationId: number,
  opts: { provider?: LLMProvider; fetchFn?: FetchFn },
) {
  const provider = opts.provider ?? getProvider();
  const { job, company } = jobOf(db, applicationId);
  const state = clientState(db, applicationId);
  const model = getSettings().clientModel;
  const run = startRun(`${CLIENT_RUN_LABEL} behind ${company.name}`, applicationId);
  run.step(
    'Searching for the original posting',
    `up to ${CLIENT_MAX_SEARCHES} searches · ${pricingFor(model)?.label ?? model}`,
  );
  const pay =
    job.salaryMin || job.salaryMax
      ? [job.salaryMin, job.salaryMax]
          .filter(Boolean)
          .map((n) => `$${n!.toLocaleString('en-US')}`)
          .join(' – ')
      : null;

  let res;
  try {
    res = await provider.completeStructured({
      system: CLIENT_SYSTEM_PROMPT,
      prompt: buildClientPrompt({
        agency: company.name,
        title: job.title,
        location: job.location,
        pay,
        body: job.descriptionText,
        clues: state.lookup.result.clues,
        known: state.lookup.result.candidates,
      }),
      schema: clientGuessSchema,
      model,
      effort: currentEffort(),
      maxTokens: 8000,
      webSearch: { maxUses: CLIENT_MAX_SEARCHES },
      onEvent: (e) => {
        if (e.type === 'search') run.step(`Searching: "${e.query}"`);
        else if (e.type === 'searchResults') run.step(`${e.count} results`);
        else if (e.type === 'thinking') run.emit({ type: 'thinking', text: e.text });
        else if (e.type === 'output') run.emit({ type: 'output', text: e.text });
      },
    });
  } catch (err) {
    const trace = err instanceof LLMError ? err.trace : undefined;
    const usageId = trace
      ? recordUsage(db, {
          feature: 'client',
          provider: provider.name,
          model,
          applicationId,
          companyId: company.id,
          trace,
          error: (err as Error).message,
        })
      : null;
    run.emit({ type: 'error', text: (err as Error).message, usageId });
    throw err;
  }

  const usageId = recordUsage(db, {
    feature: 'client',
    provider: res.provider,
    model: res.model,
    usage: res.usage,
    applicationId,
    companyId: company.id,
    trace: res.trace,
  });
  const costUsd = res.usage ? estimateCostUsd(res.model, res.usage) : null;

  run.step(`Checking ${res.data.candidates.length} candidates' own job boards`);
  const found: ClientCandidate[] = await Promise.all(
    res.data.candidates.map(async (c) => ({
      company: c.company.trim(),
      confidence: c.confidence,
      via: 'ai' as const,
      evidence: c.evidence.map((e) => ({ text: e.text, url: e.url })),
      careersUrl: c.careersUrl,
      direct: await checkDirect(db, c.company, c.careersUrl, agencyJob(job), opts.fetchFn),
    })),
  );
  saveLookup(
    db,
    job.id,
    'ai',
    {
      ...state.lookup.result,
      candidates: mergeCandidates(state.lookup.result.candidates, found),
      notes: res.data.notes,
    },
    { model: res.model, usageId, costUsd },
  );
  const direct = found.filter((c) => c.direct?.status === 'match').length;
  run.emit({
    type: 'done',
    text: `${found.length ? found.map((c) => c.company).join(', ') : 'No client found'}${direct ? ` · ${direct} hiring directly` : ''} · ${res.usage?.webSearches ?? 0} searches${costUsd != null ? ` · ~$${costUsd.toFixed(2)}` : ''}`,
    usageId,
  });
}
