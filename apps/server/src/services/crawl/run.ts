/**
 * Checking the watchlist: reads each followed board, keeps the jobs whose title you watch for,
 * filters out the ones that plainly can't fit, asks the pre-screen model (when one is set up)
 * about the rest, and adds its "yes" and "maybe" to the Screening inbox. Runs on demand ("Check
 * now") and, if you choose, when Job Matrix opens and every few hours after.
 * A job is decided once: what was added or filtered out is remembered by its address.
 */
import { eq, sql } from 'drizzle-orm';
import { RateLimitError, getPrescreenProvider } from '@jm/ai';
import type { Db } from '../../db/client.ts';
import { crawlLeads, crawlSearches, crawlSources, crawlState } from '../../db/schema.ts';
import { NotFoundError, addActivity } from '../applications.ts';
import { companyKey } from '../extension.ts';
import { fetchJobPosting, type FetchFn } from '../jobfetch.ts';
import { logEvent } from '../log.ts';
import { captureJob, normalizeUrl, type CaptureResult } from '../screening.ts';
import { BOARD_LABEL, listBoard, rememberingFetch, type BoardJob } from './boards.ts';
import { prescreenJob, type Prescreener } from './prescreen.ts';
import { listingToJob, type SearchListing } from './searches.ts';
import { buildTracked, prefilter, titleWatched, type Tracked } from './rules.ts';
import {
  crawlCriteria,
  crawlSettings,
  getSearch,
  listSources,
  sourceRef,
  type SourceRow,
} from './watchlist.ts';

