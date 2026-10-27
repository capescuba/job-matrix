/**
 * Is the client hiring for this role itself? Reads the client's own job board (the watchlist's
 * board reader) and keeps roles whose title looks like the agency's. Free: no AI.
 */
import type { DirectCheck, DirectMatch } from '@jm/shared';
import type { Db } from '../../db/client.ts';
import { crawlSources } from '../../db/schema.ts';
import {
  BoardError,
  listBoard,
  resolveSource,
  type BoardKind,
  type BoardRef,
} from '../crawl/boards.ts';
import { sameCompany } from '../jobIdentity.ts';
import { titleOverlap } from '../extension.ts';
import type { FetchFn } from '../jobfetch.ts';
import { findTrackedByUrl, normalizeUrl } from '../screening.ts';
import { copiedShare } from './clues.ts';

/** Title words in common for a role to count as the same one (agency titles add noise). */
export const DIRECT_MIN_OVERLAP = 0.5;
/** Share of the email's wording a posting must repeat to count whatever its title. */
const DIRECT_MIN_COPIED = 0.15;
const MAX_MATCHES = 5;

/**
 * The role without what agencies bolt on: "Sr. TPM - Contract (Remote, W2)" → "Sr. TPM".
 */
export function roleTitle(title: string): string {
  return (
    title
      .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
      .split(/\s+[-–|]\s+/)[0]!
      .replace(
        /\b(?:contract(?:-to-hire)?|c2h|c2c|w2|1099|temp(?:orary)?|remote|hybrid|onsite)\b/gi,
        ' ',
      )
      .replace(/\s+/g, ' ')
      .replace(/[\s,/-]+$/, '')
      .trim() || title
  );
}

/** The board to read: the watchlist's for this company, else the address given. */
async function boardFor(
  db: Db,
  company: string,
  careersUrl: string | null | undefined,
  f: FetchFn,
): Promise<BoardRef | null> {
  const watched = db
    .select()
    .from(crawlSources)
    .all()
    .find((s) => sameCompany(s.companyName, company));
  if (watched)
    return { kind: watched.kind as BoardKind, slug: watched.slug, boardUrl: watched.boardUrl };
  if (!careersUrl) return null;
  return resolveSource(careersUrl, f);
}

export async function checkDirect(
  db: Db,
  company: string,
  careersUrl: string | null | undefined,
  /** The agency's job: its title, and the email (to spot the posting it copies). */
  agency: { title: string; text?: string | null },
  f: FetchFn = fetch,
  now = new Date(),
): Promise<DirectCheck> {
  const checkedAt = now.toISOString();
  let ref: BoardRef | null;
  try {
    ref = await boardFor(db, company, careersUrl, f);
  } catch (e) {
    return {
      checkedAt,
      status: e instanceof BoardError ? 'no_board' : 'error',
      boardUrl: null,
      matches: [],
      note: (e as Error).message,
    };
  }
  if (!ref)
    return {
      checkedAt,
      status: 'no_board',
      boardUrl: null,
      matches: [],
      note: `No careers page known for ${company}. Paste their careers page or one of their job postings.`,
    };

  const role = roleTitle(agency.title);
  let jobs;
  try {
    jobs = await listBoard(ref, f, { keywords: [role] });
  } catch (e) {
    return {
      checkedAt,
      status: 'error',
      boardUrl: ref.boardUrl,
      matches: [],
      note: (e as Error).message,
    };
  }
  let given: string | null = null;
  try {
    given = careersUrl ? normalizeUrl(careersUrl) : null;
  } catch {
    // Not a URL: nothing to single out.
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  const matches: DirectMatch[] = jobs
    .map((j) => ({
      j,
      overlap: round(titleOverlap(role, j.title)),
      copied:
        agency.text && j.descriptionText ? round(copiedShare(agency.text, j.descriptionText)) : 0,
    }))
    // The posting you (or the lookup) pointed at, or the one the email copies, counts whatever
    // its title says.
    .filter(
      ({ j, overlap, copied }) =>
        overlap >= DIRECT_MIN_OVERLAP || copied >= DIRECT_MIN_COPIED || j.url === given,
    )
    // Copied wording says far more than a similar title ("TPM, Billing" vs "TPM, Compute").
    .sort((a, b) => b.copied * 2 + b.overlap - (a.copied * 2 + a.overlap))
    .slice(0, MAX_MATCHES)
    .map(({ j, overlap, copied }) => {
      const tracked = findTrackedByUrl(db, j.url);
      return {
        title: j.title,
        url: j.url,
        location: j.location,
        overlap,
        ...(copied > 0 && { copied }),
        ...(tracked && { applicationId: tracked.applicationId }),
      };
    });
  return {
    checkedAt,
    status: matches.length ? 'match' : 'none',
    boardUrl: ref.boardUrl,
    matches,
    ...(!matches.length && {
      note: `${jobs.length} open roles on their board; none like "${role}".`,
    }),
  };
}
