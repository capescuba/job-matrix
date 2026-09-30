import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  NOT_APPLIED_STATUSES,
  guessSource,
  quickAddSchema,
  type ActivityInput,
  type Gate,
  type GateReason,
  type ApplicationPatch,
  type JobPatch,
  type QuickAddInput,
  type Status,
} from '@jm/shared';
import type { Db } from '../db/client.ts';
import { parseSalaryRange } from './jobfetch.ts';
import { payRangeOf, withCurrentPay } from './pay.ts';
import { getProfile } from './resume.ts';
import {
  activities,
  applications,
  companies,
  contacts,
  fitAssessments,
  jobs,
  statusEvents,
} from '../db/schema.ts';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const today = (now = new Date()) => now.toISOString().slice(0, 10);

export class NotFoundError extends Error {}

const salaryFromText = (text: string) => {
  const r = parseSalaryRange(text);
  return r ? { salaryMin: r.min, salaryMax: r.max } : {};
};

/**
 * Pure status-transition rule: moving to Applied (or beyond) without an applied date
 * stamps today's date; an unchanged status produces no event.
 */
export function planStatusChange(
  current: { status: string; appliedAt: string | null },
  next: Status,
  now = new Date(),
): { changed: boolean; appliedAt: string | null } {
  if (current.status === next) return { changed: false, appliedAt: current.appliedAt };
  const needsApplied = !NOT_APPLIED_STATUSES.includes(next) && !current.appliedAt;
  return { changed: true, appliedAt: needsApplied ? today(now) : current.appliedAt };
}

export function findOrCreateCompany(db: Db, name: string): number {
  const existing = db
    .select({ id: companies.id })
    .from(companies)
    .where(sql`lower(${companies.name}) = lower(${name.trim()})`)
    .get();
  if (existing) return existing.id;
  return db.insert(companies).values({ name: name.trim() }).returning({ id: companies.id }).get()
    .id;
}

export function createApplication(db: Db, raw: QuickAddInput, now = new Date()) {
  const input = quickAddSchema.parse(raw);
  return db.transaction((tx) => {
    const companyId = findOrCreateCompany(tx as unknown as Db, input.company);
    const jd = input.descriptionText?.trim() || null;
    const job = tx
      .insert(jobs)
      .values({
        companyId,
        title: input.title,
        url: input.url || null,
        source: input.source ?? guessSource(input.url),
        location: input.location || null,
        remoteType: input.remoteType ?? null,
        descriptionText: jd,
        descriptionHash: jd ? sha256(jd) : null,
        ...(jd && salaryFromText(jd)),
      })
      .returning({ id: jobs.id })
      .get();
    const appliedAt =
      input.appliedAt || (NOT_APPLIED_STATUSES.includes(input.status) ? null : today(now));
    const app = tx
      .insert(applications)
      .values({ jobId: job.id, status: input.status, appliedAt, notes: input.notes || null })
      .returning({ id: applications.id })
      .get();
    tx.insert(statusEvents)
      .values({
        applicationId: app.id,
        fromStatus: null,
        toStatus: input.status,
        at: now.toISOString(),
      })
      .run();
    return app.id;
  });
}

export interface ApplicationRow {
  id: number;
  status: Status;
  appliedAt: string | null;
  nextAction: string | null;
  nextActionDate: string | null;
  priority: number | null;
  updatedAt: string | null;
  createdAt: string;
  jobId: number;
  title: string;
  url: string | null;
  source: string | null;
  location: string | null;
  remoteType: string | null;
  hasDescription: number;
  companyId: number;
  company: string;
  fitScore: number | null;
  fitVerdict: string | null;
  /** Latest dated touchpoint: activity date, else applied date. */
  lastActivityAt: string | null;
  /** From the latest assessment: must-haves / deal-breakers. */
  fitGate: Gate | null;
  fitGateReasons: GateReason[] | null;
  levelMismatch: string | null;
  outreachRecommended: boolean;
  outreachWhy: string | null;
  postedAt: string | null;
  postedSource: string | null;
  postedApprox: boolean;
  postedRaw: string | null;
  postingStatus: 'open' | 'closed' | null;
  postingNote: string | null;
  contactCount: number;
  applicantCount: number | null;
  descriptionSource: string | null;
  /** First ~600 chars of the description, for inbox cards. */
  descriptionPreview: string | null;
  fitSummary: string | null;
  fitWhyNotHigher: string | null;
  /** When the company's latest research brief was made (null = never). */
  researchAt: string | null;
  /** Where the watchlist found it ("LinkedIn search", "Anthropic board"); null = added by you. */
  foundBy: string | null;
  /** The pre-screen's answer: the latest you asked for, else the watchlist's. */
  prescreenVerdict: 'yes' | 'maybe' | 'no' | null;
  /** Its rough 0–10 score (not the fit score). */
  prescreenScore: number | null;
  prescreenReason: string | null;
  prescreenModel: string | null;
}

