import { and, eq } from 'drizzle-orm';
import { LLMError, getProvider, type LLMProvider } from '@jm/ai';
import {
  FIT_PARTS,
  estimateCostUsd,
  fitResultSchema,
  fitTotal,
  pricingFor,
  jobTrack,
  ROLE_TRACK_LABELS,
  ROLE_TRACKS,
  type FitPartKey,
  type RoleTrack,
  splitLines,
  type FitResult,
  type Status,
  type Gate,
  type GateReason,
} from '@jm/shared';
import type { Db } from '../db/client.ts';
import { applications, companies, contacts, fitAssessments, fitGaps, jobs } from '../db/schema.ts';
import { startRun } from './aiEvents.ts';
import { NotFoundError, sha256 } from './applications.ts';
import { gateOf, payCheck, payRangeOf } from './pay.ts';
import { getProfile, resumeForTrack } from './resume.ts';
import { currentEffort } from './settings.ts';
import { recordUsage } from './usage.ts';

/** Bump when the prompt or schema changes so cached assessments are recomputed. */
export const FIT_PROMPT_VERSION = 'tracks-v6';

/** What changes in the assessment between the kinds of role you're pursuing. */
const TRACK_LENS: Record<
  RoleTrack,
  { who: string; reads: string; skills: string; level: string; logistics: string }
> = {
  TPM: {
    who: 'a seasoned Technical Program Manager hiring manager and recruiter who has hired TPMs at large tech companies and startups',
    reads:
      'program scope and scale, the technical domain, the level (TPM, Senior, Staff, Principal, Director), years required, office days, travel, employment type and hard requirements',
    skills: 'program types, domain and technical depth vs. the resume and career profile.',
    level:
      "title, years and scope vs. the candidate's target level. A mid-level role for a Principal-level candidate scores low here.",
    logistics: "location, office days per week, commute from the candidate's home base, travel.",
  },
  FDE: {
    who: 'a seasoned hiring manager for Forward Deployed Engineering teams (engineers embedded with customers who scope their workflows, build and integrate software, increasingly LLM and agentic systems, and carry it into production) who has hired FDEs at AI companies, large tech companies and startups',
    reads:
      'the customers and their domain, how much hands-on building versus advising or selling, the stack, the seniority implied by scope and pay, years required, office days, customer travel, employment type and hard requirements',
    skills:
      'hands-on building (code, integrations, LLM and agentic systems), customer-facing discovery and delivery to production, and domain, vs. the resume and career profile.',
    level:
      'scope, customer seniority, years and pay vs. the candidate\'s target level. FDE titles are often flat, so don\'t mark a plain "Forward Deployed Engineer" title down for its wording; a role that is junior in scope still scores low.',
    logistics:
      'where the candidate must be based, office days per week and commute from their home base. Travel to customer sites is part of the job: score it against the travel the candidate says they accept.',
  },
};

