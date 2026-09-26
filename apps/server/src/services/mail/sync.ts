/**
 * Checking the mailbox: reads message headers since the last check (every folder except Sent,
 * Drafts and Outbox), opens only the job-related ones, and queues what they mean for review.
 * Runs on demand ("Check now") and, if you choose, on a schedule while Job Matrix is open.
 */
import { eq, sql } from 'drizzle-orm';
import { NeedsSignIn, type MailClient, type MailMeta } from '@jm/mail';
import type { Db } from '../../db/client.ts';
import { emailUpdates, mailSync } from '../../db/schema.ts';
import { logEvent } from '../log.ts';
import {
  buildMatchContext,
  classify,
  isCandidate,
  matchApplication,
  suggest,
  type MatchContext,
} from './rules.ts';

/** How far before your first application the first check starts. */
const LOOKBACK_DAYS = 14;
export const INTERVALS = [-1, 0, 15, 30, 60] as const; // manual, on open, minutes

export function mailState(db: Db) {
  const row = db.select().from(mailSync).where(eq(mailSync.id, 1)).get();
  if (row) return row;
  db.insert(mailSync).values({ id: 1 }).onConflictDoNothing().run();
  return db.select().from(mailSync).where(eq(mailSync.id, 1)).get()!;
}

export function updateMailSettings(db: Db, patch: { enabled?: boolean; intervalMinutes?: number }) {
  mailState(db);
  db.update(mailSync).set(patch).where(eq(mailSync.id, 1)).run();
  return mailState(db);
}