type RawRow = Omit<ApplicationRow, 'fitGateReasons' | 'outreachRecommended' | 'postedApprox'> & {
  fitGateReasons: string | null;
  outreachRecommended: number | null;
  postedApprox: number;
  salaryMin: number | null;
  salaryMax: number | null;
  /** The description, only when a scored job's range has to be read from it. */
  payText: string | null;
};

export function listApplications(db: Db): ApplicationRow[] {
  const rows = db.all<RawRow>(sql`
    SELECT a.id, a.status, a.applied_at AS appliedAt, a.next_action AS nextAction,
           a.next_action_date AS nextActionDate, a.priority, a.updated_at AS updatedAt,
           a.created_at AS createdAt,
           j.id AS jobId, j.title, j.url, j.source, j.location, j.remote_type AS remoteType,
           (j.description_text IS NOT NULL AND length(j.description_text) > 0) AS hasDescription,
           c.id AS companyId, c.name AS company,
           f.overall_score AS fitScore, json_extract(f.result, '$.verdict') AS fitVerdict,
           f.gate AS fitGate, f.gate_reasons AS fitGateReasons,
           j.salary_min AS salaryMin, j.salary_max AS salaryMax,
           CASE WHEN f.id IS NOT NULL AND COALESCE(j.salary_min, 0) <= 0
                     AND COALESCE(j.salary_max, 0) <= 0
                THEN j.description_text END AS payText,
           json_extract(f.result, '$.flags.levelMismatch') AS levelMismatch,
           json_extract(f.result, '$.flags.outreach.recommended') AS outreachRecommended,
           json_extract(f.result, '$.flags.outreach.why') AS outreachWhy,
           j.posted_at AS postedAt, j.posted_source AS postedSource,
           j.posted_approx AS postedApprox, j.posted_raw AS postedRaw,
           j.posting_status AS postingStatus, j.posting_note AS postingNote,
           (SELECT count(*) FROM contacts ct WHERE ct.company_id = c.id) AS contactCount,
           j.applicant_count AS applicantCount, j.description_source AS descriptionSource,
           substr(j.description_text, 1, 600) AS descriptionPreview,
           json_extract(f.result, '$.summary') AS fitSummary,
           json_extract(f.result, '$.whyNotHigher') AS fitWhyNotHigher,
           (SELECT max(created_at) FROM company_research cr WHERE cr.company_id = c.id) AS researchAt,
           COALESCE((SELECT max(at) FROM activities WHERE application_id = a.id), a.applied_at) AS lastActivityAt,
           CASE WHEN l.id IS NULL THEN NULL
                WHEN cs.id IS NOT NULL AND cs.preset THEN cs.label || ' search'
                WHEN cs.id IS NOT NULL THEN 'search “' || cs.label || '”'
                WHEN src.id IS NOT NULL THEN src.company_name || ' board'
                ELSE 'watchlist' END AS foundBy,
           CASE WHEN ps.id IS NOT NULL THEN ps.verdict WHEN l.model IS NOT NULL THEN l.verdict END AS prescreenVerdict,
           CASE WHEN ps.id IS NOT NULL THEN ps.score WHEN l.model IS NOT NULL THEN l.score END AS prescreenScore,
           CASE WHEN ps.id IS NOT NULL THEN ps.reason WHEN l.model IS NOT NULL THEN l.reason END AS prescreenReason,
           COALESCE(ps.model, l.model) AS prescreenModel
    FROM applications a
    JOIN jobs j ON j.id = a.job_id
    JOIN companies c ON c.id = j.company_id
    LEFT JOIN fit_assessments f ON f.id = (
      SELECT id FROM fit_assessments WHERE job_id = j.id ORDER BY created_at DESC, id DESC LIMIT 1
    )
    -- The watchlist job that put this in the inbox, if one did.
    LEFT JOIN crawl_leads l ON l.id = (
      SELECT id FROM crawl_leads WHERE application_id = a.id AND verdict IN ('yes', 'maybe')
      ORDER BY id LIMIT 1
    )
    LEFT JOIN crawl_searches cs ON cs.id = l.search_id
    LEFT JOIN crawl_sources src ON src.id = l.source_id
    -- The latest pre-screen you asked for on it.
    LEFT JOIN prescreens ps ON ps.id = (
      SELECT id FROM prescreens WHERE application_id = a.id ORDER BY id DESC LIMIT 1
    )
    ORDER BY COALESCE(a.updated_at, a.created_at) DESC
  `);
  const { minBase } = getProfile(db);
  return rows.map(({ salaryMin, salaryMax, payText, ...r }) => {
    const saved = r.fitGateReasons ? (JSON.parse(r.fitGateReasons) as GateReason[]) : null;
    const gate =
      r.fitGate &&
      withCurrentPay(
        saved,
        minBase,
        payRangeOf({ salaryMin, salaryMax, descriptionText: payText }),
      );
    return {
      ...r,
      fitGate: gate ? gate.gate : null,
      fitGateReasons: gate ? gate.reasons : null,
      outreachRecommended: Boolean(r.outreachRecommended),
      postedApprox: Boolean(r.postedApprox),
    };
  });
}

