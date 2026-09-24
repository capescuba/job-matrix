import { eq } from 'drizzle-orm';
import type { PostedInfo } from '@jm/shared';
import type { Db } from '../db/client.ts';
import { companies, jobs } from '../db/schema.ts';
import { NotFoundError, sha256 } from './applications.ts';

export interface FetchedJob {
  title: string | null;
  /** Hiring company, when the source names it (Greenhouse, LinkedIn, schema.org). */
  company: string | null;
  location: string | null;
  remoteType: 'Remote' | 'Hybrid' | 'Onsite' | null;
  salaryMin: number | null;
  salaryMax: number | null;
  descriptionText: string;
  /** When the posting went up, with its source — null if the source doesn't say. */
  posted: PostedInfo | null;
  /** Set when the page says the posting is closed/filled/expired (it may still show the text). */
  closedHint: string | null;
  /** Which strategy produced it, e.g. "Greenhouse API". */
  via: string;
}

export class JobFetchError extends Error {}
/** The source says the posting is gone (404, removed from the board). */
export class PostingClosedError extends JobFetchError {}

const DAY = 86_400_000;

/** ISO string / epoch ms → YYYY-MM-DD, or null. */
export function toDate(v: string | number | null | undefined): string | null {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** "2 weeks ago", "Posted 30+ Days Ago", "Posted Today" → approximate YYYY-MM-DD. */
export function relativeToDate(text: string | null | undefined, now = new Date()): string | null {
  if (!text) return null;
  if (/today|just now/i.test(text)) return toDate(now.getTime());
  if (/yesterday/i.test(text)) return toDate(now.getTime() - DAY);
  const m = text.match(/(\d+)\+?\s*(minute|hour|day|week|month|year)s?/i);
  if (!m) return null;
  const days: Record<string, number> = {
    minute: 0,
    hour: 0,
    day: 1,
    week: 7,
    month: 30,
    year: 365,
  };
  return toDate(now.getTime() - Number(m[1]) * days[m[2].toLowerCase()] * DAY);
}

/** An exact date from a source field. */
function exact(v: string | number | null | undefined, source: string): PostedInfo | null {
  const date = toDate(v);
  return date ? { date, source, approx: false, raw: typeof v === 'string' ? v : date } : null;
}

/** A date worked out from relative text like "2 weeks ago" — approximate. */
function relative(text: string | null | undefined, source: string): PostedInfo | null {
  const clean = text?.replace(/\s+/g, ' ').trim();
  const date = relativeToDate(clean);
  return date ? { date, source, approx: true, raw: clean ?? null } : null;
}

/** Filler some sites put in address fields (e.g. GitHub's careers site: "UNAVAILABLE"). */
const PLACEHOLDER = /^(unavailable|not available|n\/?a|none|null|unknown|tbd|-+)$/i;

/** Feeds use 0 as "not provided" — treat anything non-positive as missing. */
const positive = (n: number | null | undefined) => (typeof n === 'number' && n > 0 ? n : null);

const CLOSED_TEXT =
  /no longer (accepting applications|available|open|active)|(position|job|role) (has been|is) (filled|closed)|(job|posting) (has )?(expired|closed)|this (job|role|position|posting) is no longer/i;

type FetchFn = typeof fetch;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

// ---------- text helpers ----------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  bull: '•',
  middot: '·',
  trade: '™',
  reg: '®',
  copy: '©',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Readable plain text from job-posting HTML: keeps paragraphs, headings and bullets. */
export function htmlToText(html: string): string {
  // Greenhouse returns entity-escaped HTML; unescape it first so the tags are real.
  if (!/<[a-z]/i.test(html) && /&lt;[a-z]/i.test(html)) html = decodeEntities(html);
  const text = html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<h[1-6][^>]*>/gi, '\n\n')
    .replace(/<\/(p|div|h[1-6]|ul|ol|tr|section|article|header|footer|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .replace(/ /g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n(- \n)+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// An amount like "$199,000", "199,000.00" or "$188K".
const AMOUNT = String.raw`(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d+)?\s?[kK])(?:\.\d{2})?`;
// Unit/currency noise that can follow an amount: "/year", "/yr", "per year", "USD", "annually".
const UNIT = String.raw`(?:\s*(?:\/\s*(?:year|yr|annum|annually)|per\s+(?:year|annum)|annually|USD|US\$))*`;
const SEP = String.raw`\s*(?:-|–|—|to)\s*`;
// "$199,000/year to $272,000/year", "$188K – $278K", "$150,000 - 180,000 USD"
const RANGE = new RegExp(String.raw`\$\s?${AMOUNT}${UNIT}${SEP}(?:USD\s*)?\$?\s?${AMOUNT}${UNIT}`);
// "168,000 USD - 258,750 USD" (currency after, no $ sign)
const RANGE_USD_AFTER = new RegExp(String.raw`${AMOUNT}\s*USD${UNIT}${SEP}${AMOUNT}\s*USD`);

const money = (s: string) =>
  /k$/i.test(s.trim()) ? Math.round(parseFloat(s) * 1000) : Number(s.replace(/,/g, ''));

/**
 * Annual salary range from the text (ends between $40k and $2M). When several ranges are listed —
 * per level or per location — returns the widest span across them.
 */
export function parseSalaryRange(text: string): { min: number; max: number } | null {
  const found: { min: number; max: number }[] = [];
  for (const re of [RANGE, RANGE_USD_AFTER]) {
    for (const m of text.matchAll(new RegExp(re.source, 'g'))) {
      const min = money(m[1]);
      const max = money(m[2]);
      if (min >= 40_000 && max >= min && max <= 2_000_000) found.push({ min, max });
    }
  }
  if (!found.length) return null;
  return { min: Math.min(...found.map((r) => r.min)), max: Math.max(...found.map((r) => r.max)) };
}

function remoteFrom(s: string | null | undefined): FetchedJob['remoteType'] {
  if (!s) return null;
  if (/remote|telecommute/i.test(s)) return 'Remote';
  if (/hybrid/i.test(s)) return 'Hybrid';
  if (/on-?site|in[- ]office/i.test(s)) return 'Onsite';
  return null;
}

function finish(
  partial: Omit<FetchedJob, 'salaryMin' | 'salaryMax' | 'posted' | 'closedHint' | 'company'> & {
    company?: string | null;
    salaryMin?: number | null;
    salaryMax?: number | null;
    posted?: PostedInfo | null;
    closedHint?: string | null;
  },
): FetchedJob {
  const descriptionText = partial.descriptionText.trim();
  if (descriptionText.length < 200)
    throw new JobFetchError('The page had no usable job description.');
  const salary =
    partial.salaryMin != null && partial.salaryMin > 0
      ? { min: partial.salaryMin, max: partial.salaryMax ?? partial.salaryMin }
      : parseSalaryRange(descriptionText);
  return {
    ...partial,
    descriptionText,
    salaryMin: salary?.min ?? null,
    salaryMax: salary?.max ?? null,
    company: partial.company?.trim() || null,
    posted: partial.posted ?? null,
    closedHint: partial.closedHint ?? null,
  };
}

// ---------- strategies ----------

async function getText(f: FetchFn, url: string, accept = 'text/html') {
  let res: Response;
  try {
    res = await f(url, {
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new JobFetchError(`Couldn't reach ${new URL(url).hostname} (${(e as Error).message}).`);
  }
  if (res.status === 403 || res.status === 429 || res.status === 400)
    throw new JobFetchError(
      `${new URL(url).hostname} blocks automated requests (HTTP ${res.status}). Paste the description instead.`,
    );
  if (res.status === 404)
    throw new PostingClosedError('Posting not found (HTTP 404) — it has probably closed.');
  if (!res.ok) throw new JobFetchError(`HTTP ${res.status} from ${new URL(url).hostname}.`);
  return res.text();
}

async function getJson<T>(f: FetchFn, url: string): Promise<T> {
  const body = await getText(f, url, 'application/json');
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new JobFetchError(`Unexpected response from ${new URL(url).hostname}.`);
  }
}

async function greenhouse(f: FetchFn, u: URL): Promise<FetchedJob | null> {
  const m = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
  const board = m?.[1] ?? u.searchParams.get('for');
  const id = m?.[2] ?? u.searchParams.get('token') ?? u.searchParams.get('gh_jid');
  if (!board || !id) return null;
  // The US API also serves EU boards.
  const j = await getJson<{
    title: string;
    content: string;
    location?: { name?: string };
    first_published?: string;
    updated_at?: string;
    company_name?: string;
  }>(f, `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`);
  return finish({
    title: j.title,
    company: j.company_name ?? null,
    location: j.location?.name ?? null,
    remoteType: remoteFrom(j.location?.name),
    descriptionText: htmlToText(j.content),
    posted: j.first_published
      ? exact(j.first_published, 'Greenhouse first_published')
      : // Last-edited date: can make an old posting look newer, never older.
        exact(j.updated_at, 'Greenhouse updated_at (first-published date not provided)'),
    via: 'Greenhouse API',
  });
}

async function lever(f: FetchFn, u: URL): Promise<FetchedJob | null> {
  const [, company, id] = u.pathname.split('/');
  if (!company || !id) return null;
  const host = u.hostname.includes('.eu.') ? 'api.eu.lever.co' : 'api.lever.co';
  const j = await getJson<{
    text: string;
    descriptionPlain?: string;
    description?: string;
    lists?: { text: string; content: string }[];
    additionalPlain?: string;
    categories?: { location?: string };
    workplaceType?: string;
    salaryRange?: { min?: number; max?: number; interval?: string };
    createdAt?: number;
  }>(f, `https://${host}/v0/postings/${company}/${id}`);
  const parts = [
    j.descriptionPlain ?? htmlToText(j.description ?? ''),
    ...(j.lists ?? []).map((l) => `${l.text}\n${htmlToText(`<ul>${l.content}</ul>`)}`),
    j.additionalPlain ?? '',
  ];
  const annual = !j.salaryRange?.interval || /year/i.test(j.salaryRange.interval);
  return finish({
    title: j.text,
    location: j.categories?.location ?? null,
    remoteType: remoteFrom(j.workplaceType),
    salaryMin: annual ? positive(j.salaryRange?.min) : null,
    salaryMax: annual ? positive(j.salaryRange?.max) : null,
    descriptionText: parts.filter(Boolean).join('\n\n'),
    posted: exact(j.createdAt, 'Lever createdAt'),
    via: 'Lever API',
  });
}

async function ashby(f: FetchFn, u: URL): Promise<FetchedJob | null> {
  const [, org, id] = u.pathname.split('/');
  if (!org || !id) return null;
  const board = await getJson<{
    jobs: {
      id: string;
      title: string;
      location?: string;
      isRemote?: boolean;
      workplaceType?: string;
      descriptionPlain?: string;
      descriptionHtml?: string;
      compensation?: { compensationTierSummary?: string };
      publishedAt?: string;
    }[];
  }>(f, `https://api.ashbyhq.com/posting-api/job-board/${org}?includeCompensation=true`);
  const j = board.jobs.find((x) => x.id === id);
  if (!j)
    throw new PostingClosedError('No longer on the Ashby job board — it has probably closed.');
  const comp = j.compensation?.compensationTierSummary;
  const salary = comp ? parseSalaryRange(comp) : null;
  return finish({
    title: j.title,
    location: j.location ?? null,
    remoteType: remoteFrom(j.workplaceType) ?? (j.isRemote ? 'Remote' : null),
    salaryMin: salary?.min ?? null,
    salaryMax: salary?.max ?? null,
    descriptionText: [
      j.descriptionPlain ?? htmlToText(j.descriptionHtml ?? ''),
      comp ? `Compensation: ${comp}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    posted: exact(j.publishedAt, 'Ashby publishedAt'),
    via: 'Ashby API',
  });
}

async function workday(f: FetchFn, u: URL): Promise<FetchedJob | null> {
  const tenant = u.hostname.split('.')[0];
  const path = u.pathname
    .split('/')
    .filter(Boolean)
    .filter((p) => !/^[a-z]{2}-[A-Z]{2}$/.test(p)); // drop locale like en-US
  if (!path.includes('job')) return null;
  const j = await getJson<{
    jobPostingInfo?: {
      title?: string;
      jobDescription?: string;
      location?: string;
      remoteType?: string;
      startDate?: string;
      postedOn?: string;
    };
  }>(f, `https://${u.hostname}/wday/cxs/${tenant}/${path.join('/')}`);
  const info = j.jobPostingInfo;
  if (!info?.jobDescription) return null;
  return finish({
    title: info.title ?? null,
    location: info.location ?? null,
    remoteType: remoteFrom(info.remoteType),
    descriptionText: htmlToText(info.jobDescription),
    posted:
      exact(info.startDate, 'Workday startDate') ??
      relative(info.postedOn, 'Workday "posted on" text'),
    via: 'Workday API',
  });
}

async function linkedin(f: FetchFn, u: URL): Promise<FetchedJob | null> {
  const id =
    u.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)/)?.[1] ?? u.searchParams.get('currentJobId');
  if (!id) return null;
  const html = await getText(f, `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`);
  const body = html.match(/class="show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1];
  if (!body)
    throw new JobFetchError(
      'LinkedIn did not return the description (it may need you to be signed in).',
    );
  const title = html.match(/<h2[^>]*top-card-layout__title[^>]*>([\s\S]*?)<\/h2>/)?.[1];
  const location = html.match(/topcard__flavor--bullet[^>]*>([\s\S]*?)<\/span>/)?.[1];
  const org = html.match(/topcard__org-name-link[^>]*>([\s\S]*?)<\/a>/)?.[1];
  // LinkedIn shows pay in a separate box, not in the description.
  const payBox = html.match(/compensation__salary[^>]*>([\s\S]*?)<\/div>/)?.[1];
  const pay = payBox ? parseSalaryRange(htmlToText(payBox)) : null;
  return finish({
    title: title ? htmlToText(title) : null,
    company: org ? htmlToText(org) : null,
    location: location ? htmlToText(location) : null,
    remoteType: remoteFrom(location),
    salaryMin: pay?.min ?? null,
    salaryMax: pay?.max ?? null,
    descriptionText: [htmlToText(body), payBox ? `Pay (LinkedIn): ${htmlToText(payBox)}` : '']
      .filter(Boolean)
      .join('\n\n'),
    posted: relative(
      html.match(/posted-time-ago__text[^>]*>([\s\S]*?)<\//)?.[1],
      'LinkedIn page text (resets when a job is reposted)',
    ),
    closedHint: CLOSED_TEXT.test(html)
      ? 'LinkedIn says it is no longer accepting applications'
      : null,
    via: 'LinkedIn public page',
  });
}

interface LdJobPosting {
  '@type'?: string | string[];
  title?: string;
  description?: string;
  jobLocationType?: string;
  jobLocation?:
    | { address?: { addressLocality?: string; addressRegion?: string } }
    | { address?: { addressLocality?: string; addressRegion?: string } }[];
  baseSalary?: { value?: { minValue?: number; maxValue?: number; unitText?: string } };
  datePosted?: string;
  validThrough?: string;
  hiringOrganization?: string | { name?: string };
}

function findJobPosting(node: unknown): LdJobPosting | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findJobPosting(n);
      if (hit) return hit;
    }
    return null;
  }
  const o = node as Record<string, unknown>;
  const type = o['@type'];
  if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting')))
    return o as LdJobPosting;
  return findJobPosting(o['@graph']);
}

/** Any page: schema.org JobPosting JSON-LD first, else the readable text of <main>. */
async function generic(f: FetchFn, u: URL): Promise<FetchedJob> {
  const html = await getText(f, u.toString());
  const ldBlocks = [
    ...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi),
  ].map((m) => m[1]);
  // Drop code before looking for the body: scripts can hold text that's never shown — e.g. a
  // site's "this job may be no longer available" error message, or the literal text "<body".
  const visible = html.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const body = visible.match(/<body[\s\S]*<\/body>/i)?.[0] ?? visible;
  const closedPhrase = htmlToText(body).match(CLOSED_TEXT)?.[0];
  for (const block of ldBlocks) {
    let data: unknown;
    try {
      data = JSON.parse(block.trim());
    } catch {
      continue;
    }
    const jp = findJobPosting(data);
    if (!jp?.description) continue;
    const loc = Array.isArray(jp.jobLocation) ? jp.jobLocation[0] : jp.jobLocation;
    const place = [loc?.address?.addressLocality, loc?.address?.addressRegion]
      .filter((p) => p && !PLACEHOLDER.test(p.trim()))
      .join(', ');
    const sal = jp.baseSalary?.value;
    const annual = !sal?.unitText || /year/i.test(sal.unitText);
    return finish({
      title: jp.title ? decodeEntities(jp.title) : null,
      company:
        typeof jp.hiringOrganization === 'string'
          ? jp.hiringOrganization
          : (jp.hiringOrganization?.name ?? null),
      location: place || null,
      remoteType: jp.jobLocationType === 'TELECOMMUTE' ? 'Remote' : null,
      salaryMin: annual ? positive(sal?.minValue) : null,
      salaryMax: annual ? positive(sal?.maxValue) : null,
      descriptionText: htmlToText(jp.description),
      posted: exact(jp.datePosted, 'Page structured data (schema.org datePosted)'),
      // The posting's own "valid through" date is the most direct evidence: a future one means
      // open, whatever the page text says; only without one do page phrases count.
      closedHint: !jp.validThrough
        ? closedPhrase
          ? `Page says "${closedPhrase}"`
          : null
        : Date.parse(jp.validThrough) < Date.now()
          ? `Listing expired ${toDate(jp.validThrough)}`
          : null,
      via: 'Page structured data',
    });
  }
  const main = visible.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? body;
  const text = htmlToText(main.replace(/<(nav|header|footer|form|button)[\s\S]*?<\/\1>/gi, ' '));
  if (
    text.length < 800 ||
    !/responsib|qualif|requirement|you will|what you|experience/i.test(text)
  ) {
    throw new JobFetchError(
      "Couldn't find a job description on that page (it may load with JavaScript). Paste it instead.",
    );
  }
  return finish({
    title: null,
    location: null,
    remoteType: null,
    descriptionText: text,
    closedHint: closedPhrase ? `Page says "${closedPhrase}"` : null,
    via: 'Page text',
  });
}

export async function fetchJobPosting(url: string, f: FetchFn = fetch): Promise<FetchedJob> {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new JobFetchError('That is not a valid URL.');
  }
  if (!/^https?:$/.test(u.protocol)) throw new JobFetchError('Only http(s) links are supported.');
  const h = u.hostname.toLowerCase();
  const specific = h.endsWith('greenhouse.io')
    ? greenhouse
    : h.endsWith('lever.co')
      ? lever
      : h === 'jobs.ashbyhq.com'
        ? ashby
        : h.endsWith('myworkdayjobs.com')
          ? workday
          : h.endsWith('linkedin.com')
            ? linkedin
            : null;
  if (!specific) return generic(f, u);
  try {
    return (await specific(f, u)) ?? (await generic(f, u));
  } catch (e) {
    // e.g. the API 404s but the page itself still carries the posting — try it before giving up.
    try {
      return await generic(f, u);
    } catch {
      throw e;
    }
  }
}

// ---------- persistence ----------

/** Saves a fetched description onto a job, filling location/remote/salary only where empty. */
export function applyFetchedJob(db: Db, jobId: number, fetched: FetchedJob) {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new NotFoundError(`Job ${jobId} not found`);
  db.update(jobs)
    .set({
      descriptionText: fetched.descriptionText,
      descriptionHash: sha256(fetched.descriptionText),
      location: job.location ?? fetched.location,
      remoteType: job.remoteType ?? fetched.remoteType,
      salaryMin: job.salaryMin ?? fetched.salaryMin,
      salaryMax: job.salaryMax ?? fetched.salaryMax,
      ...postedColumns(job, fetched.posted),
      ...postingState(fetched),
    })
    .where(eq(jobs.id, jobId))
    .run();
}

/** Fetches descriptions for every job that has a URL but no description yet. */
export async function fetchMissingDescriptions(db: Db, f: FetchFn = fetch, concurrency = 4) {
  const pending = db
    .select({
      id: jobs.id,
      url: jobs.url,
      title: jobs.title,
      company: companies.name,
      desc: jobs.descriptionText,
    })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .all()
    .filter((j) => j.url && !j.desc?.trim());
  const results: {
    jobId: number;
    company: string;
    title: string;
    ok: boolean;
    via?: string;
    error?: string;
  }[] = [];
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const j = pending[next++];
      try {
        const fetched = await fetchJobPosting(j.url!, f);
        applyFetchedJob(db, j.id, fetched);
        results.push({
          jobId: j.id,
          company: j.company,
          title: j.title,
          ok: true,
          via: fetched.via,
        });
      } catch (e) {
        results.push({
          jobId: j.id,
          company: j.company,
          title: j.title,
          ok: false,
          error: (e as Error).message,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  return { fetched: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok) };
}

// ---------- posting status checks ----------

/**
 * Posted-date columns to write: keep an existing date that has a source (the first one found is
 * the most original), but replace one saved before sources were tracked.
 */
function postedColumns(
  current: { postedAt: string | null; postedSource: string | null },
  posted: PostedInfo | null,
) {
  if (!posted || (current.postedAt && current.postedSource)) return {};
  return {
    postedAt: posted.date,
    postedSource: posted.source,
    postedApprox: posted.approx,
    postedRaw: posted.raw,
  };
}

function postingState(f: FetchedJob) {
  return {
    postingStatus: f.closedHint ? 'closed' : 'open',
    postingNote: f.closedHint ?? `Open (checked via ${f.via})`,
    postingCheckedAt: new Date().toISOString(),
  };
}

export async function checkPosting(url: string, f: FetchFn = fetch) {
  try {
    const fetched = await fetchJobPosting(url, f);
    return { ...postingState(fetched), posted: fetched.posted };
  } catch (e) {
    return {
      postingStatus: e instanceof PostingClosedError ? 'closed' : null,
      postingNote: (e as Error).message,
      postingCheckedAt: new Date().toISOString(),
      posted: null,
    };
  }
}

/**
 * Re-checks the posting of every open application: open/closed, and the posted date when the
 * source provides one. Status stays null when the site can't be read (blocked etc.).
 */
export async function checkPostings(db: Db, f: FetchFn = fetch, concurrency = 4) {
  const targets = db.$client
    .prepare(
      `SELECT j.id, j.url, j.posted_at AS postedAt, j.posted_source AS postedSource,
              c.name AS company, j.title
       FROM jobs j JOIN companies c ON c.id = j.company_id JOIN applications a ON a.job_id = j.id
       WHERE j.url IS NOT NULL AND a.status NOT IN ('Offer','Rejected','Withdrawn','Ghosted')`,
    )
    .all() as {
    id: number;
    url: string;
    postedAt: string | null;
    postedSource: string | null;
    company: string;
    title: string;
  }[];
  const results: {
    jobId: number;
    company: string;
    title: string;
    status: string | null;
    note: string;
  }[] = [];
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const t = targets[next++];
      const r = await checkPosting(t.url, f);
      db.update(jobs)
        .set({
          postingStatus: r.postingStatus,
          postingNote: r.postingNote,
          postingCheckedAt: r.postingCheckedAt,
          ...postedColumns(t, r.posted),
        })
        .where(eq(jobs.id, t.id))
        .run();
      results.push({
        jobId: t.id,
        company: t.company,
        title: t.title,
        status: r.postingStatus,
        note: r.postingNote,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return {
    checked: results.length,
    open: results.filter((r) => r.status === 'open').length,
    closed: results.filter((r) => r.status === 'closed'),
    unknown: results.filter((r) => r.status == null),
  };
}