/** Where a first check (or a re-scan) starts: two weeks before your earliest application. */
export function historyStart(db: Db, now = new Date()): string {
  const earliest = db.$client
    .prepare(
      `SELECT min(d) FROM (SELECT min(created_at) d FROM applications UNION ALL SELECT min(applied_at) FROM applications)`,
    )
    .pluck()
    .get() as string | null;
  const base = earliest ? new Date(earliest) : new Date(now.getTime() - 30 * 86_400_000);
  return new Date(base.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString();
}

/** One job email → the row to store (or null when it isn't worth showing). */
export function analyze(meta: MailMeta, body: string, ctx: MatchContext) {
  const c = classify(meta.subject, body);
  const m = matchApplication(meta, body, ctx);
  // Nothing recognisable and no company we track: not worth a place in the queue.
  if (c.kind === 'unclear' && !m.companyId) return null;
  const app = ctx.apps.find((a) => a.id === m.applicationId) ?? null;
  const s = suggest(app, c.kind);
  return {
    messageId: meta.id,
    receivedAt: meta.receivedAt,
    fromName: meta.from.name,
    fromAddr: meta.from.address,
    subject: meta.subject || '(no subject)',
    webLink: meta.webLink,
    excerpt: body.replace(/\s+/g, ' ').trim().slice(0, 600) || meta.preview.slice(0, 600),
    kind: c.kind,
    confidence: c.confidence,
    evidence: c.evidence,
    companyName: m.companyName,
    jobTitle: m.jobTitle,
    companyId: m.companyId,
    applicationId: m.applicationId,
    matchedBy: m.matchedBy,
    suggestedStatus: s.status,
    suggestedNextAction: s.nextAction,
    state: s.noop ? 'noop' : 'pending',
  } satisfies typeof emailUpdates.$inferInsert;
}

export interface SyncProgress {
  running: boolean;
  scanned: number;
  found: number;
  startedAt: string | null;
}

const progress: SyncProgress = { running: false, scanned: 0, found: 0, startedAt: null };
let current: Promise<{ scanned: number; found: number }> | null = null;

export const syncProgress = (): SyncProgress => ({ ...progress });

/**
 * Checks the mailbox since the last check (or, with `rescan`, since before your first
 * application). One check at a time; a second call joins the one running.
 */
export function syncMail(
  db: Db,
  client: MailClient,
  opts: { rescan?: boolean; trigger?: string } = {},
): Promise<{ scanned: number; found: number }> {
  current ??= run(db, client, opts).finally(() => {
    current = null;
    progress.running = false;
  });
  return current;
}

async function run(db: Db, client: MailClient, opts: { rescan?: boolean; trigger?: string }) {
  const state = mailState(db);
  const since = opts.rescan || !state.watermark ? historyStart(db) : state.watermark;
  Object.assign(progress, {
    running: true,
    scanned: 0,
    found: 0,
    startedAt: new Date().toISOString(),
  });
  logEvent('mail.sync.start', `Checking email since ${since.slice(0, 10)}`, {
    since,
    trigger: opts.trigger ?? 'manual',
    rescan: Boolean(opts.rescan),
  });
  const ctx = buildMatchContext(db);
  const known = new Set(
    db
      .select({ id: emailUpdates.messageId })
      .from(emailUpdates)
      .all()
      .map((r) => r.id),
  );
  let watermark = state.watermark;
  const save = () =>
    db
      .update(mailSync)
      .set({ watermark, scanned: progress.scanned, found: progress.found })
      .where(eq(mailSync.id, 1))
      .run();
  try {
    for await (const page of client.messagesSince(since)) {
      for (const meta of page) {
        progress.scanned++;
        if (!watermark || meta.receivedAt > watermark) watermark = meta.receivedAt;
        if (known.has(meta.id) || !isCandidate(meta, ctx)) continue;
        const full = await client.message(meta.id);
        const row = analyze(meta, full.bodyText, ctx);
        known.add(meta.id);
        if (!row) continue;
        db.insert(emailUpdates).values(row).onConflictDoNothing().run();
        progress.found++;
      }
      // Keep what's done so an interrupted check picks up from here.
      save();
    }
    db.update(mailSync)
      .set({ lastSyncAt: new Date().toISOString(), lastError: null })
      .where(eq(mailSync.id, 1))
      .run();
    save();
    logEvent(
      'mail.sync.done',
      `Checked ${progress.scanned} emails, found ${progress.found} job updates`,
      { scanned: progress.scanned, found: progress.found },
    );
    return { scanned: progress.scanned, found: progress.found };
  } catch (e) {
    const msg =
      e instanceof NeedsSignIn ? `${e.message} Connect Outlook again.` : (e as Error).message;
    save();
    db.update(mailSync)
      .set({ lastSyncAt: new Date().toISOString(), lastError: msg })
      .where(eq(mailSync.id, 1))
      .run();
    logEvent(
      'mail.sync.error',
      `Email check failed: ${msg}`,
      { scanned: progress.scanned },
      'error',
    );
    throw e;
  }
}

export function pendingCount(db: Db): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(emailUpdates)
      .where(eq(emailUpdates.state, 'pending'))
      .get()?.n ?? 0
  );
}

// ---------- schedule ----------

let timer: NodeJS.Timeout | null = null;
let nextAt: number | null = null;

export const nextSyncAt = () => (nextAt ? new Date(nextAt).toISOString() : null);

/**
 * Arms the next scheduled check from the saved setting: manual (-1) never; "when the app opens"
 * (0) only at start-up; otherwise every N minutes. Called at start-up, after every check, and
 * when the setting changes. The timer never keeps the process alive.
 */
export function scheduleMail(db: Db, client: MailClient, opts: { startup?: boolean } = {}) {
  if (timer) clearTimeout(timer);
  timer = null;
  nextAt = null;
  const s = mailState(db);
  if (!s.enabled || s.intervalMinutes < 0) return;
  if (s.intervalMinutes === 0 && !opts.startup) return;
  const delay = opts.startup ? 10_000 : s.intervalMinutes * 60_000;
  nextAt = Date.now() + delay;
  timer = setTimeout(async () => {
    timer = null;
    nextAt = null;
    try {
      if ((await client.status()).signedIn) await syncMail(db, client, { trigger: 'schedule' });
    } catch {
      // recorded in mail_sync.last_error and the log
    }
    scheduleMail(db, client);
  }, delay);
  timer.unref();
}

export function stopMailSchedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  nextAt = null;
}
