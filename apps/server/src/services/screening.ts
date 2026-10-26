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
import { addActivity, createApplication, findOrCreateCompany, sha256 } from './applications.ts';
import { companyFinder, resolveIdentity } from './jobIdentity.ts';
import {
  fetchJobPosting,
  htmlToText,
  ldPlaces,
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
 * the fragment, and maps the different addresses job sites use for one job onto one:
 * - LinkedIn search/collection links → /jobs/view/<id>/
 * - Oracle Recruiting Cloud (careers.oracle.com, *.oraclecloud.com): the job page, the
 *   "my profile" preview after applying, search parameters → …/sites/<site>/job/<id>
 * - Greenhouse: boards / job-boards / the embedded form → job-boards.greenhouse.io/<co>/jobs/<id>;
 *   a company site's ?gh_jid=<id> keeps just that parameter
 * - Lever /apply, Ashby /application and Workday /apply pages → the job itself
 */
export function normalizeUrl(raw: string): string {
  const u = new URL(raw.trim());
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  const host = u.hostname;
  if (host.endsWith('linkedin.com')) {
    const id =
      u.searchParams.get('currentJobId') ??
      u.pathname.match(/\/jobs\/view\/(?:[^/]*?-)?(\d+)/)?.[1];
    if (id) return `https://www.linkedin.com/jobs/view/${id}/`;
  }
  // Oracle Recruiting Cloud: …/sites/<site>/job/<id>, …/my-profile/preview/<id>, …/requisitions/preview/<id>.
  const oracle = u.pathname.match(
    /^(.*?\/sites\/[^/]+)\/(?:job|my-profile\/preview|requisitions\/preview)\/(\d+)(?:\/|$)/i,
  );
  if (oracle && (host === 'careers.oracle.com' || host.endsWith('.oraclecloud.com')))
    return `https://${host}${oracle[1]}/job/${oracle[2]}`;
  if (host.endsWith('greenhouse.io')) {
    const embed = u.pathname.startsWith('/embed/')
      ? [u.searchParams.get('for'), u.searchParams.get('token')]
      : null;
    const path = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
    const [co, id] = embed ?? [path?.[1], path?.[2]];
    if (co && id) return `https://job-boards.greenhouse.io/${co.toLowerCase()}/jobs/${id}`;
  }
  // A company's own careers page embedding Greenhouse or Ashby: the job is ?gh_jid=<id> or
  // ?ashby_jid=<id>, and that's all that identifies it.
  for (const key of ['gh_jid', 'ashby_jid']) {
    const jid = u.searchParams.get(key);
    if (jid && /^[\w-]+$/.test(jid)) {
      u.search = '';
      u.searchParams.set(key, jid);
    }
  }
  // Job-search sites: only the job's own id identifies it (the rest is search state).
  const keep = (...keys: string[]) => {
    const kept = keys.map((k) => [k, u.searchParams.get(k)] as const).filter(([, v]) => v);
    u.search = '';
    for (const [k, v] of kept) u.searchParams.set(k, v!);
  };
  if (/(^|\.)indeed\.com$/.test(host) && u.searchParams.get('jk')) {
    u.pathname = '/viewjob';
    keep('jk');
  }
  if (/(^|\.)glassdoor\.[a-z.]+$/.test(host) && u.searchParams.get('jl')) keep('jl');
  // ZipRecruiter shows a job inside its search page (lk = the job).
  if (/(^|\.)ziprecruiter\.com$/.test(host) && u.searchParams.get('lk'))
    keep('search', 'location', 'lk');
  // Dice: the job is its /job-detail/<id> path; the query is search state.
  if (/(^|\.)dice\.com$/.test(host) && u.pathname.startsWith('/job-detail/')) u.search = '';
  if (host === 'jobs.lever.co') u.pathname = u.pathname.replace(/\/apply\/?$/, '');
  if (host === 'jobs.ashbyhq.com') u.pathname = u.pathname.replace(/\/application\/?$/, '');
  if (host.endsWith('myworkdayjobs.com'))
    u.pathname = u.pathname.replace(
      /\/(apply(\/[^/]*)?|autofillWithResume|applyManually)\/?$/i,
      '',
    );
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
      jobId: jobs.id,
      status: applications.status,
      url: jobs.url,
      descriptionText: jobs.descriptionText,
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

export {
  SHARED_HOSTS,
  companyFromBoardUrl,
  companyFromHost,
  parsePageTitle,
} from './jobIdentity.ts';

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
  /** A job you already track had no description, and this capture supplied one. */
  descriptionAdded?: boolean;
}

const clean = (s: string | null | undefined) => {
  const t = s?.replace(/\s+\n/g, '\n').trim();
  return t ? t : null;
};

/**
 * The description a capture carries, with where it came from: your selection, then the site
 * template, the server's own read of the posting, the page's structured data, the whole page.
 */
function descriptionFrom(
  input: CaptureInput,
  fetched: FetchedJob | null,
): [string, string | null] | undefined {
  const ld = jobPostingFromJsonLd(input.jsonLd);
  return (
    [
      [clean(input.selectionText), 'Your selection'],
      [
        clean(input.fields?.descriptionText),
        input.templateName ? `${input.templateName} template` : 'Site template',
      ],
      [clean(fetched?.descriptionText), fetched?.via ?? null],
      [ld?.description ? clean(htmlToText(ld.description)) : null, 'Page structured data'],
      [clean(input.pageText), 'Page text (whole page)'],
    ] as [string | null, string | null][]
  ).find((d): d is [string, string | null] => !!d[0] && d[0].length >= 40);
}

/**
 * Adds a job to the Screening inbox from whatever the capture provides — no AI involved.
 * Each field takes the first source that has it: the user's selection or a site template
 * (what they're looking at), then the server-side fetch (clean data for ATS sites), then
 * JSON-LD, then the page title/text.
 */
export async function captureJob(
  db: Db,
  raw: CaptureInput,
  opts: { fetchFn?: typeof fetch; skipFetch?: boolean } = {},
): Promise<CaptureResult> {
  const input = captureSchema.parse(raw);
  const url = normalizeUrl(input.url);

  const tracked = findTrackedByUrl(db, url);
  if (tracked) {
    // Already tracked: the only thing a capture adds is a description the job is missing (a
    // saved-search listing, whose posting the server couldn't read).
    const desc = tracked.descriptionText?.trim() ? undefined : descriptionFrom(input, null);
    if (desc) {
      db.update(jobs)
        .set({
          descriptionText: desc[0],
          descriptionHash: sha256(desc[0]),
          descriptionSource: desc[1],
        })
        .where(eq(jobs.id, tracked.jobId))
        .run();
      addActivity(db, tracked.applicationId, {
        at: new Date().toISOString().slice(0, 10),
        kind: 'Note',
        summary: `Description added from ${desc[1] ?? 'the page'}`,
      });
    }
    return {
      applicationId: tracked.applicationId,
      existing: true,
      status: tracked.status,
      company: tracked.company,
      title: tracked.title,
      ...(desc && { descriptionSource: desc[1], descriptionAdded: true }),
    };
  }

  let fetched: FetchedJob | null = null;
  try {
    if (!opts.skipFetch) fetched = await fetchJobPosting(url, opts.fetchFn);
  } catch {
    // Blocked/closed/JS-only pages are expected — the page capture covers them.
  }
  const ld = jobPostingFromJsonLd(input.jsonLd);
  const f: Partial<NonNullable<typeof input.fields>> = input.fields ?? {};

  const desc = descriptionFrom(input, fetched);

  // Every source's title and company, checked, in one order (the side panel decides the same way).
  const who = resolveIdentity(
    { url, template: f, fetched, ld, heading: input.heading, pageTitle: input.pageTitle },
    companyFinder(db),
  );
  const company = who.company ?? 'Unknown';
  const title = who.title ?? 'Unknown role';

  const location = clean(f.location) ?? clean(fetched?.location) ?? ldPlaces(ld?.jobLocation);

  const ldSal = ld?.baseSalary?.value;
  const salary =
    parseSalaryRange(f.salaryText ?? '') ??
    (fetched?.salaryMin
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