export interface CrawlDeps {
  fetchFn?: FetchFn;
  /** The pre-screen model; null = rules only. Left out, the saved setting decides. */
  prescreen?: Prescreener | null;
  /** Pause between pre-screen calls (free tiers allow a few a minute); tests pass 0. */
  prescreenGapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CrawlProgress {
  running: boolean;
  /** Boards to read, and how many are done. */
  boards: number;
  boardsDone: number;
  /** Open jobs seen, those with a watched title, and what became of the new ones. */
  seen: number;
  matched: number;
  added: number;
  filtered: number;
  /** Asked of the pre-screen model this check, and left waiting for it (rate limit, error). */
  screened: number;
  waiting: number;
  startedAt: string | null;
}

export type CrawlResult = Pick<
  CrawlProgress,
  'boards' | 'seen' | 'matched' | 'added' | 'filtered' | 'screened' | 'waiting'
>;

const idle = (): CrawlProgress => ({
  running: false,
  boards: 0,
  boardsDone: 0,
  seen: 0,
  matched: 0,
  added: 0,
  filtered: 0,
  screened: 0,
  waiting: 0,
  startedAt: null,
});
const progress: CrawlProgress = idle();
let current: Promise<CrawlResult> | null = null;

export const crawlProgress = (): CrawlProgress => ({ ...progress });

const today = () => new Date().toISOString().slice(0, 10);

/** Adds a found job to the Screening inbox, with a note saying where it came from. */
async function addToInbox(
  db: Db,
  job: Pick<BoardJob, 'url' | 'title' | 'location'> &
    Partial<Pick<BoardJob, 'salaryMin' | 'salaryMax'>> & {
      company: string;
      remoteType?: string | null;
    },
  note: string,
  fetchFn: FetchFn,
  skipFetch = false,
): Promise<CaptureResult> {
  const money = (n: number) => `$${n.toLocaleString('en-US')}`;
  const r = await captureJob(
    db,
    {
      url: job.url,
      fields: {
        title: job.title,
        company: job.company,
        location: job.location,
        // What the listing said about pay, for when the posting itself can't be read.
        salaryText:
          job.salaryMin || job.salaryMax
            ? `${money(job.salaryMin ?? job.salaryMax!)} - ${money(job.salaryMax ?? job.salaryMin!)}`
            : null,
      },
    },
    { fetchFn, skipFetch },
  );
  if (r.existing) return r;
  addActivity(db, r.applicationId, { at: today(), kind: 'Note', summary: note });
  // Remote / hybrid / on-site from the listing, when the posting didn't say.
  if (job.remoteType)
    db.run(
      sql`UPDATE jobs SET remote_type = ${job.remoteType} WHERE remote_type IS NULL AND id = (SELECT job_id FROM applications WHERE id = ${r.applicationId})`,
    );
  return r;
}

/** Where a found job came from: a followed board or a saved search. */
interface Origin {
  sourceId?: number;
  searchId?: number;
  /** The timeline note on jobs added from here. */
  note: string;
  /** Whether the server can read the posting itself (not on sites that block it). */
  fetchable: boolean;
}

/** A found job, with the company it is at and (for searches) the snippet the results page showed. */
export type FoundJob = BoardJob & { company: string; snippet?: string | null };

/** Records what was decided about a job (one row per posting address). */
function decide(
  db: Db,
  job: FoundJob,
  origin: Origin,
  decision: {
    verdict: string;
    reason: string | null;
    applicationId?: number | null;
    model?: string | null;
    usageId?: number | null;
  },
) {
  const values = {
    sourceId: origin.sourceId ?? null,
    searchId: origin.searchId ?? null,
    url: job.url,
    company: job.company,
    title: job.title,
    location: job.location,
    remoteType: job.remoteType,
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    postedAt: job.postedAt,
    verdict: decision.verdict,
    reason: decision.reason,
    applicationId: decision.applicationId ?? null,
    model: decision.model ?? null,
    usageId: decision.usageId ?? null,
    decidedAt: new Date().toISOString(),
  };
  db.insert(crawlLeads)
    .values(values)
    .onConflictDoUpdate({ target: crawlLeads.url, set: values })
    .run();
}

/**
 * Rule verdicts cost nothing, so a job the rules kept out is looked at again each check; so is
 * one still waiting for the pre-screen.
 */
const UNDECIDED = new Set(['no-rules', 'error', 'waiting']);

/** Waits this long for a rate limit to clear before giving up until the next check. */
const MAX_RETRY_AFTER_S = 60;

type Screened =
  | { verdict: 'yes' | 'maybe' | 'no'; reason: string; model: string; usageId: number }
  | { verdict: 'waiting'; reason: string };

/** What one check (or one saved search) found and did. */
type Counts = Pick<
  CrawlProgress,
  'seen' | 'matched' | 'added' | 'filtered' | 'screened' | 'waiting'
>;
const noCounts = (): Counts => ({
  seen: 0,
  matched: 0,
  added: 0,
  filtered: 0,
  screened: 0,
  waiting: 0,
});

/**
 * The pre-screen for one check: one call at a time with a pause between, a short wait when the
 * provider says "slow down", and once it says "come back later" (or keeps failing) everything
 * left waits for the next check.
 */
function prescreener(db: Db, deps: CrawlDeps, counts: Counts) {
  const screener = deps.prescreen === undefined ? getPrescreenProvider() : deps.prescreen;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gap = deps.prescreenGapMs ?? 2100;
  let queue: Promise<unknown> = Promise.resolve();
  let lastCall = 0;
  let failures = 0;
  let paused: string | null = null;

  const ask = async (job: Parameters<typeof prescreenJob>[1]): Promise<Screened> => {
    for (let attempt = 1; ; attempt++) {
      if (paused) return { verdict: 'waiting', reason: paused };
      const wait = lastCall + gap - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      try {
        const r = await prescreenJob(db, job, screener!);
        failures = 0;
        counts.screened++;
        return { verdict: r.verdict, reason: r.reason, model: r.model, usageId: r.usageId };
      } catch (e) {
        const msg = (e as Error).message;
        if (e instanceof RateLimitError) {
          const after = e.retryAfterSeconds;
          if (after != null && after <= MAX_RETRY_AFTER_S && attempt < 3) {
            await sleep(after * 1000);
            continue;
          }
          paused = `Pre-screen paused until the next check: ${msg}`;
        } else if (++failures >= 3) {
          paused = `Pre-screen stopped after repeated errors: ${msg}`;
        } else {
          return { verdict: 'waiting', reason: `Pre-screen failed: ${msg}` };
        }
        logEvent('crawl.prescreen.paused', paused, {}, 'warn');
      }
    }
  };

  return {
    on: Boolean(screener),
    pausedReason: () => paused,
    screen: (job: Parameters<typeof prescreenJob>[1]): Promise<Screened> => {
      const p = queue.then(() => ask(job));
      queue = p.catch(() => {});
      return p;
    },
  };
}

interface Check {
  db: Db;
  f: FetchFn;
  criteria: ReturnType<typeof crawlCriteria>;
  tracked: Tracked;
  /** Posting address → what was decided before. */
  known: Map<string, string>;
  pre: ReturnType<typeof prescreener>;
  counts: Counts;
}

function startCheck(db: Db, deps: CrawlDeps, counts: Counts): Check {
  return {
    db,
    f: rememberingFetch(deps.fetchFn ?? fetch),
    criteria: crawlCriteria(db),
    tracked: buildTracked(db),
    known: new Map(
      db
        .select({ url: crawlLeads.url, verdict: crawlLeads.verdict })
        .from(crawlLeads)
        .all()
        .map((l) => [l.url, l.verdict]),
    ),
    pre: prescreener(db, deps, counts),
    counts,
  };
}

/**
 * Sorts found jobs: those without a watched title are dropped; the rest go through the rules and
 * the pre-screen, then into the inbox or the filtered-out list. Returns the watched ones.
 */
async function judge(c: Check, jobs: FoundJob[], origin: Origin): Promise<FoundJob[]> {
  const { db, f, criteria, tracked, known, pre, counts } = c;
  const watched = jobs.filter((j) => titleWatched(j.title, criteria.include));
  counts.seen += jobs.length;
  counts.matched += watched.length;
  for (const job of watched) {
    const before = known.get(job.url);
    if (before && !UNDECIDED.has(before)) continue;
    // Not yet counted as filtered out by an earlier check.
    const fresh = !before || before === 'waiting';
    const rule = prefilter(job, criteria, tracked);
    if (rule.verdict !== 'pass') {
      decide(db, job, origin, rule);
      known.set(job.url, rule.verdict);
      if (fresh) counts.filtered++;
      continue;
    }
    let note = origin.note;
    let passed: { verdict: 'yes' | 'maybe'; reason: string; model?: string; usageId?: number } = {
      verdict: 'yes',
      reason: 'Passed your rules',
    };
    try {
      if (pre.on) {
        // Workday and search pages list titles only: read the posting if the server can,
        // else judge from what the listing showed.
        const descriptionText =
          job.descriptionText ??
          (origin.fetchable
            ? await fetchJobPosting(job.url, f).then(
                (posting) => posting.descriptionText,
                () => null,
              )
            : null) ??
          job.snippet ??
          null;
        const s = await pre.screen({ ...job, descriptionText });
        if (s.verdict === 'waiting') {
          decide(db, job, origin, s);
          known.set(job.url, 'waiting');
          counts.waiting++;
          continue;
        }
        if (s.verdict === 'no') {
          decide(db, job, origin, { ...s, verdict: 'no-ai' });
          known.set(job.url, 'no-ai');
          if (fresh) counts.filtered++;
          continue;
        }
        passed = { ...s, verdict: s.verdict };
        note += `. Pre-screen (${s.model}): ${s.verdict} — ${s.reason}`;
      }
      const r = await addToInbox(db, job, note, f, !origin.fetchable);
      const verdict = r.existing ? 'duplicate' : passed.verdict;
      decide(db, job, origin, {
        ...passed,
        verdict,
        reason: r.existing ? 'Already tracked' : passed.reason,
        applicationId: r.applicationId,
      });
      known.set(job.url, verdict);
      tracked.urls.set(job.url, r.applicationId);
      tracked.roles.push({
        company: companyKey(job.company),
        title: job.title,
        status: r.status,
        applicationId: r.applicationId,
      });
      if (!r.existing) {
        counts.added++;
        logEvent('crawl.added', `Added ${job.company} — ${job.title} to the inbox`, {
          applicationId: r.applicationId,
          url: job.url,
        });
      }
    } catch (e) {
      decide(db, job, origin, { verdict: 'error', reason: (e as Error).message });
      known.set(job.url, 'error');
    }
  }
  return watched;
}

async function checkBoard(c: Check, source: SourceRow) {
  const jobs = await listBoard(sourceRef(source), c.f, { keywords: c.criteria.include });
  const watched = await judge(
    c,
    jobs.map((j) => ({ ...j, company: source.companyName })),
    {
      sourceId: source.id,
      note: `Found on ${source.companyName}'s ${BOARD_LABEL[source.kind]} job board (watchlist)`,
      fetchable: true,
    },
  );
  c.db
    .update(crawlSources)
    .set({
      lastCheckedAt: new Date().toISOString(),
      lastError: null,
      lastCount: jobs.length,
      lastMatched: watched.length,
    })
    .where(eq(crawlSources.id, source.id))
    .run();
}

async function run(db: Db, deps: CrawlDeps, trigger: string): Promise<CrawlResult> {
  const sources = listSources(db).filter((s) => s.enabled);
  Object.assign(progress, idle(), {
    running: true,
    boards: sources.length,
    startedAt: new Date().toISOString(),
  });
  logEvent('crawl.start', `Checking ${sources.length} watched job boards`, {
    boards: sources.length,
    trigger,
  });
  const check = startCheck(db, deps, progress);
  const failed: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < sources.length) {
      const source = sources[next++]!;
      try {
        await checkBoard(check, source);
      } catch (e) {
        const msg = (e as Error).message;
        failed.push(source.companyName);
        db.update(crawlSources)
          .set({ lastCheckedAt: new Date().toISOString(), lastError: msg })
          .where(eq(crawlSources.id, source.id))
          .run();
        logEvent(
          'crawl.board.error',
          `Couldn't read ${source.companyName}'s job board: ${msg}`,
          { sourceId: source.id, boardUrl: source.boardUrl },
          'warn',
        );
      }
      progress.boardsDone++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, sources.length) }, worker));
  const result: CrawlResult = {
    boards: progress.boards,
    seen: progress.seen,
    matched: progress.matched,
    added: progress.added,
    filtered: progress.filtered,
    screened: progress.screened,
    waiting: progress.waiting,
  };
  const problems = [
    failed.length ? `Couldn't read: ${failed.join(', ')}` : null,
    check.pre.pausedReason(),
  ].filter(Boolean);
  crawlSettings(db); // makes sure the row exists
  db.update(crawlState)
    .set({
      boards: result.boards,
      seen: result.seen,
      matched: result.matched,
      added: result.added,
      filtered: result.filtered,
      lastRunAt: new Date().toISOString(),
      lastError: problems.length ? problems.join(' · ') : null,
    })
    .where(eq(crawlState.id, 1))
    .run();
  logEvent(
    'crawl.done',
    `Watchlist checked: ${result.matched} matching jobs on ${result.boards} boards, ${result.added} added to the inbox, ${result.filtered} filtered out${result.waiting ? `, ${result.waiting} waiting for the pre-screen` : ''}`,
    { ...result, failed },
  );
  return result;
}