export function getApplicationDetail(db: Db, id: number) {
  const app = db.select().from(applications).where(eq(applications.id, id)).get();
  if (!app) throw new NotFoundError(`Application ${id} not found`);
  const job = db.select().from(jobs).where(eq(jobs.id, app.jobId)).get()!;
  const company = db.select().from(companies).where(eq(companies.id, job.companyId)).get()!;
  const events = db
    .select()
    .from(statusEvents)
    .where(eq(statusEvents.applicationId, id))
    .orderBy(statusEvents.at, statusEvents.id)
    .all();
  const companyContacts = db
    .select()
    .from(contacts)
    .where(eq(contacts.companyId, company.id))
    .all();
  const fits = db
    .select()
    .from(fitAssessments)
    .where(eq(fitAssessments.jobId, job.id))
    .orderBy(desc(fitAssessments.createdAt), desc(fitAssessments.id))
    .all();
  const acts = db
    .select()
    .from(activities)
    .where(eq(activities.applicationId, id))
    .orderBy(activities.at, activities.id)
    .all();
  const payRange = payRangeOf(job);
  // The latest score's gate, with the pay floor checked against today's range and floor.
  if (fits[0]) {
    const g = withCurrentPay(
      fits[0].gateReasons as GateReason[] | null,
      getProfile(db).minBase,
      payRange,
    );
    fits[0] = { ...fits[0], gate: g.gate, gateReasons: g.reasons };
  }
  return {
    application: app,
    job,
    payRange,
    company,
    events,
    activities: acts,
    contacts: companyContacts,
    fits,
  };
}

