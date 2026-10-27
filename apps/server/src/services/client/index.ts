/**
 * Who an agency's job is really for, and whether you can apply to the client directly. Each
 * change saves a new client_lookups row holding the whole picture, so the latest row is the
 * current state and older rows are the history.
 */
import { desc, eq } from 'drizzle-orm';
import { isAgencyCompany, type ClientCandidate, type ClientLookupResult } from '@jm/shared';
import type { Db } from '../../db/client.ts';
import { applications, clientLookups, companies, jobs } from '../../db/schema.ts';
import {
  NotFoundError,
  addActivity,
  getApplicationDetail,
  leadEmailOf,
  today,
  updateJob,
} from '../applications.ts';
import { companyKey } from '../extension.ts';
import type { FetchFn } from '../jobfetch.ts';
import { captureJob, findTrackedByUrl } from '../screening.ts';
import { candidatesFromTracker, cluesFromText } from './clues.ts';
import { checkDirect } from './direct.ts';

export class AdoptError extends Error {}

export type LookupSource = 'clues' | 'ai' | 'manual' | 'check';

export type LookupRow = Omit<typeof clientLookups.$inferSelect, 'result'> & {
  result: ClientLookupResult;
};

export function latestLookup(db: Db, jobId: number): LookupRow | null {
  const row = db
    .select()
    .from(clientLookups)
    .where(eq(clientLookups.jobId, jobId))
    .orderBy(desc(clientLookups.id))
    .get();
  return row ? (row as LookupRow) : null;
}

/** The application's job and company. */
export function jobOf(db: Db, applicationId: number) {
  const row = db
    .select({ job: jobs, company: companies })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(eq(applications.id, applicationId))
    .get();
  if (!row) throw new NotFoundError(`Application ${applicationId} not found`);
  return row;
}

/** What a board check compares postings with. */
export const agencyJob = (job: { title: string; descriptionText: string | null }) => ({
  title: job.title,
  text: job.descriptionText,
});

const RANK = { high: 0, medium: 1, low: 2 } as const;

/** Adds candidates to a list, folding a company found twice into one (newest findings win). */
export function mergeCandidates(
  current: ClientCandidate[],
  found: ClientCandidate[],
): ClientCandidate[] {
  const out = current.map((c) => ({ ...c }));
  for (const n of found) {
    const i = out.findIndex((c) => companyKey(c.company) === companyKey(n.company));
    if (i < 0) {
      out.push(n);
      continue;
    }
    const c = out[i]!;
    const texts = new Set(c.evidence.map((e) => e.text));
    out[i] = {
      ...c,
      confidence: RANK[n.confidence] < RANK[c.confidence] ? n.confidence : c.confidence,
      evidence: [...c.evidence, ...n.evidence.filter((e) => !texts.has(e.text))],
      careersUrl: n.careersUrl ?? c.careersUrl,
      direct: n.direct ?? c.direct,
    };
  }
  // A role you can apply to directly first, then by confidence; otherwise keep the order found.
  const score = (c: ClientCandidate) => (c.direct?.status === 'match' ? 0 : 3) + RANK[c.confidence];
  return out
    .map((c, i) => ({ c, i }))
    .sort((a, b) => score(a.c) - score(b.c) || a.i - b.i)
    .map((x) => x.c);
}

export function saveLookup(
  db: Db,
  jobId: number,
  source: LookupSource,
  result: ClientLookupResult,
  extra: { model?: string; usageId?: number | null; costUsd?: number | null } = {},
): LookupRow {
  return db
    .insert(clientLookups)
    .values({ jobId, source, result, ...extra })
    .returning()
    .get() as LookupRow;
}

/** What the card shows: the latest lookup, with clues read (and saved) the first time. */
export function clientState(db: Db, applicationId: number, now = new Date()) {
  const { job, company } = jobOf(db, applicationId);
  let row = latestLookup(db, job.id);
  // Jobs saved since the last look may be the one the agency copied.
  const fromTracker = candidatesFromTracker(db, job, now);
  const isNew = (c: ClientCandidate) =>
    !row?.result.candidates.some((x) => companyKey(x.company) === companyKey(c.company));
  if (!row || fromTracker.some(isNew)) {
    row = saveLookup(db, job.id, 'clues', {
      ...row?.result,
      clues: row?.result.clues ?? cluesFromText(job.descriptionText),
      candidates: mergeCandidates(row?.result.candidates ?? [], fromTracker),
    });
  }
  return {
    jobId: job.id,
    company: company.name,
    companyId: company.id,
    isAgency: isAgencyCompany(company, leadEmailOf(db, applicationId)),
    lookup: row,
  };
}

