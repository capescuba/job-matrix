import fs from 'node:fs';
import path from 'node:path';
import { desc, eq } from 'drizzle-orm';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import type { ProfilePatch, RoleTrack } from '@jm/shared';
import type { Db } from '../db/client.ts';
import { profile, resumeVersions } from '../db/schema.ts';
import { RESUME_DIR } from '../paths.ts';

export async function extractResumeText(filename: string, data: Buffer): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') {
    const parser = new PDFParse({ data });
    try {
      return (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  }
  if (ext === '.docx') return (await mammoth.extractRawText({ buffer: data })).value;
  if (ext === '.txt' || ext === '.md') return data.toString('utf8');
  throw new Error(`Unsupported resume file type "${ext}". Use PDF, DOCX, TXT or MD.`);
}

export const normalizeText = (s: string) =>
  s
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export async function addResume(db: Db, label: string, filename: string, data: Buffer) {
  const rawText = normalizeText(await extractResumeText(filename, data));
  if (!rawText)
    throw new Error('No text could be extracted from that file (is it a scanned image?).');
  fs.mkdirSync(RESUME_DIR, { recursive: true });
  const stored = `${Date.now()}-${path.basename(filename).replace(/[^\w.-]+/g, '_')}`;
  fs.writeFileSync(path.join(RESUME_DIR, stored), data);
  const isFirst = !db.select({ id: resumeVersions.id }).from(resumeVersions).get();
  return db
    .insert(resumeVersions)
    .values({ label, rawText, filePath: stored, isDefault: isFirst })
    .returning()
    .get();
}

export function setDefaultResume(db: Db, id: number) {
  db.transaction((tx) => {
    tx.update(resumeVersions).set({ isDefault: false }).run();
    tx.update(resumeVersions).set({ isDefault: true }).where(eq(resumeVersions.id, id)).run();
  });
}

export function getDefaultResume(db: Db) {
  return (
    db.select().from(resumeVersions).where(eq(resumeVersions.isDefault, true)).get() ??
    db.select().from(resumeVersions).orderBy(desc(resumeVersions.id)).get()
  );
}

/** Use this resume for jobs on a track (null = none); a track has one resume at a time. */
export function setResumeTrack(db: Db, id: number, track: RoleTrack | null) {
  db.transaction((tx) => {
    if (track)
      tx.update(resumeVersions).set({ track: null }).where(eq(resumeVersions.track, track)).run();
    tx.update(resumeVersions).set({ track }).where(eq(resumeVersions.id, id)).run();
  });
}

/** The resume for a track's jobs, else the default. */
export function resumeForTrack(db: Db, track: RoleTrack) {
  return (
    db.select().from(resumeVersions).where(eq(resumeVersions.track, track)).get() ??
    getDefaultResume(db)
  );
}

const EMPTY_PROFILE = {
  id: 1,
  name: null,
  goals: null,
  minBase: null,
  mustHaves: null,
  dealBreakers: null,
  strongPluses: null,
  niceToHaves: null,
  knownGaps: null,
  updatedAt: null,
  linkedinUrl: null,
  linkedinSections: null,
  linkedinText: null,
  linkedinImportedAt: null,
  careerProfile: null,
  careerProfileAt: null,
  careerProfileUsageId: null,
} satisfies typeof profile.$inferSelect;

export function getProfile(db: Db): typeof profile.$inferSelect {
  return db.select().from(profile).where(eq(profile.id, 1)).get() ?? EMPTY_PROFILE;
}

export function updateProfile(db: Db, patch: ProfilePatch) {
  const values = { ...patch, updatedAt: new Date().toISOString() };
  db.insert(profile)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: profile.id, set: values })
    .run();
}