export function fitSystemPrompt(track: RoleTrack): string {
  const lens = TRACK_LENS[track];
  const others = ROLE_TRACKS.filter((t) => t !== track);
  return `You are ${lens.who}. You assess how well a specific candidate fits a specific job posting, honestly and specifically, the way a trusted advisor would.

This job is scored as a ${ROLE_TRACK_LABELS[track]} (${track}) role. The candidate may pursue more than one kind of role; judge it only as a ${ROLE_TRACK_LABELS[track]} role. A must-have, deal-breaker, plus or known gap that starts with another track (${others.map((t) => `"${t} roles:" or "${t}:"`).join(', ')}) doesn't apply here: leave it out of the scores, and give such a must-have or deal-breaker a criteria entry of ok with the note "Applies to ${others.join('/')} roles only".

How to assess:
- Read the posting for what the role truly needs: ${lens.reads}.
- Compare against the candidate's record only: the resume and, when given, the career profile (a fuller inventory built from their LinkedIn profile and resume — prefer its specifics: scope, numbers, domains). Do not invent experience neither shows. Quote or closely paraphrase lines from them as evidence.
- Use the candidate's profile: target roles, must-haves, deal-breakers, strong pluses, nice-to-haves and known gaps.

Scoring — five parts, each 0-10 (one decimal allowed):
- skills: ${lens.skills}
- level: ${lens.level}
- logistics: ${lens.logistics}
- pay: the posted range vs. the candidate's minimum base and how high the top end goes; equity. If no range is posted, say so; you may note typical pay for the company and level, but the score is capped at 6.
- upside: strong pluses and nice-to-haves present, company trajectory, equity upside, how interesting the work is.
Calibration for each part: 9-10 exceptional, 8 strong, 7 good with a real caveat, 5-6 mixed, 3-4 weak, 0-2 disqualifying. Use the full range and be decisive. The total is computed from the parts by the app, so don't state a total number anywhere. In whyNotHigher, say plainly what holds the score back (e.g. "Held back by the hands-on inference requirement and 4 office days a week").

Must-haves and deal-breakers are filters, not points:
- Return one criteria entry for every must-have and every deal-breaker listed, copying the criterion text.
- must: ok = clearly met, fails = clearly not met, unclear = the posting doesn't say.
- dealbreaker: fails = the job triggers it, ok = clearly doesn't, unclear = can't tell.
- Only mark fails on real evidence from the posting. The minimum base salary is checked separately — don't add a criteria entry for it.

Known gaps lower the relevant part scores; they are not deal-breakers. Mark knownGap = true on gaps that match one.
Gap themes: give each gap a short reusable theme (2-5 words). Reuse one of the existing themes when it fits so recurring gaps can be counted; otherwise create a new one.
Flags: levelMismatch when the level or years asked are clearly off the target (say how); outreach.recommended when contacting someone directly would materially help (a known contact, a named hiring manager, a small company, a standing pool, a referral-heavy company) — say who and why.

Be concise and concrete. Gaps should be actionable. Talking points are the 3 things to lead with in the application and first screen.

Voice: write every text field to the job seeker directly, in the second person ("you", "your"). Never use their name, "the candidate" or "he/she".
Labels: every strength and gap has a 3-6 word label that reads on its own in a short list; put the explanation in the other fields.`;
}

/** The TPM prompt, for size estimates. */
export const FIT_SYSTEM_PROMPT = fitSystemPrompt('TPM');

export interface FitInputs {
  /** Which kind of role this job is scored as; picks the resume and the prompt. */
  track: RoleTrack;
  company: string;
  title: string;
  location: string | null;
  remoteType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  descriptionText: string;
  resumeText: string;
  /** Built from resume + LinkedIn and edited by you; null until built. */
  careerProfile: string | null;
  profile: {
    background: string | null;
    minBase: number | null;
    mustHaves: string[];
    dealBreakers: string[];
    strongPluses: string[];
    niceToHaves: string[];
    knownGaps: string[];
  };
  knownContacts: string[];
  existingGapThemes: string[];
}

const list = (items: string[]) =>
  items.length ? items.map((i) => `- ${i}`).join('\n') : 'None stated.';
const money = (n: number) => `$${n.toLocaleString('en-US')}`;

export function buildFitPrompt(i: FitInputs): string {
  const salary =
    i.salaryMin || i.salaryMax
      ? `${i.salaryMin ? money(i.salaryMin) : '?'} - ${i.salaryMax ? money(i.salaryMax) : '?'}`
      : 'not stated';
  const p = i.profile;
  return `<job>
Company: ${i.company}
Title: ${i.title}
Location: ${i.location ?? 'not stated'} (${i.remoteType ?? 'remote policy not stated'})
Salary: ${salary}

${i.descriptionText}
</job>

<resume>
${i.resumeText}
</resume>
${
  i.careerProfile?.trim()
    ? `
<career_profile>
${i.careerProfile.trim()}
</career_profile>
`
    : ''
}
<candidate_profile>
<background_and_target>
${p.background?.trim() || 'None stated.'}
</background_and_target>
<minimum_base_salary>${p.minBase ? money(p.minBase) : 'not set'} (checked separately)</minimum_base_salary>
<must_haves>
${list(p.mustHaves)}
</must_haves>
<deal_breakers>
${list(p.dealBreakers)}
</deal_breakers>
<strong_pluses>
${list(p.strongPluses)}
</strong_pluses>
<nice_to_haves>
${list(p.niceToHaves)}
</nice_to_haves>
<known_gaps>
${list(p.knownGaps)}
</known_gaps>
</candidate_profile>

<known_contacts_at_company>
${list(i.knownContacts)}
</known_contacts_at_company>

<existing_gap_themes>
${list(i.existingGapThemes)}
</existing_gap_themes>

Assess this candidate's fit for this job.`;
}

