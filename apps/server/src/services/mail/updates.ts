/** The review queue of email updates: list, apply, dismiss, add as a new job, or ask AI. */
import { desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getProvider, type LLMProvider } from '@jm/ai';
import type { MailClient } from '@jm/mail';
import { STATUSES, estimateCostUsd, type Status } from '@jm/shared';
import type { Db } from '../../db/client.ts';
import { aiUsage, applications, companies, emailUpdates, jobs } from '../../db/schema.ts';
import {
  NotFoundError,
  addActivity,
  createApplication,
  updateApplication,
} from '../applications.ts';
import { logEvent } from '../log.ts';
import { getSettings } from '../settings.ts';
import { recordUsage, repricedAverage, type Feature } from '../usage.ts';
import {
  EMAIL_KINDS,
  activityKindFor,
  buildMatchContext,
  suggest,
  type EmailKind,
} from './rules.ts';

export class UpdateStateError extends Error {}

const DONE = ['applied', 'dismissed', 'noop'];

export function listUpdates(db: Db, which: 'pending' | 'done') {
  const rows = db
    .select({
      u: emailUpdates,
      appStatus: applications.status,
      appAppliedAt: applications.appliedAt,
      appTitle: jobs.title,
      appCompany: companies.name,
    })
    .from(emailUpdates)
    .leftJoin(applications, eq(applications.id, emailUpdates.applicationId))
    .leftJoin(jobs, eq(jobs.id, applications.jobId))
    .leftJoin(companies, eq(companies.id, jobs.companyId))
    .where(
      which === 'pending' ? eq(emailUpdates.state, 'pending') : inArray(emailUpdates.state, DONE),
    )
    .orderBy(desc(emailUpdates.receivedAt))
    .limit(which === 'pending' ? 500 : 200)
    .all();
  // For "pick the job": that company's applications.
  const companyIds = [
    ...new Set(rows.map((r) => r.u.companyId).filter((v): v is number => v != null)),
  ];
  const options = companyIds.length
    ? db
        .select({
          id: applications.id,
          companyId: jobs.companyId,
          title: jobs.title,
          status: applications.status,
        })
        .from(applications)
        .innerJoin(jobs, eq(jobs.id, applications.jobId))
        .where(inArray(jobs.companyId, companyIds))
        .all()
    : [];
  return rows.map((r) => ({
    ...r.u,
    application: r.u.applicationId
      ? {
          id: r.u.applicationId,
          status: r.appStatus as Status,
          appliedAt: r.appAppliedAt,
          title: r.appTitle,
          company: r.appCompany,
        }
      : null,
    companyApplications: options.filter((o) => o.companyId === r.u.companyId),
  }));
}
export type EmailUpdateRow = ReturnType<typeof listUpdates>[number];

function getUpdate(db: Db, id: number) {
  const row = db.select().from(emailUpdates).where(eq(emailUpdates.id, id)).get();
  if (!row) throw new NotFoundError(`Email update ${id} not found`);
  return row;
}

export const applyInputSchema = z.object({
  applicationId: z.number().int().optional(),
  /** Override the suggested status; null = only log the email. */
  status: z.enum(STATUSES).nullable().optional(),
  nextAction: z.string().trim().max(300).nullable().optional(),
});

const summaryOf = (u: typeof emailUpdates.$inferSelect) => {
  const s = `Email: ${u.subject}${u.evidence && u.evidence !== u.subject ? ` — “${u.evidence}”` : ''}`;
  return s.length > 600 ? `${s.slice(0, 597)}…` : s;
};

/** Logs the email on the application's timeline (dated to the email) and makes the change. */
export function applyUpdate(db: Db, id: number, raw: z.input<typeof applyInputSchema> = {}) {
  const input = applyInputSchema.parse(raw);
  const u = getUpdate(db, id);
  if (u.state === 'applied') throw new UpdateStateError('This email was already applied.');
  const applicationId = input.applicationId ?? u.applicationId;
  if (!applicationId) throw new UpdateStateError('Pick the job this email is about first.');
  const status = input.status !== undefined ? input.status : (u.suggestedStatus as Status | null);
  const nextAction = input.nextAction !== undefined ? input.nextAction : u.suggestedNextAction;
  const day = u.receivedAt.slice(0, 10);
  const activity = db.transaction((tx) => {
    const t = tx as unknown as Db;
    const row = addActivity(t, applicationId, {
      at: day,
      kind: activityKindFor(u.kind as EmailKind),
      summary: summaryOf(u),
      setStatus: status ?? undefined,
    });
    if (nextAction) updateApplication(t, applicationId, { nextAction, nextActionDate: null });
    t.update(emailUpdates)
      .set({
        state: 'applied',
        applicationId,
        activityId: row.id,
        matchedBy:
          input.applicationId && input.applicationId !== u.applicationId ? 'you' : u.matchedBy,
        resolvedAt: new Date().toISOString(),
      })
      .where(eq(emailUpdates.id, id))
      .run();
    return row;
  });
  logEvent('mail.update.applied', `Applied email "${u.subject}" to application ${applicationId}`, {
    updateId: id,
    applicationId,
    status: status ?? null,
  });
  return { ...getUpdate(db, id), activity };
}

