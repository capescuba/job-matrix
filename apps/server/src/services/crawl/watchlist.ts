/**
 * The watchlist: the company job boards you follow, what to look for on them, and the jobs
 * found there that were filtered out (each with its reason).
 */
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { splitLines } from '@jm/shared';
import type { Db } from '../../db/client.ts';
import { companies, crawlLeads, crawlSources, crawlState } from '../../db/schema.ts';
import { NotFoundError } from '../applications.ts';
import { companyKey } from '../extension.ts';
import type { FetchFn } from '../jobfetch.ts';
import { getProfile } from '../resume.ts';
import { companyFromBoardUrl, companyFromHost } from '../screening.ts';
import {
  BoardError,
  boardCompanyName,
  listBoard,
  resolveSource,
  type BoardKind,
  type BoardRef,
} from './boards.ts';
import {
  DEFAULT_PLACES,
  DEFAULT_TITLE_EXCLUDE,
  DEFAULT_TITLE_INCLUDE,
  titleWatched,
  type Criteria,
} from './rules.ts';

/** Manual, when the app opens, then hours. Boards change slowly; there is no need to hurry. */
export const CRAWL_INTERVALS = [-1, 0, 60, 180, 360] as const;

/** Verdicts that put a job in the inbox, and ones that keep it out (for now, if waiting). */
export const ADDED_VERDICTS = ['yes', 'maybe'] as const;
export const FILTERED_VERDICTS = ['no-rules', 'no-ai', 'duplicate', 'error', 'waiting'] as const;

function stateRow(db: Db) {
  const row = db.select().from(crawlState).where(eq(crawlState.id, 1)).get();
  if (row) return row;
  db.insert(crawlState).values({ id: 1 }).onConflictDoNothing().run();
  return db.select().from(crawlState).where(eq(crawlState.id, 1)).get()!;
}

/** Saved settings, with the built-in lists where you haven't set your own. */
export function crawlSettings(db: Db) {
  const s = stateRow(db);
  return {
    ...s,
    titleInclude: s.titleInclude == null ? DEFAULT_TITLE_INCLUDE : splitLines(s.titleInclude),
    titleExclude: s.titleExclude == null ? DEFAULT_TITLE_EXCLUDE : splitLines(s.titleExclude),
    locations: s.locations == null ? DEFAULT_PLACES : splitLines(s.locations),
  };
}

export function crawlCriteria(db: Db): Criteria {
  const s = crawlSettings(db);
  return {
    include: s.titleInclude,
    exclude: s.titleExclude,
    places: s.locations,
    minBase: getProfile(db).minBase,
  };
}

export function updateCrawlSettings(
  db: Db,
  patch: {
    enabled?: boolean;
    intervalMinutes?: number;
    titleInclude?: string[];
    titleExclude?: string[];
    locations?: string[];
  },
) {
  stateRow(db);
  const lines = (l: string[] | undefined) =>
    l === undefined
      ? undefined
      : l
          .map((x) => x.trim())
          .filter(Boolean)
          .join('\n');
  db.update(crawlState)
    .set({
      ...(patch.enabled !== undefined && { enabled: patch.enabled }),
      ...(patch.intervalMinutes !== undefined && { intervalMinutes: patch.intervalMinutes }),
      ...(patch.titleInclude !== undefined && { titleInclude: lines(patch.titleInclude) }),
      ...(patch.titleExclude !== undefined && { titleExclude: lines(patch.titleExclude) }),
      ...(patch.locations !== undefined && { locations: lines(patch.locations) }),
    })
    .where(eq(crawlState.id, 1))
    .run();
  return crawlSettings(db);
}

// ---------- the boards ----------

export type SourceRow = Omit<typeof crawlSources.$inferSelect, 'kind'> & { kind: BoardKind };

export const listSources = (db: Db) =>
  db
    .select()
    .from(crawlSources)
    .orderBy(sql`lower(${crawlSources.companyName})`)
    .all() as SourceRow[];