/** Short label for a criterion, for "Fails: base, onsite" style summaries. */
export function shortLabel(criterion: string): string {
  const s = criterion
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = s.split(/[,;:—–-]\s/)[0];
  return cut.length > 40 ? `${cut.slice(0, 37)}…` : cut;
}

export function computeGate(
  result: FitResult,
  pay: GateReason | null,
): { gate: Gate; reasons: GateReason[] } {
  return gateOf([
    ...(pay ? [pay] : []),
    ...result.criteria
      .filter((c) => c.status !== 'ok')
      .map((c) => ({
        kind: c.kind,
        label: shortLabel(c.criterion),
        status: c.status as 'fails' | 'unclear',
        note: c.note,
      })),
  ]);
}

/** No posted range → pay can't score above 6, whatever the model guesses about the company. */
export const UNPOSTED_PAY_CAP = 6;
export function capUnpostedPay(result: FitResult, rangePosted: boolean): FitResult {
  if (rangePosted || result.parts.pay.score <= UNPOSTED_PAY_CAP) return result;
  return {
    ...result,
    parts: {
      ...result.parts,
      pay: {
        score: UNPOSTED_PAY_CAP,
        why: `${result.parts.pay.why} (No range posted, so capped at ${UNPOSTED_PAY_CAP}.)`,
      },
    },
  };
}

export class FitError extends Error {}

function existingThemes(db: Db): string[] {
  return db.$client
    .prepare('SELECT theme FROM fit_gaps GROUP BY theme ORDER BY count(*) DESC LIMIT 40')
    .pluck()
    .all() as string[];
}

/** Everything a score is based on, and its cache key — no AI call. */
export function fitInputsFor(db: Db, applicationId: number, model: string, effort: string) {
  const row = db
    .select({ job: jobs, company: companies })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(eq(applications.id, applicationId))
    .get();
  if (!row) throw new NotFoundError(`Application ${applicationId} not found`);
  if (!row.job.descriptionText?.trim())
    throw new FitError('Add the job description before scoring.');
  const track = jobTrack(row.job);
  const resume = resumeForTrack(db, track);
  if (!resume) throw new FitError('Upload a resume on the Profile page before scoring.');

  const range = payRangeOf(row.job);
  const prof = getProfile(db);
  const inputs: FitInputs = {
    track,
    company: row.company.name,
    title: row.job.title,
    location: row.job.location,
    remoteType: row.job.remoteType,
    salaryMin: range?.min ?? null,
    salaryMax: range?.max ?? null,
    descriptionText: row.job.descriptionText,
    resumeText: resume.rawText,
    careerProfile: prof.careerProfile?.trim() || null,
    profile: {
      background: prof.goals,
      minBase: prof.minBase,
      mustHaves: splitLines(prof.mustHaves),
      dealBreakers: splitLines(prof.dealBreakers),
      strongPluses: splitLines(prof.strongPluses),
      niceToHaves: splitLines(prof.niceToHaves),
      knownGaps: splitLines(prof.knownGaps),
    },
    knownContacts: db
      .select()
      .from(contacts)
      .where(eq(contacts.companyId, row.company.id))
      .all()
      .map((c) => [c.name, c.role, c.relationship].filter(Boolean).join(', ')),
    existingGapThemes: [],
  };
  // The theme list changes as jobs are scored; keep it out of the cache key.
  const inputHash = sha256(JSON.stringify([FIT_PROMPT_VERSION, model, effort, inputs]));
  return { row, resume, range, prof, inputs, inputHash };
}

