/**
 * Reading a company's whole job board. Greenhouse, Ashby and Lever publish every open job as
 * JSON, descriptions included, so one request covers a company. Workday only answers searches,
 * so it is asked for each title you watch for and returns titles and places (no descriptions).
 */
import {
  JobFetchError,
  getJson,
  getText,
  htmlToText,
  joinPlaces,
  parseSalaryRange,
  relativeToDate,
  remoteFrom,
  toDate,
  type FetchFn,
  type FetchedJob,
} from '../jobfetch.ts';
import { normalizeUrl } from '../screening.ts';

export const BOARD_KINDS = ['greenhouse', 'ashby', 'lever', 'workday'] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];

export const BOARD_LABEL: Record<BoardKind, string> = {
  greenhouse: 'Greenhouse',
  ashby: 'Ashby',
  lever: 'Lever',
  workday: 'Workday',
};

export interface BoardRef {
  kind: BoardKind;
  /** "anthropic"; on Workday "tenant/site". */
  slug: string;
  boardUrl: string;
}

/** One open job as its board lists it. */
export interface BoardJob {
  /** Normalized posting URL. */
  url: string;
  title: string;
  /** Every place the posting names, joined with " | ". */
  location: string | null;
  remoteType: FetchedJob['remoteType'];
  salaryMin: number | null;
  salaryMax: number | null;
  /** Paid by the hour. */
  hourly: boolean;
  /** As the board words it: "FullTime", "Contract", "Intern", … */
  employmentType: string | null;
  postedAt: string | null;
  /** Null when the board lists titles only (Workday). */
  descriptionText: string | null;
}

export class BoardError extends JobFetchError {}

// ---------- which board is this? ----------

const LOCALE = /^[a-z]{2}-[A-Z]{2}$/;

/** The board a job-site address belongs to; null when the address isn't on a known job site. */
export function sourceFromUrl(raw: string): BoardRef | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  if (host.endsWith('greenhouse.io')) {
    const slug = (parts[0] === 'embed' ? u.searchParams.get('for') : parts[0])?.toLowerCase();
    if (!slug || !/^[\w-]+$/.test(slug)) return null;
    return { kind: 'greenhouse', slug, boardUrl: `https://job-boards.greenhouse.io/${slug}` };
  }
  if (host === 'jobs.ashbyhq.com') {
    const slug = parts[0] && decodeURIComponent(parts[0]);
    if (!slug) return null;
    return {
      kind: 'ashby',
      slug,
      boardUrl: `https://jobs.ashbyhq.com/${encodeURIComponent(slug)}`,
    };
  }
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    const slug = parts[0];
    if (!slug) return null;
    return { kind: 'lever', slug, boardUrl: `https://${host}/${slug}` };
  }
  if (host.endsWith('.myworkdayjobs.com')) {
    const site = parts.find((p) => !LOCALE.test(p));
    if (!site || site === 'job') return null;
    const tenant = host.split('.')[0]!;
    return { kind: 'workday', slug: `${tenant}/${site}`, boardUrl: `https://${host}/${site}` };
  }
  return null;
}

/** A company's own careers page names the board it embeds somewhere in its HTML. */
const EMBEDDED: RegExp[] = [
  /https?:\/\/jobs\.ashbyhq\.com\/[\w.%-]+/i,
  /https?:\/\/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/embed\/job_board(?:\/js)?\?for=[\w-]+/i,
  /https?:\/\/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/[\w-]+/i,
  /https?:\/\/jobs(?:\.eu)?\.lever\.co\/[\w-]+/i,
  /https?:\/\/[\w-]+\.wd\d+\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?[\w-]+/i,
];

/**
 * The board behind any address you paste: a board, one of its jobs, or a company careers page
 * that embeds one (the page is fetched to find out which).
 */
export async function resolveSource(raw: string, f: FetchFn = fetch): Promise<BoardRef> {
  const direct = sourceFromUrl(raw);
  if (direct) return direct;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BoardError('That is not a valid URL.');
  }
  const html = (await getText(f, url.toString())).replace(/\\\//g, '/');
  for (const re of EMBEDDED) {
    const hit = html.match(re)?.[0];
    const ref = hit && sourceFromUrl(hit);
    if (ref && ref.slug !== 'embed') return ref;
  }
  throw new BoardError(
    `Couldn't find a Greenhouse, Ashby, Lever or Workday job board at ${url.hostname}. Paste the address of one of its job postings instead.`,
  );
}

/** The company's name as the board gives it (Greenhouse only); null otherwise. */
export async function boardCompanyName(ref: BoardRef, f: FetchFn = fetch): Promise<string | null> {
  if (ref.kind !== 'greenhouse') return null;
  try {
    const b = await getJson<{ name?: string }>(
      f,
      `https://boards-api.greenhouse.io/v1/boards/${ref.slug}`,
    );
    return b.name?.trim() || null;
  } catch {
    return null;
  }
}

