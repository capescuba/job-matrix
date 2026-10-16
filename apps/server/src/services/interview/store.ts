import fs from 'node:fs';
import path from 'node:path';
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { CoachHint, Debrief, PrepCard, Speaker } from '@jm/shared';
import type { Db } from '../../db/client.ts';
import {
  applications,
  interviewHints,
  interviewSegments,
  interviewSessions,
} from '../../db/schema.ts';
import { INTERVIEWS_DIR } from '../../paths.ts';
import { NotFoundError } from '../applications.ts';

export type SessionRow = typeof interviewSessions.$inferSelect;

/** Where one session's files live: data/interviews/<id>/. */
export const sessionDir = (id: number, root = INTERVIEWS_DIR) => path.join(root, String(id));

export function createSession(
  db: Db,
  applicationId: number,
  input: {
    round: string;
    coachModel: string;
    recordAudio?: boolean;
    micDevice?: string | null;
    outputDevice?: string | null;
  },
): SessionRow {
  const app = db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .get();
  if (!app) throw new NotFoundError(`Application ${applicationId} not found`);
  return db
    .insert(interviewSessions)
    .values({
      applicationId,
      round: input.round,
      coachModel: input.coachModel,
      recordAudio: input.recordAudio ?? true,
      micDevice: input.micDevice ?? null,
      outputDevice: input.outputDevice ?? null,
    })
    .returning()
    .get();
}

export function getSessionRow(db: Db, id: number): SessionRow {
  const row = db.select().from(interviewSessions).where(eq(interviewSessions.id, id)).get();
  if (!row) throw new NotFoundError(`Interview session ${id} not found`);
  return row;
}

export function startSession(
  db: Db,
  id: number,
  patch: { transcriber: string; micDevice: string | null; outputDevice: string | null },
  now = new Date(),
) {
  db.update(interviewSessions)
    .set({
      startedAt: now.toISOString(),
      transcriber: patch.transcriber,
      micDevice: patch.micDevice,
      outputDevice: patch.outputDevice,
    })
    .where(eq(interviewSessions.id, id))
    .run();
}

export function endSession(db: Db, id: number, audioMs: number | null, now = new Date()) {
  db.update(interviewSessions)
    .set({ endedAt: now.toISOString(), ...(audioMs != null && { audioMs }) })
    .where(eq(interviewSessions.id, id))
    .run();
}

export function setAudio(db: Db, id: number, audioFile: string, audioMs: number | null) {
  db.update(interviewSessions)
    .set({ audioFile, ...(audioMs != null && { audioMs }) })
    .where(eq(interviewSessions.id, id))
    .run();
}

export function setAsked(db: Db, id: number, questions: string[]) {
  getSessionRow(db, id);
  db.update(interviewSessions)
    .set({ askedQuestions: questions })
    .where(eq(interviewSessions.id, id))
    .run();
}

export function savePrep(db: Db, id: number, prep: PrepCard, usageId: number) {
  db.update(interviewSessions)
    .set({ prep, prepUsageId: usageId })
    .where(eq(interviewSessions.id, id))
    .run();
}

export function saveDebrief(
  db: Db,
  id: number,
  summary: Debrief,
  usageId: number,
  activityId: number,
) {
  db.update(interviewSessions)
    .set({ summary, debriefUsageId: usageId, activityId })
    .where(eq(interviewSessions.id, id))
    .run();
}

export function appendSegment(
  db: Db,
  sessionId: number,
  seg: { speaker: Speaker; text: string; startMs: number; endMs: number },
): number {
  return db
    .insert(interviewSegments)
    .values({ sessionId, ...seg })
    .returning({ id: interviewSegments.id })
    .get().id;
}

export function saveHint(
  db: Db,
  sessionId: number,
  h: {
    segmentId: number | null;
    trigger: 'utterance' | 'nudge';
    hint: CoachHint;
    usageId: number | null;
    atMs: number;
  },
): number {
  return db
    .insert(interviewHints)
    .values({ sessionId, ...h })
    .returning({ id: interviewHints.id })
    .get().id;
}

/** Newest first; sizes are read from disk so the list can show what a recording costs. */
export function listSessions(db: Db, applicationId: number, root = INTERVIEWS_DIR) {
  const rows = db
    .select({
      id: interviewSessions.id,
      round: interviewSessions.round,
      startedAt: interviewSessions.startedAt,
      endedAt: interviewSessions.endedAt,
      createdAt: interviewSessions.createdAt,
      audioFile: interviewSessions.audioFile,
      audioMs: interviewSessions.audioMs,
      recordAudio: interviewSessions.recordAudio,
      hasPrep: sql<boolean>`${interviewSessions.prep} is not null`,
      hasSummary: sql<boolean>`${interviewSessions.summary} is not null`,
      segments: sql<number>`(select count(*) from interview_segments s where s.session_id = ${interviewSessions.id})`,
    })
    .from(interviewSessions)
    .where(eq(interviewSessions.applicationId, applicationId))
    .orderBy(desc(interviewSessions.createdAt), desc(interviewSessions.id))
    .all();
  return rows.map((r) => ({ ...r, audioBytes: folderSize(sessionDir(r.id, root)) }));
}

export function getSession(db: Db, id: number) {
  const row = getSessionRow(db, id);
  const segments = db
    .select()
    .from(interviewSegments)
    .where(eq(interviewSegments.sessionId, id))
    .orderBy(asc(interviewSegments.startMs), asc(interviewSegments.id))
    .all();
  const hints = db
    .select()
    .from(interviewHints)
    .where(eq(interviewHints.sessionId, id))
    .orderBy(asc(interviewHints.atMs), asc(interviewHints.id))
    .all();
  return {
    ...row,
    prep: row.prep as PrepCard | null,
    summary: row.summary as Debrief | null,
    askedQuestions: (row.askedQuestions as string[] | null) ?? [],
    segments,
    hints: hints.map((h) => ({ ...h, hint: h.hint as CoachHint })),
  };
}

export function deleteSession(db: Db, id: number, root = INTERVIEWS_DIR) {
  const res = db.delete(interviewSessions).where(eq(interviewSessions.id, id)).run();
  if (res.changes === 0) throw new NotFoundError(`Interview session ${id} not found`);
  fs.rmSync(sessionDir(id, root), { recursive: true, force: true });
}

/** Sessions that were started but never stopped, e.g. the server died mid-call. */
export function unfinishedSessions(db: Db): SessionRow[] {
  return db
    .select()
    .from(interviewSessions)
    .where(sql`${interviewSessions.startedAt} is not null and ${interviewSessions.endedAt} is null`)
    .all();
}

export function folderSize(dir: string): number {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .reduce((sum, e) => sum + (e.isFile() ? fs.statSync(path.join(dir, e.name)).size : 0), 0);
  } catch {
    return 0;
  }
}