export function dismissUpdate(db: Db, id: number) {
  const u = getUpdate(db, id);
  if (u.state === 'applied') throw new UpdateStateError('This email was already applied.');
  db.update(emailUpdates)
    .set({ state: 'dismissed', resolvedAt: new Date().toISOString() })
    .where(eq(emailUpdates.id, id))
    .run();
  logEvent('mail.update.dismissed', `Dismissed email "${u.subject}"`, { updateId: id });
  return getUpdate(db, id);
}

/** Back to the queue (from dismissed / nothing-to-change). */
export function restoreUpdate(db: Db, id: number) {
  const u = getUpdate(db, id);
  if (u.state === 'applied')
    throw new UpdateStateError('Applied emails stay in the timeline; delete the activity there.');
  db.update(emailUpdates)
    .set({ state: 'pending', resolvedAt: null })
    .where(eq(emailUpdates.id, id))
    .run();
  return getUpdate(db, id);
}

/** Re-reads the suggestion for a (possibly changed) kind and application. */
function refreshSuggestion(db: Db, id: number, patch: Partial<typeof emailUpdates.$inferInsert>) {
  const u = { ...getUpdate(db, id), ...patch };
  const app = u.applicationId
    ? (db
        .select({ status: applications.status, appliedAt: applications.appliedAt })
        .from(applications)
        .where(eq(applications.id, u.applicationId))
        .get() ?? null)
    : null;
  const s = suggest(
    app ? { status: app.status as Status, appliedAt: app.appliedAt } : null,
    u.kind as EmailKind,
  );
  db.update(emailUpdates)
    .set({
      ...patch,
      suggestedStatus: s.status,
      suggestedNextAction: s.nextAction,
      state: u.state === 'applied' ? 'applied' : 'pending',
    })
    .where(eq(emailUpdates.id, id))
    .run();
  return getUpdate(db, id);
}

/** "Label it yourself": you say what kind of email it is, or which job it's about. */
export const relabelSchema = z.object({
  kind: z.enum(EMAIL_KINDS).optional(),
  applicationId: z.number().int().nullable().optional(),
});
export function relabelUpdate(db: Db, id: number, raw: z.input<typeof relabelSchema>) {
  const input = relabelSchema.parse(raw);
  const patch: Partial<typeof emailUpdates.$inferInsert> = {};
  if (input.kind) patch.kind = input.kind;
  if (input.applicationId !== undefined) {
    patch.applicationId = input.applicationId;
    patch.matchedBy = input.applicationId ? 'you' : null;
    if (input.applicationId) {
      const c = db
        .select({ companyId: jobs.companyId })
        .from(applications)
        .innerJoin(jobs, eq(jobs.id, applications.jobId))
        .where(eq(applications.id, input.applicationId))
        .get();
      if (!c) throw new NotFoundError(`Application ${input.applicationId} not found`);
      patch.companyId = c.companyId;
    }
  }
  return refreshSuggestion(db, id, patch);
}

export const trackSchema = z.object({
  company: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(300),
});

/** An email about a job you never tracked: add it (Applied, dated to the email) and log the email. */
export function trackFromUpdate(db: Db, id: number, raw: z.input<typeof trackSchema>) {
  const input = trackSchema.parse(raw);
  const u = getUpdate(db, id);
  if (u.state === 'applied') throw new UpdateStateError('This email was already applied.');
  const day = u.receivedAt.slice(0, 10);
  const appId = createApplication(db, {
    company: input.company,
    title: input.title,
    status: u.kind === 'rejection' ? 'Rejected' : 'Applied',
    appliedAt: day,
    notes: `Added from an email: ${u.subject}`,
  });
  logEvent('mail.update.tracked', `Added "${input.title}" at ${input.company} from an email`, {
    updateId: id,
    applicationId: appId,
  });
  return applyUpdate(db, id, { applicationId: appId, status: null });
}