// ---------- listing ----------

const positive = (n: number | null | undefined) => (typeof n === 'number' && n > 0 ? n : null);
const safeUrl = (url: string) => {
  try {
    return normalizeUrl(url);
  } catch {
    return null;
  }
};

async function greenhouse(ref: BoardRef, f: FetchFn): Promise<BoardJob[]> {
  const board = await getJson<{
    jobs?: {
      id: number;
      title: string;
      content?: string;
      location?: { name?: string };
      first_published?: string;
      updated_at?: string;
      metadata?: { name?: string; value?: unknown }[] | null;
    }[];
  }>(f, `https://boards-api.greenhouse.io/v1/boards/${ref.slug}/jobs?content=true`);
  return (board.jobs ?? []).map((j) => {
    const text = j.content ? htmlToText(j.content) : null;
    const salary = text ? parseSalaryRange(text) : null;
    const where = j.location?.name ?? null;
    // Some boards carry a "Location Type" / "Workplace Type" field: Remote, Hybrid, On-Site.
    const kind = j.metadata?.find((m) => /location type|workplace|work model/i.test(m.name ?? ''));
    return {
      url: `https://job-boards.greenhouse.io/${ref.slug}/jobs/${j.id}`,
      title: j.title.trim(),
      location: where,
      remoteType:
        remoteFrom(typeof kind?.value === 'string' ? kind.value : null) ?? remoteFrom(where),
      salaryMin: salary?.min ?? null,
      salaryMax: salary?.max ?? null,
      hourly: false,
      employmentType: null,
      postedAt: toDate(j.first_published ?? j.updated_at),
      descriptionText: text,
    };
  });
}

async function ashby(ref: BoardRef, f: FetchFn): Promise<BoardJob[]> {
  const board = await getJson<{
    jobs?: {
      id: string;
      title: string;
      location?: string;
      secondaryLocations?: { location?: string }[];
      isRemote?: boolean | null;
      isListed?: boolean;
      workplaceType?: string | null;
      employmentType?: string | null;
      descriptionPlain?: string;
      descriptionHtml?: string;
      publishedAt?: string;
      compensation?: {
        compensationTierSummary?: string | null;
        summaryComponents?: {
          compensationType?: string;
          interval?: string;
          minValue?: number | null;
          maxValue?: number | null;
        }[];
      };
    }[];
  }>(
    f,
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(ref.slug)}?includeCompensation=true`,
  );
  return (board.jobs ?? [])
    .filter((j) => j.isListed !== false)
    .map((j) => {
      const pay = j.compensation?.summaryComponents?.find((c) => c.compensationType === 'Salary');
      const hourly = /hour/i.test(pay?.interval ?? '');
      const yearly = pay && /year/i.test(pay.interval ?? '');
      const parsed = parseSalaryRange(j.compensation?.compensationTierSummary ?? '');
      const min = (yearly ? positive(pay.minValue) : null) ?? parsed?.min ?? null;
      const max = (yearly ? positive(pay.maxValue) : null) ?? parsed?.max ?? null;
      return {
        url: `https://jobs.ashbyhq.com/${encodeURIComponent(ref.slug)}/${j.id}`,
        title: j.title.trim(),
        location: joinPlaces([j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)]),
        remoteType: remoteFrom(j.workplaceType) ?? (j.isRemote ? 'Remote' : null),
        salaryMin: min ?? max,
        salaryMax: max ?? min,
        hourly,
        employmentType: j.employmentType ?? null,
        postedAt: toDate(j.publishedAt),
        descriptionText: j.descriptionPlain?.trim() || htmlToText(j.descriptionHtml ?? '') || null,
      };
    });
}