/** Checks every followed board. One check at a time; a second call joins the one running. */
export function runCrawl(
  db: Db,
  deps: CrawlDeps = {},
  opts: { trigger?: string } = {},
): Promise<CrawlResult> {
  current ??= run(db, deps, opts.trigger ?? 'manual').finally(() => {
    current = null;
    progress.running = false;
  });
  return current;
}

/**
 * One saved search's results, as the Chrome extension read them in your signed-in Chrome: the
 * listings go through the same rules and pre-screen as board jobs. A blocked page (robot check,
 * signed out) is recorded on the search and nothing else happens.
 */
export async function ingestSearch(
  db: Db,
  searchId: number,
  page: { listings: SearchListing[]; problem?: string | null },
  deps: CrawlDeps = {},
): Promise<Counts> {
  const search = getSearch(db, searchId);
  const counts = noCounts();
  const now = new Date().toISOString();
  if (page.problem) {
    db.update(crawlSearches)
      .set({ lastRunAt: now, lastError: page.problem })
      .where(eq(crawlSearches.id, searchId))
      .run();
    logEvent('crawl.search.blocked', `${search.label}: ${page.problem}`, { searchId }, 'warn');
    return counts;
  }
  const check = startCheck(db, deps, counts);
  const jobs: FoundJob[] = [];
  for (const l of page.listings) {
    const job = listingToJob(l);
    if (job) {
      jobs.push(job);
      continue;
    }
    // A LinkedIn card that hadn't rendered came by its id alone: read the posting here.
    if (search.site !== 'linkedin') continue;
    try {
      const url = normalizeUrl(l.url);
      const p = await fetchJobPosting(url, check.f);
      if (!p.title) continue;
      jobs.push({
        url,
        title: p.title,
        company: p.company ?? 'Unknown',
        location: p.location,
        remoteType: p.remoteType,
        salaryMin: p.salaryMin,
        salaryMax: p.salaryMax,
        hourly: false,
        employmentType: null,
        postedAt: p.posted?.date ?? null,
        descriptionText: p.descriptionText,
        snippet: null,
      });
    } catch {
      // Blocked or gone: skipped this time, tried again on the next run.
    }
  }
  const watched = await judge(check, jobs, {
    searchId,
    note: `Found by your saved search “${search.label}”`,
    // LinkedIn postings can be read by the server; the other sites block it.
    fetchable: search.site === 'linkedin',
  });
  db.update(crawlSearches)
    .set({
      lastRunAt: now,
      lastError: check.pre.pausedReason() ?? (jobs.length ? null : 'No listings found on the page'),
      lastCount: jobs.length,
      lastMatched: watched.length,
      lastAdded: counts.added,
    })
    .where(eq(crawlSearches.id, searchId))
    .run();
  logEvent(
    'crawl.search.done',
    `${search.label}: ${jobs.length} listings, ${watched.length} matching, ${counts.added} added, ${counts.filtered} filtered out`,
    { searchId, ...counts },
  );
  return counts;
}

