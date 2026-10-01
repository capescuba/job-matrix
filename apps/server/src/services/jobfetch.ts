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
  /** The page's own title (og:title or <title>), for guessing title/company when nothing says. */
  pageTitle?: string | null;
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

export type FetchFn = typeof fetch;

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

/**
 * Every place a posting names, once each, as the posting's location: "New York | San Francisco".
 * Postings open in several places list them all; keeping only the first misjudges the job.
 */
export function joinPlaces(places: (string | null | undefined)[]): string | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of places) {
    const t = p?.replace(/\s+/g, ' ').trim();
    if (!t || PLACEHOLDER.test(t) || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.length ? out.join(' | ') : null;
}

export function remoteFrom(s: string | null | undefined): FetchedJob['remoteType'] {
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

/** GET (or, with a body, a JSON POST) as a browser would, with the usual failures named. */
export async function getText(f: FetchFn, url: string, accept = 'text/html', body?: unknown) {
  let res: Response;
  try {
    res = await f(url, {
      ...(body !== undefined && { method: 'POST', body: JSON.stringify(body) }),
      headers: {
        'User-Agent': UA,
        Accept: accept,
        'Accept-Language': 'en-US,en;q=0.9',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
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

export async function getJson<T>(f: FetchFn, url: string, body?: unknown): Promise<T> {
  const text = await getText(f, url, 'application/json', body);
  try {
    return JSON.parse(text) as T;
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
    categories?: { location?: string; allLocations?: string[] };
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
    location: joinPlaces([j.categories?.location, ...(j.categories?.allLocations ?? [])]),
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
      secondaryLocations?: { location?: string }[];
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
    location: joinPlaces([j.location, ...(j.secondaryLocations ?? []).map((x) => x.location)]),
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
      additionalLocations?: string[];
      remoteType?: string;
      startDate?: string;
      postedOn?: string;
    };
  }>(f, `https://${u.hostname}/wday/cxs/${tenant}/${path.join('/')}`);
  const info = j.jobPostingInfo;
  if (!info?.jobDescription) return null;
  return finish({
    title: info.title ?? null,
    location: joinPlaces([info.location, ...(info.additionalLocations ?? [])]),
    remoteType: remoteFrom(info.remoteType),
    descriptionText: htmlToText(info.jobDescription),
    posted:
      exact(info.startDate, 'Workday startDate') ??
      relative(info.postedOn, 'Workday "posted on" text'),
    via: 'Workday API',
  });
}

/** careers.walmart.com (Next.js): the whole requisition sits in the page's __NEXT_DATA__. */
async function walmart(f: FetchFn, u: URL): Promise<FetchedJob | null> {
  if (!/\/jobs\/R-\d+/i.test(u.pathname)) return null;
  const html = await getText(f, u.toString());
  const json = html.match(/<script[^>]*id=["']?__NEXT_DATA__["']?[^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!json) return null;
  type Place = { city?: string; stateCode?: string; locationId?: string };
  let j: {
    title?: string;
    jobPostingDescription?: string;
    description?: string;
    jobPostingStartDate?: string;
    requisitionStatus?: { id?: string };
    active?: boolean;
    primaryLocation?: Place;
    additionalLocations?: Place[];
    payRange?: { location?: string; code?: string; min?: string; max?: string }[];
    payFrequency?: string;
  } | null;
  try {
    j = JSON.parse(json).props?.pageProps?.jobDetails ?? null;
  } catch {
    return null;
  }
  const html2 = j?.jobPostingDescription || j?.description;
  if (!j || !html2) return null;
  const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  const place = (p?: Place) =>
    p?.city ? [titleCase(p.city), p.stateCode].filter(Boolean).join(', ') : null;
  const places = [j.primaryLocation, ...(j.additionalLocations ?? [])].map(place).filter(Boolean);
  // Pay is listed per location; use the primary location's band and list them all in the text.
  const bands = (j.payRange ?? [])
    .map((b) => ({ ...b, lo: Number(b.min), hi: Number(b.max) }))
    .filter((b) => b.lo > 0 && b.hi > 0);
  const annual = !j.payFrequency || /annual|year/i.test(j.payFrequency);
  const primary =
    bands.find((b) => b.code && b.code === j!.primaryLocation?.locationId) ?? bands[0];
  const money = (n: number) => `$${n.toLocaleString('en-US')}`;
  const payText = bands.length
    ? `\n\nPay range by location (${j.payFrequency ?? 'annual'}):\n${bands
        .map((b) => `- ${b.location}: ${money(b.lo)} - ${money(b.hi)}`)
        .join('\n')}`
    : '';
  const status = j.requisitionStatus?.id;
  return finish({
    title: j.title ? decodeEntities(j.title) : null,
    company: 'Walmart',
    location: places.join('; ') || null,
    remoteType: null,
    salaryMin: annual && primary ? primary.lo : null,
    salaryMax: annual && primary ? primary.hi : null,
    descriptionText: htmlToText(html2) + payText,
    posted: exact(j.jobPostingStartDate, 'Walmart careers data (jobPostingStartDate)'),
    // The requisition status is the reliable signal ("active" is false on open postings too).
    closedHint: (status ? status !== 'OPEN' : j.active === false)
      ? `Walmart lists the requisition as ${status ?? 'inactive'}`
      : null,
    via: 'Walmart careers data',
  });
}

/** One job as amazon.jobs's search lists it (the fields Job Matrix reads). */
export interface AmazonJob {
  id_icims?: string;
  title?: string;
  company_name?: string;
  normalized_location?: string;
  location?: string;
  /** JSON strings, one per place: { normalizedLocation, type: "ONSITE" | … }. */
  locations?: string[];
  posted_date?: string;
  description?: string;
  basic_qualifications?: string;
  preferred_qualifications?: string;
  job_path?: string;
  job_schedule_type?: string;
}

/** amazon.jobs's own search (search.json): what its search page shows, as JSON. */
export async function amazonSearch(f: FetchFn, params: URLSearchParams) {
  const r = await getJson<{ hits?: number; jobs?: AmazonJob[] }>(
    f,
    `https://www.amazon.jobs/en/search.json?${params}`,
  );
  return { hits: r.hits ?? 0, jobs: r.jobs ?? [] };
}

/**
 * An amazon.jobs listing in Job Matrix's terms: the description with both qualification lists,
 * every place it's open in, and pay from Amazon's "from $X/year … up to $Y/year" line (many
 * postings have none).
 */
export function amazonJobFields(j: AmazonJob) {
  const section = (heading: string, html?: string) =>
    html?.trim() ? `\n\n${heading}\n${htmlToText(html)}` : '';
  const descriptionText = j.description
    ? htmlToText(j.description) +
      section('Basic qualifications', j.basic_qualifications) +
      section('Preferred qualifications', j.preferred_qualifications)
    : null;
  const places = (j.locations ?? []).map((raw) => {
    try {
      return JSON.parse(raw) as { normalizedLocation?: string; type?: string };
    } catch {
      return {};
    }
  });
  const location =
    joinPlaces(places.map((p) => p.normalizedLocation)) ??
    j.normalized_location ??
    j.location ??
    null;
  const pay = descriptionText?.match(/from \$([\d,]+)\/year[^$]{0,160}?up to \$([\d,]+)\/year/i);
  const dollars = (s?: string) => (s ? Number(s.replace(/,/g, '')) : null);
  return {
    title: j.title ? decodeEntities(j.title).trim() : null,
    // "Amazon.com Services LLC", "Amazon Web Services, Inc.", …: one company, except AWS.
    company: /web services/i.test(j.company_name ?? '') ? 'Amazon Web Services' : 'Amazon',
    url: j.job_path ? `https://www.amazon.jobs${j.job_path}` : null,
    location,
    remoteType: remoteFrom(places.map((p) => p.type).join(' ')) ?? remoteFrom(location),
    descriptionText,
    salaryMin: dollars(pay?.[1]),
    salaryMax: dollars(pay?.[2]),
    postedDate: toDate(j.posted_date),
  };
}

/**
 * amazon.jobs: the page has no job data and its text is mostly menus, but the site's own search
 * finds a job by its id.
 */
async function amazonJobs(f: FetchFn, u: URL): Promise<FetchedJob | null> {
  const id = u.pathname.match(/\/jobs\/(\d+)/)?.[1];
  if (!id) return null;
  const { jobs } = await amazonSearch(
    f,
    new URLSearchParams({ base_query: id, result_limit: '10' }),
  );
  // Not listed: it may have closed; the page itself says so.
  const j = jobs.find((x) => x.id_icims === id);
  if (!j?.description) return null;
  const a = amazonJobFields(j);
  return finish({
    title: a.title,
    company: a.company,
    location: a.location,
    remoteType: a.remoteType,
    descriptionText: a.descriptionText!,
    salaryMin: a.salaryMin,
    salaryMax: a.salaryMax,
    posted: exact(j.posted_date, 'Amazon jobs search (posted_date)'),
    via: 'Amazon jobs API',
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

type LdPlace = { address?: { addressLocality?: string; addressRegion?: string } };

/** Every place in a schema.org jobLocation (one place or a list), as the posting's location. */
export function ldPlaces(jobLocation: LdPlace | LdPlace[] | unknown[] | null | undefined) {
  const list = (Array.isArray(jobLocation) ? jobLocation : [jobLocation]) as (
    LdPlace | null | undefined
  )[];
  return joinPlaces(
    list.map((loc) =>
      [loc?.address?.addressLocality, loc?.address?.addressRegion]
        .filter((p) => p && !PLACEHOLDER.test(p.trim()))
        .join(', '),
    ),
  );
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
  const meta = (prop: string) =>
    html.match(
      new RegExp(`<meta[^>]+property=["']?${prop}["']?[^>]+content=["']([^"']*)["']`, 'i'),
    )?.[1];
  const pageTitle =
    decodeEntities(
      meta('og:title') ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '',
    ).trim() || null;
  for (const block of ldBlocks) {
    let data: unknown;
    try {
      data = JSON.parse(block.trim());
    } catch {
      continue;
    }
    const jp = findJobPosting(data);
    if (!jp?.description) continue;
    const place = ldPlaces(jp.jobLocation);
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
      pageTitle,
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
    pageTitle,
  });
}

/**
 * The job-board posting behind a company careers page that embeds Ashby or Greenhouse:
 * example.com/careers?ashby_jid=<id> or ?gh_jid=<id>. The job itself lives in an embedded frame,
 * so the page's own text is just the careers shell; the board's name is in the page (its embed
 * script), and the board's API has the posting. Null when the address isn't one of these.
 */
export function embeddedJobId(u: URL): { ats: 'ashby' | 'greenhouse'; id: string } | null {
  const ashby = u.searchParams.get('ashby_jid');
  if (ashby && /^[\w-]{8,}$/.test(ashby)) return { ats: 'ashby', id: ashby };
  const gh = u.searchParams.get('gh_jid');
  if (gh && /^\d+$/.test(gh)) return { ats: 'greenhouse', id: gh };
  return null;
}

/**
 * Board names a careers site's address suggests, for pages that don't name their board:
 * careers.nebius.com → "nebius"; jobs.acme-robotics.com → "acme-robotics", "acmerobotics".
 */
export function boardGuesses(host: string): string[] {
  const labels = host.toLowerCase().split('.');
  const twoLevelTld = /^(co|com|org|net|ac)\.[a-z]{2}$/.test(labels.slice(-2).join('.'));
  const out = labels
    .slice(0, twoLevelTld ? -2 : -1)
    .filter((l) => !/^(www\d*|careers?|jobs?|apply|work|join|hiring|talent|en|us)$/.test(l))
    .flatMap((l) => [l, l.replace(/-/g, '')]);
  return [...new Set(out)].slice(0, 3);
}

async function embedded(f: FetchFn, u: URL): Promise<FetchedJob | null> {
  const job = embeddedJobId(u);
  if (!job) return null;
  const html = await getText(f, u.toString());
  // The board the page embeds, else the ones its address suggests (Nebius builds its own job
  // list, so the page never names its board "nebius").
  const named =
    job.ats === 'ashby'
      ? html.match(/jobs\.ashbyhq\.com\/([\w.-]+)\/embed/i)?.[1]
      : html.match(
          /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([\w-]+)/i,
        )?.[1];
  for (const board of named ? [named] : boardGuesses(u.hostname)) {
    const r =
      job.ats === 'ashby'
        ? await ashby(f, new URL(`https://jobs.ashbyhq.com/${board}/${job.id}`)).catch(() => null)
        : await greenhouse(
            f,
            new URL(`https://job-boards.greenhouse.io/${board}/jobs/${job.id}`),
          ).catch(() => null);
    if (r)
      return {
        ...r,
        via: `${job.ats === 'ashby' ? 'Ashby' : 'Greenhouse'} API (embedded on ${u.hostname})`,
      };
  }
  return null;
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
            : h === 'careers.walmart.com'
              ? walmart
              : h === 'www.amazon.jobs' || h === 'amazon.jobs'
                ? amazonJobs
                : null;
  if (!specific) {
    // A careers page embedding Ashby/Greenhouse: read the posting from the board, not the shell.
    if (embeddedJobId(u)) {
      const viaBoard = await embedded(f, u).catch(() => null);
      if (viaBoard) return viaBoard;
    }
    return generic(f, u);
  }
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