/** You name the client (and maybe its careers page); its board is checked right away. */
export async function addManualClient(
  db: Db,
  applicationId: number,
  input: { company: string; careersUrl?: string | null },
  f: FetchFn = fetch,
) {
  const { job } = jobOf(db, applicationId);
  const state = clientState(db, applicationId);
  const direct = await checkDirect(db, input.company, input.careersUrl, agencyJob(job), f);
  const candidate: ClientCandidate = {
    company: input.company.trim(),
    confidence: 'high',
    via: 'manual',
    evidence: [{ text: 'You named this client.' }],
    careersUrl: input.careersUrl || null,
    direct,
  };
  saveLookup(db, job.id, 'manual', {
    ...state.lookup.result,
    candidates: mergeCandidates(state.lookup.result.candidates, [candidate]),
  });
  return clientState(db, applicationId);
}

/** Reads a candidate's board again (free), optionally from a careers address you paste. */
export async function recheckClient(
  db: Db,
  applicationId: number,
  input: { company: string; careersUrl?: string | null },
  f: FetchFn = fetch,
) {
  const { job } = jobOf(db, applicationId);
  const { lookup } = clientState(db, applicationId);
  const c = lookup.result.candidates.find(
    (x) => companyKey(x.company) === companyKey(input.company),
  );
  if (!c) throw new NotFoundError(`${input.company} isn't a candidate for this job`);
  const careersUrl = input.careersUrl || c.careersUrl;
  const direct = await checkDirect(db, c.company, careersUrl, agencyJob(job), f);
  saveLookup(db, job.id, 'check', {
    ...lookup.result,
    candidates: lookup.result.candidates.map((x) =>
      x === c ? { ...x, careersUrl: careersUrl ?? null, direct } : x,
    ),
  });
  return clientState(db, applicationId);
}

/** "Not it": drops a candidate. */
export function dismissClient(db: Db, applicationId: number, company: string) {
  const { job } = jobOf(db, applicationId);
  const { lookup } = clientState(db, applicationId);
  saveLookup(db, job.id, 'check', {
    ...lookup.result,
    candidates: lookup.result.candidates.filter(
      (x) => companyKey(x.company) !== companyKey(company),
    ),
  });
  return clientState(db, applicationId);
}

/**
 * Apply direct: the client's own posting goes into Screening (or is found already there), and
 * the agency's lead is passed as a duplicate, with a note on each pointing at the other.
 */
export async function adoptDirect(
  db: Db,
  applicationId: number,
  input: { url: string; company: string },
  f: FetchFn = fetch,
  now = new Date(),
) {
  const { company: agency, job } = jobOf(db, applicationId);
  const tracked = findTrackedByUrl(db, input.url);
  if (tracked?.applicationId === applicationId)
    throw new AdoptError('That posting is this job itself — nothing to switch to.');
  const r = await captureJob(db, { url: input.url }, { fetchFn: f });
  const direct = getApplicationDetail(db, r.applicationId);
  // The posting didn't name its company: use the client's name you confirmed.
  if (direct.company.name === 'Unknown')
    updateJob(db, direct.job.id, { companyName: input.company });
  const clientName = direct.company.name === 'Unknown' ? input.company : direct.company.name;
  const at = today(now);
  addActivity(
    db,
    applicationId,
    {
      at,
      kind: 'Note',
      summary: `Passed: Duplicate — applying direct at ${clientName} (${input.url})`,
      setStatus: 'Passed',
    },
    now,
  );
  addActivity(
    db,
    r.applicationId,
    {
      at,
      kind: 'Note',
      summary: `Also pitched by ${agency.name} as "${job.title}" — applying here directly instead.`,
    },
    now,
  );
  return { applicationId: r.applicationId, existing: r.existing, company: clientName };
}
