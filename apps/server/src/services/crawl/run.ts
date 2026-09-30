/**
 * Checking the watchlist: reads each followed board, keeps the jobs whose title you watch for,
 * filters out the ones that plainly can't fit, asks the pre-screen model (when one is set up)
 * about the rest, and adds its "yes" and "maybe" to the Screening inbox. Runs on demand ("Check
 * now") and, if you choose, when Job Matrix opens and every few hours after.
 * A job is decided once: what was added or filtered out is remembered by its address.
 */
import { eq } from 'drizzle-orm';
import { RateLimitError, getPrescreenProvider } from '@jm/ai';
import type { Db } from '../../db/client.ts';
import { crawlLeads, crawlSources, crawlState } from '../../db/schema.ts';
import { NotFoundError, addActivity } from '../applications.ts';
import { companyKey } from '../extension.ts';
import { fetchJobPosting, type FetchFn } from '../jobfetch.ts';
import { logEvent } from '../log.ts';
import { captureJob, type CaptureResult } from '../screening.ts';
import { BOARD_LABEL, listBoard, rememberingFetch, type BoardJob } from './boards.ts';
import { prescreenJob, type Prescreener } from './prescreen.ts';
import { buildTracked, prefilter, titleWatched, type Tracked } from './rules.ts';
import {
  crawlCriteria,
  crawlSettings,
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
  job: Pick<BoardJob, 'url' | 'title' | 'location'> & { company: string },
  note: string,
  fetchFn: FetchFn,
): Promise<CaptureResult> {
  const r = await captureJob(
    db,
    { url: job.url, fields: { title: job.title, company: job.company, location: job.location } },
    { fetchFn },
  );
  if (!r.existing) addActivity(db, r.applicationId, { at: today(), kind: 'Note', summary: note });
  return r;
}

/** Records what was decided about a job (one row per posting address). */
function decide(
  db: Db,
  job: BoardJob & { company: string },
  sourceId: number,
  decision: {
    verdict: string;
    reason: string | null;
    applicationId?: number | null;
    model?: string | null;
    usageId?: number | null;
  },
) {
  const values = {
    sourceId,
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

/**
 * The pre-screen for one check: one call at a time with a pause between, a short wait when the
 * provider says "slow down", and once it says "come back later" (or keeps failing) everything
 * left waits for the next check.
 */
function prescreener(db: Db, deps: CrawlDeps) {
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
        progress.screened++;
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
}

async function checkBoard(c: Check, source: SourceRow) {
  const { db, f, criteria, tracked, known, pre } = c;
  const jobs = await listBoard(sourceRef(source), f, { keywords: criteria.include });
  const watched = jobs.filter((j) => titleWatched(j.title, criteria.include));
  progress.seen += jobs.length;
  progress.matched += watched.length;
  for (const j of watched) {
    const before = known.get(j.url);
    if (before && !UNDECIDED.has(before)) continue;
    // Not yet counted as filtered out by an earlier check.
    const fresh = !before || before === 'waiting';
    const job = { ...j, company: source.companyName };
    const rule = prefilter(job, criteria, tracked);
    if (rule.verdict !== 'pass') {
      decide(db, job, source.id, rule);
      known.set(j.url, rule.verdict);
      if (fresh) progress.filtered++;
      continue;
    }
    let note = `Found on ${source.companyName}'s ${BOARD_LABEL[source.kind]} job board (watchlist)`;
    let passed: { verdict: 'yes' | 'maybe'; reason: string; model?: string; usageId?: number } = {
      verdict: 'yes',
      reason: 'Passed your rules',
    };
    try {
      if (pre.on) {
        // Workday lists titles only: read the posting now that the rules let it through.
        const descriptionText =
          j.descriptionText ??
          (await fetchJobPosting(j.url, f).then(
            (posting) => posting.descriptionText,
            () => null,
          ));
        const s = await pre.screen({ ...job, descriptionText });
        if (s.verdict === 'waiting') {
          decide(db, job, source.id, s);
          known.set(j.url, 'waiting');
          progress.waiting++;
          continue;
        }
        if (s.verdict === 'no') {
          decide(db, job, source.id, { ...s, verdict: 'no-ai' });
          known.set(j.url, 'no-ai');
          if (fresh) progress.filtered++;
          continue;
        }
        passed = { ...s, verdict: s.verdict };
        note += `. Pre-screen (${s.model}): ${s.verdict} — ${s.reason}`;
      }
      const r = await addToInbox(db, job, note, f);
      const verdict = r.existing ? 'duplicate' : passed.verdict;
      decide(db, job, source.id, {
        ...passed,
        verdict,
        reason: r.existing ? 'Already tracked' : passed.reason,
        applicationId: r.applicationId,
      });
      known.set(j.url, verdict);
      tracked.urls.set(j.url, r.applicationId);
      tracked.roles.push({
        company: companyKey(job.company),
        title: job.title,
        status: r.status,
        applicationId: r.applicationId,
      });
      if (!r.existing) {
        progress.added++;
        logEvent('crawl.added', `Added ${job.company} — ${job.title} to the inbox`, {
          applicationId: r.applicationId,
          url: job.url,
        });
      }
    } catch (e) {
      decide(db, job, source.id, { verdict: 'error', reason: (e as Error).message });
      known.set(j.url, 'error');
    }
  }
  db.update(crawlSources)
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
  const check: Check = {
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
    pre: prescreener(db, deps),
  };
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

/** "Add anyway" on a filtered-out job: puts it in the inbox regardless of the rules. */
export async function addLead(db: Db, id: number, deps: CrawlDeps = {}): Promise<CaptureResult> {
  const lead = db.select().from(crawlLeads).where(eq(crawlLeads.id, id)).get();
  if (!lead) throw new NotFoundError(`Job ${id} not found`);
  const r = await addToInbox(
    db,
    lead,
    `Added from the watchlist by you (it had been filtered out: ${lead.reason ?? 'no reason recorded'})`,
    deps.fetchFn ?? fetch,
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