export const sourceRef = (s: Pick<SourceRow, 'kind' | 'slug' | 'boardUrl'>): BoardRef => ({
  kind: s.kind,
  slug: s.slug,
  boardUrl: s.boardUrl,
});

/** "openai" → "OpenAI" when you already track that company; else the slug, tidied. */
function guessCompany(db: Db, ref: BoardRef, pasted: string): string {
  const squash = (s: string) => companyKey(s).replace(/ /g, '');
  const slug = squash(ref.kind === 'workday' ? ref.slug.split('/')[0]! : ref.slug);
  const known = db
    .select({ name: companies.name })
    .from(companies)
    .all()
    .find((c) => squash(c.name) === slug);
  return (
    known?.name ??
    companyFromHost(pasted) ??
    companyFromBoardUrl(ref.boardUrl) ??
    ref.slug.replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/**
 * Follows the board behind a pasted address (a board, one of its jobs, or a careers page that
 * embeds one). The board is read once straight away, so a wrong address fails here.
 */
export async function addSource(
  db: Db,
  input: { url: string; companyName?: string | null },
  opts: { fetchFn?: FetchFn } = {},
): Promise<SourceRow> {
  const f = opts.fetchFn ?? fetch;
  const ref = await resolveSource(input.url, f);
  const existing = listSources(db).find((s) => s.kind === ref.kind && s.slug === ref.slug);
  if (existing) throw new BoardError(`${existing.companyName} is already on your watchlist.`);
  const { include } = crawlCriteria(db);
  const jobs = await listBoard(ref, f, { keywords: include });
  const companyName =
    input.companyName?.trim() ||
    (await boardCompanyName(ref, f)) ||
    guessCompany(db, ref, input.url);
  return db
    .insert(crawlSources)
    .values({
      ...ref,
      companyName,
      lastCheckedAt: new Date().toISOString(),
      lastCount: jobs.length,
      lastMatched: jobs.filter((j) => titleWatched(j.title, include)).length,
    })
    .returning()
    .get() as SourceRow;
}

export function updateSource(
  db: Db,
  id: number,
  patch: { enabled?: boolean; companyName?: string },
) {
  const row = db
    .update(crawlSources)
    .set({
      ...(patch.enabled !== undefined && { enabled: patch.enabled }),
      ...(patch.companyName?.trim() && { companyName: patch.companyName.trim() }),
    })
    .where(eq(crawlSources.id, id))
    .returning()
    .get();
  if (!row) throw new NotFoundError(`Watchlist entry ${id} not found`);
  return row as SourceRow;
}

/** Stops following a board. Jobs already in the inbox stay; its filtered-out jobs go. */
export function removeSource(db: Db, id: number) {
  db.delete(crawlSources).where(eq(crawlSources.id, id)).run();
}

// ---------- jobs found ----------

export type LeadRow = typeof crawlLeads.$inferSelect;

/** Jobs that matched a watched title but were kept out of the inbox, newest first. */
export const listFiltered = (db: Db, limit = 500) =>
  db
    .select()
    .from(crawlLeads)
    .where(inArray(crawlLeads.verdict, [...FILTERED_VERDICTS]))
    .orderBy(desc(crawlLeads.createdAt), desc(crawlLeads.id))
    .limit(limit)
    .all();

/** Jobs the rules let through that the pre-screen hasn't answered yet. */
export const waitingCount = (db: Db) =>
  db
    .select({ n: sql<number>`count(*)` })
    .from(crawlLeads)
    .where(eq(crawlLeads.verdict, 'waiting'))
    .get()?.n ?? 0;

export const filteredCount = (db: Db) =>
  db
    .select({ n: sql<number>`count(*)` })
    .from(crawlLeads)
    .where(inArray(crawlLeads.verdict, [...FILTERED_VERDICTS]))
    .get()?.n ?? 0;
