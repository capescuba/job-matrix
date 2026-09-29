/**
 * Your LinkedIn profile, as read by the Chrome extension from your own signed-in profile pages
 * (LinkedIn shows a full profile only to signed-in visitors, so the server can't fetch it).
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { profile } from '../db/schema.ts';
import { logEvent } from './log.ts';
import { getProfile, updateProfile } from './resume.ts';

/** Sections in the order they're read and shown. */
export const LINKEDIN_SECTIONS = [
  ['about', 'About'],
  ['experience', 'Experience'],
  ['projects', 'Projects'],
  ['skills', 'Skills'],
  ['certifications', 'Licenses & certifications'],
  ['education', 'Education'],
  ['honors', 'Honors & awards'],
  ['recommendations', 'Recommendations received'],
] as const;
export type LinkedInSection = (typeof LINKEDIN_SECTIONS)[number][0];

const MAX_SECTION = 120_000;

export const linkedinImportSchema = z.object({
  url: z.string().trim().url(),
  /** Headline and name from the top card, if read. */
  headline: z.string().max(2000).nullable().optional(),
  sections: z.record(
    z.string(),
    z
      .string()
      .nullable()
      .optional()
      .transform((v) => (v ? v.slice(0, MAX_SECTION) : v)),
  ),
});

/** "linkedin.com/in/dave-b/details/…?x" → "https://www.linkedin.com/in/dave-b/". */
export function profileUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim().startsWith('http') ? raw.trim() : `https://${raw.trim()}`);
    const slug = u.hostname.endsWith('linkedin.com')
      ? u.pathname.match(/^\/in\/([^/]+)/)?.[1]
      : null;
    return slug ? `https://www.linkedin.com/in/${decodeURIComponent(slug)}/` : null;
  } catch {
    return null;
  }
}

/** The sections as one text, under headings — what the AI reads. */
export function linkedinTextOf(
  headline: string | null | undefined,
  sections: Record<string, string | null | undefined>,
) {
  const tidy = (s: string) =>
    s
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  const parts: string[] = [];
  if (headline?.trim()) parts.push(tidy(headline));
  for (const [key, label] of LINKEDIN_SECTIONS) {
    const text = sections[key];
    if (text?.trim()) parts.push(`## ${label}\n${tidy(text)}`);
  }
  // Anything else the extension read, under its own name.
  for (const [key, text] of Object.entries(sections))
    if (!LINKEDIN_SECTIONS.some(([k]) => k === key) && text?.trim())
      parts.push(`## ${key}\n${tidy(text)}`);
  return parts.join('\n\n');
}

export function saveLinkedIn(db: Db, raw: z.input<typeof linkedinImportSchema>, now = new Date()) {
  const input = linkedinImportSchema.parse(raw);
  const url = profileUrl(input.url);
  if (!url) throw new Error('That is not a LinkedIn profile address (linkedin.com/in/…).');
  const sections = Object.fromEntries(
    Object.entries(input.sections).filter(([, v]) => v && v.trim()),
  ) as Record<string, string>;
  const text = linkedinTextOf(input.headline, sections);
  if (!text) throw new Error('Nothing was read from the profile.');
  updateProfile(db, {});
  db.update(profile)
    .set({
      linkedinUrl: url,
      linkedinSections: { ...(input.headline ? { headline: input.headline } : {}), ...sections },
      linkedinText: text,
      linkedinImportedAt: now.toISOString(),
    })
    .where(eq(profile.id, 1))
    .run();
  const sizes = Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.length]));
  logEvent(
    'linkedin.import',
    `Imported your LinkedIn profile (${text.length.toLocaleString()} characters)`,
    {
      url,
      sizes,
    },
  );
  return linkedinSummary(db);
}

export function setLinkedInUrl(db: Db, raw: string | null) {
  const url = raw ? profileUrl(raw) : null;
  if (raw && !url) throw new Error('That is not a LinkedIn profile address (linkedin.com/in/…).');
  updateProfile(db, {});
  db.update(profile).set({ linkedinUrl: url }).where(eq(profile.id, 1)).run();
  return linkedinSummary(db);
}

export function clearLinkedIn(db: Db) {
  updateProfile(db, {});
  db.update(profile)
    .set({ linkedinSections: null, linkedinText: null, linkedinImportedAt: null })
    .where(eq(profile.id, 1))
    .run();
  return linkedinSummary(db);
}

/** For the Profile page: when it was imported and how much each section holds. */
export function linkedinSummary(db: Db) {
  const p = getProfile(db);
  const sections = (p.linkedinSections ?? {}) as Record<string, string>;
  return {
    url: p.linkedinUrl ?? null,
    importedAt: p.linkedinImportedAt ?? null,
    chars: p.linkedinText?.length ?? 0,
    sections: LINKEDIN_SECTIONS.map(([key, label]) => ({
      key,
      label,
      chars: sections[key]?.length ?? 0,
    })),
  };
}
