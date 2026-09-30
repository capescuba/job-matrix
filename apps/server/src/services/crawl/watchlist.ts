/**
 * The watchlist: the company job boards you follow, what to look for on them, and the jobs
 * found there that were filtered out (each with its reason).
 */
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { splitLines } from '@jm/shared';
import type { Db } from '../../db/client.ts';
import { companies, crawlLeads, crawlSearches, crawlSources, crawlState } from '../../db/schema.ts';
import {
  DEFAULT_SEARCH_KEYWORDS,
  DEFAULT_SEARCH_LOCATION,
  SEARCH_SITES,
  SEARCH_SITE_LABEL,
  buildSearchUrl,
  searchLabel,
  searchSiteOf,
  type SearchSite,
} from './searches.ts';
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
    searchKeywords: s.searchKeywords?.trim() || DEFAULT_SEARCH_KEYWORDS,
    searchLocation: s.searchLocation?.trim() || DEFAULT_SEARCH_LOCATION,
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

// ---------- saved searches ----------

export type SearchRow = Omit<typeof crawlSearches.$inferSelect, 'site'> & { site: SearchSite };

export const listSearches = (db: Db) =>
  db.select().from(crawlSearches).orderBy(crawlSearches.id).all() as SearchRow[];

export function getSearch(db: Db, id: number): SearchRow {
  const row = db.select().from(crawlSearches).where(eq(crawlSearches.id, id)).get();
  if (!row) throw new NotFoundError(`Saved search ${id} not found`);
  return row as SearchRow;
}

/** Saves a results-page address from LinkedIn, Indeed, Glassdoor or ZipRecruiter. */
export function addSearch(db: Db, input: { url: string; label?: string | null }): SearchRow {
  const site = searchSiteOf(input.url);
  if (!site)
    throw new BoardError(
      `Paste a search results page from ${Object.values(SEARCH_SITE_LABEL).join(', ')}.`,
    );
  if (listSearches(db).some((s) => s.url === input.url.trim()))
    throw new BoardError('That search is already saved.');
  return db
    .insert(crawlSearches)
    .values({ site, url: input.url.trim(), label: input.label?.trim() || searchLabel(input.url) })
    .returning()
    .get() as SearchRow;
}

export function updateSearch(
  db: Db,
  id: number,
  patch: { enabled?: boolean; label?: string; url?: string },
) {
  const current = getSearch(db, id);
  // A new address must be on the same site (the extension saves Glassdoor's, once it knows the
  // place's id).
  if (patch.url !== undefined && searchSiteOf(patch.url) !== current.site)
    throw new BoardError(`That address is not a ${SEARCH_SITE_LABEL[current.site]} search.`);
  db.update(crawlSearches)
    .set({
      ...(patch.enabled !== undefined && { enabled: patch.enabled }),
      ...(patch.label?.trim() && { label: patch.label.trim() }),
      ...(patch.url !== undefined && { url: patch.url.trim() }),
    })
    .where(eq(crawlSearches.id, id))
    .run();
  return getSearch(db, id);
}

/** Forgets a saved search. Jobs it found stay (in the inbox or the filtered-out list). */
export function removeSearch(db: Db, id: number) {
  db.transaction((tx) => {
    tx.update(crawlLeads).set({ searchId: null }).where(eq(crawlLeads.searchId, id)).run();
    tx.delete(crawlSearches).where(eq(crawlSearches.id, id)).run();
  });
}

/**
 * The built-in search on each job site, made from your keywords and place. Created the first
 * time they're asked for, so the four sites are always listed; each can be switched off.
 */
export function jobSites(db: Db) {
  const s = crawlSettings(db);
  const have = listSearches(db).filter((x) => x.preset);
  for (const site of SEARCH_SITES) {
    if (have.some((x) => x.site === site)) continue;
    db.insert(crawlSearches)
      .values({
        site,
        preset: true,
        label: SEARCH_SITE_LABEL[site],
        url: buildSearchUrl(site, s.searchKeywords, s.searchLocation),
      })
      .run();
  }
  const rows = listSearches(db).filter((x) => x.preset);
  return {
    keywords: s.searchKeywords,
    location: s.searchLocation,
    sites: SEARCH_SITES.map((site) => rows.find((x) => x.site === site)!),
  };
}

/** New keywords or place: every built-in site search is remade to match. */
export function setJobSiteSearch(db: Db, input: { keywords: string; location: string }) {
  stateRow(db);
  db.update(crawlState)
    .set({ searchKeywords: input.keywords.trim(), searchLocation: input.location.trim() })
    .where(eq(crawlState.id, 1))
    .run();
  const { keywords, location, sites } = jobSites(db);
  for (const row of sites)
    db.update(crawlSearches)
      .set({ url: buildSearchUrl(row.site, keywords, location), lastError: null })
      .where(eq(crawlSearches.id, row.id))
      .run();
  return jobSites(db);
}

/** When this server started: "when Job Matrix opens" means once per start. */
const startedAt = new Date().toISOString();

/**
 * Whether the saved searches should run now, by the same schedule as the boards: never when
 * manual; once per app start; or also every N minutes. Asked by the web page, which then asks
 * the Chrome extension (only it can open the searches in your signed-in Chrome).
 */
export function searchesDue(db: Db, now = new Date()): boolean {
  const s = crawlSettings(db);
  if (!s.enabled || s.intervalMinutes < 0) return false;
  if (!listSearches(db).some((x) => x.enabled)) return false;
  const last = s.searchRunAt;
  if (!last || last < startedAt) return true;
  return s.intervalMinutes > 0 && now.getTime() - Date.parse(last) > s.intervalMinutes * 60_000;
}

/** The extension is starting a run: stamp it so no other window starts one too. */
export function markSearchRun(db: Db) {
  stateRow(db);
  db.update(crawlState)
    .set({ searchRunAt: new Date().toISOString() })
    .where(eq(crawlState.id, 1))
    .run();
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