async function lever(ref: BoardRef, f: FetchFn): Promise<BoardJob[]> {
  const api = ref.boardUrl.includes('.eu.') ? 'api.eu.lever.co' : 'api.lever.co';
  const jobs = await getJson<
    | {
        id: string;
        text: string;
        descriptionPlain?: string;
        description?: string;
        lists?: { text: string; content: string }[];
        additionalPlain?: string;
        categories?: { location?: string; allLocations?: string[]; commitment?: string };
        workplaceType?: string;
        salaryRange?: { min?: number; max?: number; interval?: string };
        createdAt?: number;
      }[]
    | { ok?: boolean; error?: string }
  >(f, `https://${api}/v0/postings/${ref.slug}?mode=json`);
  if (!Array.isArray(jobs))
    throw new BoardError(`Lever has no board called "${ref.slug}" (${jobs.error ?? 'not found'}).`);
  return jobs.map((j) => {
    const text = [
      j.descriptionPlain || htmlToText(j.description ?? ''),
      ...(j.lists ?? []).map((l) => `${l.text}\n${htmlToText(`<ul>${l.content}</ul>`)}`),
      j.additionalPlain ?? '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const interval = j.salaryRange?.interval ?? '';
    const yearly = !interval || /year|annual/i.test(interval);
    const parsed = parseSalaryRange(text);
    const min = (yearly ? positive(j.salaryRange?.min) : null) ?? parsed?.min ?? null;
    const max = (yearly ? positive(j.salaryRange?.max) : null) ?? parsed?.max ?? null;
    return {
      url: `${ref.boardUrl}/${j.id}`,
      title: j.text.trim(),
      location: joinPlaces([j.categories?.location, ...(j.categories?.allLocations ?? [])]),
      remoteType: remoteFrom(j.workplaceType),
      salaryMin: min ?? max,
      salaryMax: max ?? min,
      hourly: /hour/i.test(interval),
      employmentType: j.categories?.commitment ?? null,
      postedAt: toDate(j.createdAt),
      descriptionText: text || null,
    };
  });
}

/** Workday search results come 20 to a page, best matches first. */
const WORKDAY_PAGE = 20;
const WORKDAY_PAGES = 3;

async function workday(ref: BoardRef, f: FetchFn, keywords: string[]): Promise<BoardJob[]> {
  const host = new URL(ref.boardUrl).hostname;
  const [tenant, site] = ref.slug.split('/');
  const found = new Map<string, BoardJob>();
  // No titles to look for: one page of the newest jobs, enough to show the board works.
  for (const searchText of keywords.length ? keywords : ['']) {
    for (let page = 0; page < WORKDAY_PAGES; page++) {
      const r = await getJson<{
        total?: number;
        jobPostings?: {
          title?: string;
          externalPath?: string;
          locationsText?: string;
          postedOn?: string;
        }[];
      }>(f, `https://${host}/wday/cxs/${tenant}/${site}/jobs`, {
        appliedFacets: {},
        limit: WORKDAY_PAGE,
        offset: page * WORKDAY_PAGE,
        searchText,
      });
      const list = r.jobPostings ?? [];
      for (const j of list) {
        if (!j.title || !j.externalPath) continue;
        const url = `https://${host}/${site}${j.externalPath}`;
        // "3 Locations" says nothing about where.
        const where = /^\d+ locations?$/i.test(j.locationsText ?? '') ? null : j.locationsText;
        found.set(url, {
          url,
          title: j.title.trim(),
          location: where?.trim() || null,
          remoteType: remoteFrom(where),
          salaryMin: null,
          salaryMax: null,
          hourly: false,
          employmentType: null,
          postedAt: relativeToDate(j.postedOn),
          descriptionText: null,
        });
      }
      if (list.length < WORKDAY_PAGE || (page + 1) * WORKDAY_PAGE >= (r.total ?? 0)) break;
    }
  }
  return [...found.values()];
}

/**
 * Every open job on a board. `keywords` are the titles you watch for; only Workday needs them
 * (it is searched, not listed), so its results are already narrowed to those.
 */
export async function listBoard(
  ref: BoardRef,
  f: FetchFn = fetch,
  opts: { keywords?: string[] } = {},
): Promise<BoardJob[]> {
  const jobs =
    ref.kind === 'greenhouse'
      ? await greenhouse(ref, f)
      : ref.kind === 'ashby'
        ? await ashby(ref, f)
        : ref.kind === 'lever'
          ? await lever(ref, f)
          : await workday(ref, f, opts.keywords ?? []);
  const seen = new Set<string>();
  const out: BoardJob[] = [];
  for (const j of jobs) {
    const url = safeUrl(j.url);
    if (!url || !j.title || seen.has(url)) continue;
    seen.add(url);
    out.push({ ...j, url });
  }
  return out;
}

/**
 * A fetch that remembers what it read, for one check: adding a job to the inbox reads its
 * posting again, and on Ashby that is the whole board.
 */
export function rememberingFetch(f: FetchFn): FetchFn {
  const seen = new Map<string, Promise<{ status: number; body: string }>>();
  return (async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    if (init?.method && init.method !== 'GET') return f(input, init);
    const url = String(input);
    let hit = seen.get(url);
    if (!hit) {
      hit = f(input, init).then(async (r) => ({ status: r.status, body: await r.text() }));
      seen.set(url, hit);
      hit.catch(() => seen.delete(url));
    }
    const r = await hit;
    const empty = r.status === 204 || r.status === 304;
    return new Response(empty ? null : r.body, { status: r.status });
  }) as FetchFn;
}