/** "Add anyway" on a filtered-out job: puts it in the inbox regardless of the rules. */
export async function addLead(db: Db, id: number, deps: CrawlDeps = {}): Promise<CaptureResult> {
  const lead = db.select().from(crawlLeads).where(eq(crawlLeads.id, id)).get();
  if (!lead) throw new NotFoundError(`Job ${id} not found`);
  const r = await addToInbox(
    db,
    lead,
    `Added from the watchlist by you (it had been filtered out: ${lead.reason ?? 'no reason recorded'})`,
    deps.fetchFn ?? fetch,
    lead.searchId != null && !/linkedin\.com/.test(lead.url),
  );
  db.update(crawlLeads)
    .set({
      verdict: 'yes',
      reason: 'Added by you',
      applicationId: r.applicationId,
      decidedAt: new Date().toISOString(),
    })
    .where(eq(crawlLeads.id, id))
    .run();
  return r;
}

// ---------- schedule ----------

let timer: NodeJS.Timeout | null = null;
let nextAt: number | null = null;

export const nextCrawlAt = () => (nextAt ? new Date(nextAt).toISOString() : null);

/**
 * Arms the next scheduled check from the saved setting: manual (-1) never; "when the app opens"
 * (0) only at start-up; otherwise at start-up and every N minutes. Called at start-up, after
 * every check, and when the setting changes. The timer never keeps the process alive.
 */
export function scheduleCrawl(db: Db, deps: CrawlDeps = {}, opts: { startup?: boolean } = {}) {
  if (timer) clearTimeout(timer);
  timer = null;
  nextAt = null;
  const s = crawlSettings(db);
  if (!s.enabled || s.intervalMinutes < 0) return;
  if (s.intervalMinutes === 0 && !opts.startup) return;
  const delay = opts.startup ? 15_000 : s.intervalMinutes * 60_000;
  nextAt = Date.now() + delay;
  timer = setTimeout(async () => {
    timer = null;
    nextAt = null;
    try {
      // Nothing to check until a board is followed.
      if (listSources(db).some((s) => s.enabled)) await runCrawl(db, deps, { trigger: 'schedule' });
    } catch (e) {
      logEvent('crawl.error', `Watchlist check failed: ${(e as Error).message}`, {}, 'error');
    }
    scheduleCrawl(db, deps);
  }, delay);
  timer.unref();
}

export function stopCrawlSchedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  nextAt = null;
}
