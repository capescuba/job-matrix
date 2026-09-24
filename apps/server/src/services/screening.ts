import { and, eq, sql } from 'drizzle-orm';
import {
  captureSchema,
  guessSource,
  type CaptureInput,
  type PostedInfo,
  type Status,
} from '@jm/shared';
import type { Db } from '../db/client.ts';
import { applications, companies, contacts, jobs } from '../db/schema.ts';
import { addActivity, createApplication, findOrCreateCompany } from './applications.ts';
import {
  decodeEntities,
  fetchJobPosting,
  htmlToText,
  parseSalaryRange,
  toDate,
  type FetchedJob,
} from './jobfetch.ts';

// ---------- URL normalization ----------

/** Tracking/referral parameters that don't identify the job. */
const TRACKING_PARAM =
  /^(utm_|trk|tracking|refid$|ref$|ref_|src$|source$|gh_src$|lever-|ebp$|recommendedflavor$|originalsubdomain$|lipi$|midtoken$|midsig$|mcid$|fbclid$|gclid$|_ga$|eid$|alternatechannel$)/i;

/**
 * One canonical URL per posting, so a re-capture is recognised: drops tracking parameters and
 * the fragment, and turns LinkedIn search/collection links into /jobs/view/<id>/.
 */
export function normalizeUrl(raw: string): string {
  const u = new URL(raw.trim());
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if (u.hostname.endsWith('linkedin.com')) {
    const id =
      u.searchParams.get('currentJobId') ??
      u.pathname.match(/\/jobs\/view\/(?:[^/]*?-)?(\d+)/)?.[1];
    if (id) return `https://www.linkedin.com/jobs/view/${id}/`;
  }
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
  let s = u.toString();
  if (s.endsWith('/') && u.pathname !== '/' && !u.search) s = s.slice(0, -1);
  return s;
}

/** The application already tracking this posting, if any (compares normalized URLs). */
export function findTrackedByUrl(db: Db, url: string) {
  const target = normalizeUrl(url);
  const rows = db
    .select({
      applicationId: applications.id,
      status: applications.status,
      url: jobs.url,
      title: jobs.title,
      company: companies.name,
    })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(sql`${jobs.url} IS NOT NULL`)
    .all();
  const hit = rows.find((r) => {
    try {
      return normalizeUrl(r.url!) === target;
    } catch {
      return false;
    }
  });
  return hit ? { ...hit, status: hit.status as Status } : null;
}

// ---------- title / company without AI ----------

const SITE_SUFFIX =
  /\s*[|–—-]\s*(LinkedIn|Indeed(\.com)?|Glassdoor|Greenhouse|Lever|Workday|Careers?)\s*$/i;

/** Best-effort title/company from a browser tab title. */
export function parsePageTitle(pageTitle: string | null | undefined): {
  title: string | null;
  company: string | null;
} {
  let t = decodeEntities(pageTitle ?? '')
    .replace(/^\(\d+\)\s*/, '') // "(3) " notification count
    .trim();
  if (!t) return { title: null, company: null };
  let m = t.match(/^(.+?) hiring (.+?)(?: in .+?)?(?:\s*\|\s*LinkedIn)?$/i); // "Acme hiring TPM in SF | LinkedIn"
  if (m) return { company: m[1].trim(), title: m[2].trim() };
  m = t.match(/^Job Application for (.+?) at (.+)$/i); // Greenhouse
  if (m) return { title: m[1].trim(), company: m[2].trim() };
  t = t.replace(SITE_SUFFIX, '').trim();
  m = t.match(/^(.+?) at (.+)$/); // "TPM at Acme"
  if (m) return { title: m[1].trim(), company: m[2].trim() };
  const parts = t.split(/\s+[|]\s+/);
  if (parts.length >= 2) return { title: parts[0].trim(), company: parts[1].trim() }; // "TPM | Acme"
  return { title: t, company: null };
}

/** Company from an ATS board slug, e.g. jobs.ashbyhq.com/haydenai → "Haydenai". */
export function companyFromBoardUrl(url: string): string | null {
  const u = new URL(url);
  const h = u.hostname;
  const slug =
    h.endsWith('greenhouse.io') || h === 'jobs.lever.co' || h === 'jobs.ashbyhq.com'
      ? u.pathname.split('/')[1]
      : h.endsWith('myworkdayjobs.com')
        ? h.split('.')[0]
        : null;
  if (!slug) return null;
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------- JSON-LD ----------

interface LdPosting {
  title?: string;
  description?: string;
  datePosted?: string;
  hiringOrganization?: { name?: string } | string;
  jobLocation?: { address?: { addressLocality?: string; addressRegion?: string } } | unknown[];
  baseSalary?: { value?: { minValue?: number; maxValue?: number; unitText?: string } };
}

function findPosting(node: unknown): LdPosting | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findPosting(n);
      if (hit) return hit;
    }
    return null;
  }
  const o = node as Record<string, unknown>;
  const type = o['@type'];
  if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting')))
    return o as LdPosting;
  return findPosting(o['@graph']);
}

export function jobPostingFromJsonLd(blocks: string[] | null | undefined): LdPosting | null {
  for (const b of blocks ?? []) {
    try {
      const hit = findPosting(JSON.parse(b));
      if (hit) return hit;
    } catch {
      // not JSON
    }
  }
  return null;
}