export async function assessFit(
  db: Db,
  applicationId: number,
  opts: { force?: boolean; provider?: LLMProvider } = {},
) {
  const provider = opts.provider ?? getProvider();
  const model = provider.defaultModel;
  const effort = currentEffort();
  const { row, resume, range, prof, inputs, inputHash } = fitInputsFor(
    db,
    applicationId,
    model,
    effort,
  );
  inputs.existingGapThemes = existingThemes(db);

  const run = startRun(`${row.company.name} — ${row.job.title}`, applicationId);

  if (!opts.force) {
    const cached = db
      .select()
      .from(fitAssessments)
      .where(and(eq(fitAssessments.jobId, row.job.id), eq(fitAssessments.inputHash, inputHash)))
      .get();
    if (cached) {
      run.emit({
        type: 'done',
        text: 'Nothing changed since the last score — reused it (no AI call, no cost)',
        usageId: cached.usageId,
        score: cached.overallScore,
        gate: cached.gate,
      });
      return { assessment: cached, cached: true };
    }
  }

  const system = fitSystemPrompt(inputs.track);
  const prompt = buildFitPrompt(inputs);
  const p = inputs.profile;
  run.step(
    `Built the prompt: ~${tokensApprox(system + prompt).toLocaleString()} tokens of text + the answer schema`,
    [
      `${inputs.track} role`,
      `resume “${resume.label}” ${tokensApprox(inputs.resumeText).toLocaleString()} tok`,
      inputs.careerProfile
        ? `career profile ${tokensApprox(inputs.careerProfile).toLocaleString()} tok`
        : 'no career profile',
      `job ${tokensApprox(inputs.descriptionText).toLocaleString()} tok`,
      `${p.mustHaves.length} must-haves, ${p.dealBreakers.length} deal-breakers`,
      `${inputs.existingGapThemes.length} gap themes to reuse`,
      range
        ? `pay $${range.min?.toLocaleString() ?? '?'}–$${range.max?.toLocaleString() ?? '?'}`
        : 'no pay range',
    ].join(' · '),
  );

  let phase: 'waiting' | 'thinking' | 'writing' = 'waiting';
  let res: Awaited<ReturnType<typeof provider.completeStructured<typeof fitResultSchema>>>;
  try {
    res = await provider.completeStructured({
      system,
      prompt,
      schema: fitResultSchema,
      model,
      effort,
      onEvent: (e) => {
        if (e.type === 'request')
          run.step(
            `Sent to ${pricingFor(e.model)?.label ?? e.model}`,
            `effort: ${e.effort ?? 'default'}`,
          );
        else if (e.type === 'thinking') {
          if (phase !== 'thinking') run.step('Thinking…');
          phase = 'thinking';
          run.emit({ type: 'thinking', text: e.text });
        } else if (e.type === 'output') {
          if (phase !== 'writing') run.step('Writing the assessment…');
          phase = 'writing';
          run.emit({ type: 'output', text: e.text });
        }
      },
    });
  } catch (err) {
    const trace = err instanceof LLMError ? err.trace : undefined;
    const usageId = trace
      ? recordUsage(db, {
          feature: 'fit',
          provider: provider.name,
          model,
          applicationId,
          companyId: row.job.companyId,
          trace,
          error: (err as Error).message,
        })
      : null;
    run.emit({ type: 'error', text: (err as Error).message, usageId });
    throw err;
  }
  const usageId = recordUsage(db, {
    feature: 'fit',
    provider: res.provider,
    model: res.model,
    usage: res.usage,
    applicationId,
    companyId: row.job.companyId,
    trace: res.trace,
  });
  const u = res.usage;
  run.step(
    `Model finished in ${((res.trace?.durationMs ?? 0) / 1000).toFixed(1)}s`,
    u
      ? `${u.inputTokens.toLocaleString()} in · ${u.outputTokens.toLocaleString()} out (incl. thinking) · ~$${(estimateCostUsd(res.model, u) ?? 0).toFixed(3)}`
      : undefined,
  );

  const result = capUnpostedPay(res.data, range != null);
  if (result !== res.data) run.step('Capped pay at 6 in code — no range posted');
  const pay = payCheck(prof.minBase, range?.min ?? null, range?.max ?? null);
  run.step(
    'Checked pay floor in code',
    pay
      ? `${pay.status === 'fails' ? 'Fails' : 'Unclear'}: ${pay.note}`
      : prof.minBase
        ? 'Clears the floor'
        : 'No floor set',
  );
  const total = fitTotal(result.parts);
  const { gate, reasons } = computeGate(result, pay);
  run.step(
    `Total ${total.toFixed(1)} from the parts`,
    (Object.keys(FIT_PARTS) as FitPartKey[])
      .map((k) => `${FIT_PARTS[k].label} ${result.parts[k].score}×${FIT_PARTS[k].weight}`)
      .join(' + '),
  );

  const assessment = db.transaction((tx) => {
    const a = tx
      .insert(fitAssessments)
      .values({
        jobId: row.job.id,
        resumeVersionId: resume.id,
        inputHash,
        provider: res.provider,
        model: res.model,
        overallScore: total,
        gate,
        gateReasons: reasons,
        result,
        inputTokens: res.usage?.inputTokens,
        outputTokens: res.usage?.outputTokens,
        usageId,
      })
      .returning()
      .get();
    for (const g of result.gaps) {
      tx.insert(fitGaps)
        .values({
          assessmentId: a.id,
          jobId: row.job.id,
          theme: g.theme.trim(),
          severity: g.severity,
          knownGap: g.knownGap,
          detail: g.gap,
        })
        .run();
    }
    return a;
  });
  run.emit({
    type: 'done',
    text:
      gate === 'fail'
        ? `Saved: fails ${reasons
            .filter((r) => r.status === 'fails')
            .map((r) => r.label)
            .join(', ')} (score ${total.toFixed(1)})`
        : `Saved: ${total.toFixed(1)}${gate === 'check' ? ` — check ${reasons.map((r) => r.label).join(', ')}` : ''}`,
    usageId,
    score: total,
    gate,
  });
  return { assessment, cached: false };
}