// ---------- Ask AI (only when you click) ----------

const EMAIL_FEATURE: Feature = 'email';
/** Typical tokens for one email read: the email, the list of your applications, a short answer. */
const EMAIL_TOKENS = { inputTokens: 3_500, outputTokens: 400 };

export function askAiCostUsd(db: Db): number | null {
  const model = getSettings().emailModel;
  const rows = db.select().from(aiUsage).where(eq(aiUsage.feature, EMAIL_FEATURE)).all();
  return repricedAverage(rows, EMAIL_FEATURE, model) ?? estimateCostUsd(model, EMAIL_TOKENS);
}

export const EMAIL_SYSTEM_PROMPT = `You read one email a job seeker received and say what it means for their job applications.

Kinds:
- confirmation: the application was received/submitted.
- rejection: they are not moving forward (only when it is actually decided, not "if you are not selected…").
- interview: an invitation to talk or to schedule a call/interview, or a request for availability.
- action: they must do something first — an assessment, a form, more information.
- offer: a job offer.
- viewed: the application was viewed.
- unclear: none of these (newsletters, marketing, general updates).

Match the email to one of the listed applications when it is clearly about it (same company and, if several, the same role); otherwise applicationId is null. Quote the one sentence that shows the kind as evidence. Suggest a short next action only when the email asks for something.`;

export const emailAiSchema = z.object({
  kind: z.enum(EMAIL_KINDS),
  company: z.string().nullable().describe('Company the email is from/about, as named in it'),
  title: z.string().nullable().describe('Job title the email mentions, if any'),
  applicationId: z.number().int().nullable().describe('Id from the list, or null'),
  evidence: z.string().nullable().describe('The sentence that shows the kind'),
  nextAction: z.string().nullable().describe('Short next step if the email asks for one'),
});

/** One cheap AI read of an unclear email; the cost is recorded under "Email updates". */
export async function classifyWithAi(
  db: Db,
  client: MailClient,
  id: number,
  opts: { provider?: LLMProvider } = {},
) {
  const u = getUpdate(db, id);
  const msg = await client.message(u.messageId);
  const ctx = buildMatchContext(db);
  const names = new Map(
    db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .all()
      .map((c) => [c.id, c.name]),
  );
  const list = ctx.apps
    .map((a) => `${a.id} | ${names.get(a.companyId)} | ${a.title} | ${a.status}`)
    .join('\n');
  const model = getSettings().emailModel;
  const provider = opts.provider ?? getProvider();
  const prompt = `<email>
From: ${msg.from.name ?? ''} <${msg.from.address ?? ''}>
Date: ${msg.receivedAt}
Subject: ${msg.subject}

${msg.bodyText.slice(0, 8000)}
</email>

<applications>
id | company | title | status
${list}
</applications>`;
  const res = await provider.completeStructured({
    system: EMAIL_SYSTEM_PROMPT,
    prompt,
    schema: emailAiSchema,
    model,
    maxTokens: 2000,
  });
  const appId =
    res.data.applicationId && ctx.apps.some((a) => a.id === res.data.applicationId)
      ? res.data.applicationId
      : null;
  const companyId = appId ? (ctx.apps.find((a) => a.id === appId)?.companyId ?? null) : u.companyId;
  const usageId = recordUsage(db, {
    feature: EMAIL_FEATURE,
    provider: res.provider,
    model: res.model,
    usage: res.usage,
    applicationId: appId ?? undefined,
    companyId: companyId ?? undefined,
    trace: res.trace,
  });
  const row = refreshSuggestion(db, id, {
    kind: res.data.kind,
    evidence: res.data.evidence ?? u.evidence,
    companyName: res.data.company ?? u.companyName,
    jobTitle: res.data.title ?? u.jobTitle,
    applicationId: appId ?? u.applicationId,
    companyId,
    matchedBy: appId ? 'ai' : u.matchedBy,
    classifiedBy: 'ai',
    confidence: 'high',
    usageId,
  });
  // The AI's own wording of the next step, when it has one and the suggestion includes one.
  if (res.data.nextAction && row.suggestedNextAction) {
    db.update(emailUpdates)
      .set({ suggestedNextAction: res.data.nextAction.slice(0, 300) })
      .where(eq(emailUpdates.id, id))
      .run();
  }
  return getUpdate(db, id);
}