/** "Over 100 applicants" → 100, "37 applicants" → 37. */
export function parseApplicants(text: string | null | undefined): number | null {
  const m = text?.match(/(\d[\d,]*)\s*\+?\s*applicants/i);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

// ---------- capture ----------

export interface CaptureResult {
  applicationId: number;
  existing: boolean;
  status: Status;
  company: string;
  title: string;
  descriptionSource?: string | null;
}

const clean = (s: string | null | undefined) => {
  const t = s?.replace(/\s+\n/g, '\n').trim();
  return t ? t : null;
};

/**
 * Adds a job to the Screening inbox from whatever the capture provides — no AI involved.
 * Each field takes the first source that has it: the user's selection or a site template
 * (what they're looking at), then the server-side fetch (clean data for ATS sites), then
 * JSON-LD, then the page title/text.
 */
export async function captureJob(
  db: Db,
  raw: CaptureInput,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<CaptureResult> {
  const input = captureSchema.parse(raw);
  const url = normalizeUrl(input.url);

  const tracked = findTrackedByUrl(db, url);
  if (tracked)
    return {
      applicationId: tracked.applicationId,
      existing: true,
      status: tracked.status,
      company: tracked.company,
      title: tracked.title,
    };

  let fetched: FetchedJob | null = null;
  try {
    fetched = await fetchJobPosting(url, opts.fetchFn);
  } catch {
    // Blocked/closed/JS-only pages are expected — the page capture covers them.
  }
  const ld = jobPostingFromJsonLd(input.jsonLd);
  const fromTitle = parsePageTitle(input.pageTitle);
  const f = input.fields ?? {};

  const desc = (
    [
      [clean(input.selectionText), 'Your selection'],
      [
        clean(f.descriptionText),
        input.templateName ? `${input.templateName} template` : 'Site template',
      ],
      [clean(fetched?.descriptionText), fetched?.via ?? null],
      [ld?.description ? clean(htmlToText(ld.description)) : null, 'Page structured data'],
      [clean(input.pageText), 'Page text (whole page)'],
    ] as [string | null, string | null][]
  ).find(([text]) => text && text.length >= 40);

  const orgName =
    typeof ld?.hiringOrganization === 'string'
      ? ld.hiringOrganization
      : ld?.hiringOrganization?.name;
  const company =
    clean(f.company) ??
    clean(orgName) ??
    fromTitle.company ??
    companyFromBoardUrl(url) ??
    'Unknown';
  const title =
    clean(f.title) ??
    clean(fetched?.title) ??
    clean(ld?.title && decodeEntities(ld.title)) ??
    fromTitle.title ??
    'Unknown role';

  const ldLoc = Array.isArray(ld?.jobLocation) ? undefined : ld?.jobLocation?.address;
  const location =
    clean(f.location) ??
    clean(fetched?.location) ??
    clean([ldLoc?.addressLocality, ldLoc?.addressRegion].filter(Boolean).join(', '));

  const ldSal = ld?.baseSalary?.value;
  const salary =
    parseSalaryRange(f.salaryText ?? '') ??
    (fetched?.salaryMin != null
      ? { min: fetched.salaryMin, max: fetched.salaryMax ?? fetched.salaryMin }
      : null) ??
    (ldSal?.minValue && (!ldSal.unitText || /year/i.test(ldSal.unitText))
      ? { min: ldSal.minValue, max: ldSal.maxValue ?? ldSal.minValue }
      : null) ??
    (desc?.[0] ? parseSalaryRange(desc[0]) : null);

  const posted: PostedInfo | null =
    fetched?.posted ??
    (toDate(ld?.datePosted)
      ? {
          date: toDate(ld!.datePosted)!,
          source: 'Page structured data (schema.org datePosted)',
          approx: false,
          raw: ld!.datePosted!,
        }
      : null);

  const applicationId = createApplication(db, {
    company,
    title,
    url,
    location,
    remoteType: fetched?.remoteType ?? null,
    source: guessSource(url),
    descriptionText: desc?.[0] ?? null,
    status: 'Screening',
  });

  const app = db
    .select({ jobId: applications.jobId })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .get()!;
  const li = input.linkedin;
  const insights = li?.insights?.map((s) => s.trim()).filter(Boolean) ?? [];
  db.update(jobs)
    .set({
      descriptionSource: desc?.[1] ?? null,
      ...(salary && { salaryMin: salary.min, salaryMax: salary.max }),
      ...(posted && {
        postedAt: posted.date,
        postedSource: posted.source,
        postedApprox: posted.approx,
        postedRaw: posted.raw,
      }),
      ...(fetched && {
        postingStatus: fetched.closedHint ? 'closed' : 'open',
        postingNote: fetched.closedHint ?? `Open (checked via ${fetched.via})`,
        postingCheckedAt: new Date().toISOString(),
      }),
      applicantCount: parseApplicants(li?.applicantsText),
      linkedinInsights: insights.length ? insights : null,
    })
    .where(eq(jobs.id, app.jobId))
    .run();

  // LinkedIn "Meet the hiring team" → contacts at the company (skip ones already known).
  const companyId = findOrCreateCompany(db, company);
  for (const p of li?.hiringTeam ?? []) {
    const known = db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(eq(contacts.companyId, companyId), sql`lower(${contacts.name}) = lower(${p.name})`),
      )
      .get();
    if (known) continue;
    db.insert(contacts)
      .values({
        companyId,
        name: p.name,
        role: clean(p.title),
        linkedinUrl: clean(p.profileUrl),
        relationship: /recruit|talent|sourc/i.test(p.title ?? '') ? 'Recruiter' : 'Hiring manager',
        notes: 'From LinkedIn "Meet the hiring team"',
      })
      .run();
  }

  addActivity(db, applicationId, {
    at: new Date().toISOString().slice(0, 10),
    kind: 'Note',
    summary: `Captured for screening — description from ${desc?.[1] ?? 'nowhere (none found)'}`,
  });

  return {
    applicationId,
    existing: false,
    status: 'Screening',
    company,
    title,
    descriptionSource: desc?.[1] ?? null,
  };
}