const tokensApprox = (s: string) => Math.round(s.length / 4);

/** Application ids whose job has a description but no assessment yet (optionally one status). */
export function unscoredApplicationIds(db: Db, status?: Status): number[] {
  return db.$client
    .prepare(
      `SELECT a.id FROM applications a JOIN jobs j ON j.id = a.job_id
       WHERE length(coalesce(j.description_text, '')) > 0
         AND NOT EXISTS (SELECT 1 FROM fit_assessments f WHERE f.job_id = j.id)
         AND (? IS NULL OR a.status = ?)`,
    )
    .pluck()
    .all(status ?? null, status ?? null) as number[];
}

/**
 * Open jobs (not Rejected, Withdrawn, Ghosted or Passed) whose latest score was made from
 * different inputs than they'd get now — e.g. before your career profile was built or edited.
 */
export function staleOpenApplicationIds(db: Db, model: string, effort: string): number[] {
  const rows = db.$client
    .prepare(
      `SELECT a.id, f.input_hash AS hash FROM applications a
       JOIN jobs j ON j.id = a.job_id
       JOIN fit_assessments f ON f.id = (SELECT id FROM fit_assessments WHERE job_id = j.id ORDER BY created_at DESC, id DESC LIMIT 1)
       WHERE length(coalesce(j.description_text, '')) > 0
         AND a.status NOT IN ('Rejected', 'Withdrawn', 'Ghosted', 'Passed')`,
    )
    .all() as { id: number; hash: string }[];
  return rows
    .filter((r) => {
      try {
        return fitInputsFor(db, r.id, model, effort).inputHash !== r.hash;
      } catch {
        return false;
      }
    })
    .map((r) => r.id);
}