/** `eventAt` dates the status change (defaults to now), e.g. when it comes from a dated activity. */
export function updateApplication(
  db: Db,
  id: number,
  patch: ApplicationPatch,
  now = new Date(),
  eventAt = now,
) {
  return db.transaction((tx) => {
    const current = tx.select().from(applications).where(eq(applications.id, id)).get();
    if (!current) throw new NotFoundError(`Application ${id} not found`);
    const values: Partial<typeof applications.$inferInsert> = {
      ...patch,
      updatedAt: now.toISOString(),
    };
    if (patch.status) {
      const plan = planStatusChange(current, patch.status, eventAt);
      if (plan.changed) {
        // Forms send the (possibly empty) date alongside the status; an empty one shouldn't block the stamp.
        if (!patch.appliedAt) values.appliedAt = plan.appliedAt;
        tx.insert(statusEvents)
          .values({
            applicationId: id,
            fromStatus: current.status,
            toStatus: patch.status,
            at: eventAt.toISOString(),
          })
          .run();
      }
    }
    tx.update(applications).set(values).where(eq(applications.id, id)).run();
  });
}

export function updateJob(db: Db, id: number, patch: JobPatch) {
  const { companyName, ...rest } = patch;
  const values: Partial<typeof jobs.$inferInsert> = { ...rest };
  if (companyName) values.companyId = findOrCreateCompany(db, companyName);
  if (patch.postingStatus !== undefined) values.postingCheckedAt = new Date().toISOString();
  if (patch.postedAt !== undefined) {
    const current = db.select({ postedAt: jobs.postedAt }).from(jobs).where(eq(jobs.id, id)).get();
    // Only a changed date counts as a manual entry; saving the form unchanged keeps the citation.
    if (patch.postedAt !== current?.postedAt)
      Object.assign(values, {
        postedSource: patch.postedAt ? 'Entered manually' : null,
        postedApprox: false,
        postedRaw: null,
      });
  }
  if (patch.descriptionText !== undefined) {
    const jd = patch.descriptionText?.trim() || null;
    values.descriptionText = jd;
    values.descriptionHash = jd ? sha256(jd) : null;
    const current = db.select().from(jobs).where(eq(jobs.id, id)).get();
    const salaryMin = patch.salaryMin !== undefined ? patch.salaryMin : current?.salaryMin;
    const salaryMax = patch.salaryMax !== undefined ? patch.salaryMax : current?.salaryMax;
    const found = jd && salaryMin == null && salaryMax == null ? parseSalaryRange(jd) : null;
    if (found) Object.assign(values, { salaryMin: found.min, salaryMax: found.max });
  }
  const res = db.update(jobs).set(values).where(eq(jobs.id, id)).run();
  if (res.changes === 0) throw new NotFoundError(`Job ${id} not found`);
}

/** Deletes the application and its job (fits/events cascade). Keeps the company. */
export function deleteApplication(db: Db, id: number) {
  const app = db.select().from(applications).where(eq(applications.id, id)).get();
  if (!app) throw new NotFoundError(`Application ${id} not found`);
  db.transaction((tx) => {
    tx.delete(applications).where(eq(applications.id, id)).run();
    const others = tx
      .select({ id: applications.id })
      .from(applications)
      .where(and(eq(applications.jobId, app.jobId)))
      .all();
    if (others.length === 0) tx.delete(jobs).where(eq(jobs.id, app.jobId)).run();
  });
}

const noonUtc = (date: string) => new Date(`${date.slice(0, 10)}T12:00:00.000Z`);

/** Logs a dated touchpoint; optionally moves the status, with the change dated to the activity. */
export function addActivity(db: Db, applicationId: number, input: ActivityInput, now = new Date()) {
  return db.transaction((tx) => {
    const app = tx.select().from(applications).where(eq(applications.id, applicationId)).get();
    if (!app) throw new NotFoundError(`Application ${applicationId} not found`);
    const row = tx
      .insert(activities)
      .values({
        applicationId,
        at: input.at.slice(0, 10),
        kind: input.kind,
        summary: input.summary || null,
      })
      .returning()
      .get();
    const patch: ApplicationPatch = {};
    if (input.kind === 'Applied' && !app.appliedAt) patch.appliedAt = row.at;
    if (input.setStatus) patch.status = input.setStatus;
    updateApplication(tx as unknown as Db, applicationId, patch, now, noonUtc(row.at));
    return row;
  });
}

export function deleteActivity(db: Db, id: number) {
  const res = db.delete(activities).where(eq(activities.id, id)).run();
  if (res.changes === 0) throw new NotFoundError(`Activity ${id} not found`);
}
