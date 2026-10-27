/**
 * Free hints about who an agency's job is for: what the email says about the client, and jobs
 * you already track whose description it copies. No AI, no network.
 */
import { isAgencyCompany, type ClientCandidate } from '@jm/shared';
import type { Db } from '../../db/client.ts';
import { companyKey, titleOverlap } from '../extension.ts';

const sentences = (text: string) =>
  text
    .replace(/\r/g, '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[\s*•\-–>]+/, '').trim())
    .filter(Boolean);

const clip = (s: string, max = 180) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** A sentence about the client itself: "Our client, a Fortune 100 fintech in Pleasanton, …". */
const ABOUT_CLIENT =
  /\b(?:our|my|the|a|direct|end)\s+client\b|\bclient\s+(?:is|has|was)\b|\b(?:client|company|employer)\s*:/i;
const FORTUNE = /\bfortune\s*(?:global\s*)?(\d{2,4})\b/i;
const HEADCOUNT = /\b\d[\d,]*\+?\s*(?:employees|people|associates)\b/i;
const LABELLED = /^(?:location|work location|industry|domain|team|division)\s*:\s*(.+)$/i;

/** Hints the email gives about the client (most specific first, at most 6). */
export function cluesFromText(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const add = (s: string) => {
    const c = clip(s);
    if (!out.some((o) => o.toLowerCase() === c.toLowerCase())) out.push(c);
  };
  for (const s of sentences(text)) {
    if (ABOUT_CLIENT.test(s)) add(s);
    else if (FORTUNE.test(s) || HEADCOUNT.test(s)) add(s);
    const l = LABELLED.exec(s);
    if (l) add(s);
  }
  return out.slice(0, 6);
}

// ---------- copied descriptions ----------

/** Words long enough that a shared run of them is unlikely to be chance. */
const SHINGLE = 8;

function shingles(text: string): Set<string> {
  const w = text
    .toLowerCase()
    // Links (Outlook wraps every one in the same Safe Links address) are not wording.
    .replace(/<?https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((x) => x && x.length <= 25);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= w.length; i++) out.add(w.slice(i, i + SHINGLE).join(' '));
  return out;
}

/** Share of the email's 8-word runs that also appear in the description (0–1). */
export function copiedShare(email: string, description: string): number {
  const x = shingles(email);
  if (!x.size) return 0;
  let n = 0;
  for (const s of shingles(description)) if (x.has(s)) n++;
  return n / x.size;
}

/** How much of the email must match to make a copy likely, and near certain. */
const MEDIUM_SHARE = 0.15;
const HIGH_SHARE = 0.4;

interface TrackedJob {
  applicationId: number;
  jobId: number;
  title: string;
  url: string | null;
  location: string | null;
  descriptionText: string;
  company: string;
  isAgency: number | null;
  leadFrom: string | null;
  createdAt: string;
}

/**
 * Jobs at other (non-agency) companies whose description this one copies — the agency pasted
 * the client's JD. Best match per company, strongest first.
 */
export function candidatesFromTracker(
  db: Db,
  job: { id: number; title: string; descriptionText: string | null },
  now = new Date(),
): ClientCandidate[] {
  const text = job.descriptionText?.trim();
  if (!text || shingles(text).size === 0) return [];
  const rows = db.$client
    .prepare(
      `SELECT a.id AS applicationId, j.id AS jobId, j.title, j.url, j.location,
              j.description_text AS descriptionText, c.name AS company, c.is_agency AS isAgency,
              j.created_at AS createdAt,
              (SELECT from_addr FROM mail_leads ml WHERE ml.application_id = a.id
               ORDER BY ml.id LIMIT 1) AS leadFrom
       FROM jobs j
       JOIN companies c ON c.id = j.company_id
       JOIN applications a ON a.job_id = j.id
       WHERE j.id <> ? AND length(coalesce(j.description_text, '')) > 0`,
    )
    .all(job.id) as TrackedJob[];
  const best = new Map<string, { row: TrackedJob; share: number }>();
  for (const r of rows) {
    const agency = isAgencyCompany(
      { name: r.company, isAgency: r.isAgency == null ? null : !!r.isAgency },
      r.leadFrom ? { text: r.descriptionText, fromAddr: r.leadFrom } : null,
    );
    if (agency) continue;
    const share = copiedShare(text, r.descriptionText);
    if (share < MEDIUM_SHARE) continue;
    const key = companyKey(r.company);
    if ((best.get(key)?.share ?? 0) < share) best.set(key, { row: r, share });
  }
  const checkedAt = now.toISOString();
  return [...best.values()]
    .sort((a, b) => b.share - a.share)
    .slice(0, 3)
    .map(({ row: r, share }) => ({
      company: r.company,
      confidence: share >= HIGH_SHARE ? 'high' : 'medium',
      via: 'clues',
      evidence: [
        {
          text: `${Math.round(share * 100)}% of the email's wording matches the "${r.title}" description you saved on ${r.createdAt.slice(0, 10)}.`,
          url: r.url,
        },
      ],
      careersUrl: r.url,
      // It's already in your tracker: that posting is the direct one.
      direct: r.url
        ? {
            checkedAt,
            status: 'match',
            boardUrl: null,
            matches: [
              {
                title: r.title,
                url: r.url,
                location: r.location,
                overlap: Math.round(titleOverlap(job.title, r.title) * 100) / 100,
                applicationId: r.applicationId,
              },
            ],
          }
        : undefined,
    }));
}