/**
 * Recurring gap themes across the latest assessment of each job — tells you what to prepare
 * or build next.
 */
export function gapThemes(db: Db) {
  const rows = db.$client
    .prepare(
      `SELECT g.theme, g.severity, g.known_gap AS knownGap, g.detail, g.job_id AS jobId,
              c.name AS company, j.title, a.id AS applicationId
       FROM fit_gaps g
       JOIN fit_assessments f ON f.id = g.assessment_id
       JOIN jobs j ON j.id = g.job_id
       JOIN companies c ON c.id = j.company_id
       JOIN applications a ON a.job_id = j.id
       WHERE f.id = (SELECT id FROM fit_assessments WHERE job_id = g.job_id ORDER BY created_at DESC, id DESC LIMIT 1)`,
    )
    .all() as {
    theme: string;
    severity: string;
    knownGap: number;
    detail: string;
    jobId: number;
    company: string;
    title: string;
    applicationId: number;
  }[];
  const byTheme = new Map<
    string,
    { theme: string; knownGap: boolean; major: number; jobs: typeof rows }
  >();
  for (const r of rows) {
    const key = r.theme.toLowerCase();
    const t = byTheme.get(key) ?? { theme: r.theme, knownGap: false, major: 0, jobs: [] };
    t.jobs.push(r);
    t.knownGap ||= Boolean(r.knownGap);
    if (r.severity === 'Major') t.major++;
    byTheme.set(key, t);
  }
  return [...byTheme.values()]
    .map((t) => ({
      theme: t.theme,
      knownGap: t.knownGap,
      major: t.major,
      count: new Set(t.jobs.map((j) => j.jobId)).size,
      jobs: t.jobs.map(({ applicationId, company, title, severity, detail }) => ({
        applicationId,
        company,
        title,
        severity,
        detail,
      })),
    }))
    .sort((a, b) => b.count - a.count || b.major - a.major);
}

// ---------- background batch scoring ----------

export interface FitBatchStatus {
  running: boolean;
  total: number;
  done: number;
  scored: number;
  failed: { applicationId: number; error: string }[];
  startedAt: string;
  finishedAt: string | null;
}

let batch: FitBatchStatus | null = null;

export const fitBatchStatus = () => batch;

/**
 * Scores every unscored job in the background, a few at a time (each call takes ~10–60s).
 * Returns immediately; poll fitBatchStatus() for progress. Only one batch runs at a time.
 */
export function startFitBatch(
  db: Db,
  opts: {
    concurrency?: number;
    provider?: LLMProvider;
    status?: Status;
    /** Re-score open jobs whose score is out of date (e.g. a new career profile). */
    stale?: boolean;
    /** What to run per application; defaults to the fit score alone. */
    task?: (applicationId: number) => Promise<unknown>;
  } = {},
): FitBatchStatus {
  if (batch?.running) return batch;
  const provider = opts.provider ?? getProvider();
  const ids = opts.stale
    ? staleOpenApplicationIds(db, provider.defaultModel, currentEffort())
    : unscoredApplicationIds(db, opts.status);
  const state: FitBatchStatus = {
    running: ids.length > 0,
    total: ids.length,
    done: 0,
    scored: 0,
    failed: [],
    startedAt: new Date().toISOString(),
    finishedAt: ids.length ? null : new Date().toISOString(),
  };
  batch = state;
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        await (opts.task
          ? opts.task(id)
          : assessFit(db, id, { provider: opts.provider, force: opts.stale }));
        state.scored++;
      } catch (e) {
        state.failed.push({ applicationId: id, error: (e as Error).message });
      }
      state.done++;
    }
  };
  void Promise.all(
    Array.from({ length: Math.min(opts.concurrency ?? 4, ids.length) }, worker),
  ).finally(() => {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  });
  return state;
}
