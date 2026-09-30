/**
 * Free, rule-based sifting of jobs found on watched boards: is the title one you watch for, and
 * is there a plain reason it can't fit (pay below your floor, a contract, a place you can't
 * work from, a role you already track). No network and no AI. Anything the rules can't tell
 * passes, because a wrongly rejected job costs more than a wrongly admitted one.
 */
import type { Db } from '../../db/client.ts';
import { listApplications } from '../applications.ts';
import { companyKey, titleOverlap } from '../extension.ts';
import { payCheck } from '../pay.ts';
import { normalizeUrl } from '../screening.ts';
import type { BoardJob } from './boards.ts';

/** Titles watched for when you haven't set your own. */
export const DEFAULT_TITLE_INCLUDE = ['program manager', 'program management', 'technical program'];
export const DEFAULT_TITLE_EXCLUDE = [
  'intern',
  'internship',
  'apprentice',
  'junior',
  'coordinator',
  'contract',
  'contractor',
  'associate program manager',
  'associate technical program manager',
];
/** Within reach of Dublin, CA. Remote jobs always pass. */
export const DEFAULT_PLACES = [
  'bay area',
  'san francisco',
  'sf',
  'south san francisco',
  'oakland',
  'berkeley',
  'emeryville',
  'dublin, ca',
  'dublin, california',
  'pleasanton',
  'san ramon',
  'walnut creek',
  'fremont',
  'milpitas',
  'san jose',
  'santa clara',
  'sunnyvale',
  'cupertino',
  'mountain view',
  'palo alto',
  'menlo park',
  'redwood city',
  'san mateo',
  'foster city',
  'san bruno',
];

export interface Criteria {
  /** A title must contain one of these… */
  include: string[];
  /** …and none of these. */
  exclude: string[];
  /** Places you can work from; empty = anywhere. */
  places: string[];
  minBase: number | null;
}

/** Lower case, punctuation to spaces, "Sr." → senior, "TPM" spelled out. */
export function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bsr\b/g, 'senior')
    .replace(/\btpm\b/g, 'technical program manager')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whole-word phrase match: "program manager" is in "Sr. Technical Program Manager, Infra". */
export function hasPhrase(text: string, phrase: string): boolean {
  const p = plain(phrase);
  return Boolean(p) && ` ${plain(text)} `.includes(` ${p} `);
}

/** Is this a title you watch for? (The include list only; exclusions are a reason to filter.) */
export function titleWatched(title: string, include: string[]): boolean {
  return include.some((k) => hasPhrase(title, k));
}

/** What you already track, for spotting a job that is already there. */
export interface Tracked {
  /** Normalized posting URL → the application tracking it. */
  urls: Map<string, number>;
  roles: { company: string; title: string; status: string; applicationId: number }[];
}

export function buildTracked(db: Db): Tracked {
  const urls = new Map<string, number>();
  const roles: Tracked['roles'] = [];
  for (const a of listApplications(db)) {
    if (a.url) {
      try {
        urls.set(normalizeUrl(a.url), a.id);
      } catch {
        // not a URL
      }
    }
    roles.push({
      company: companyKey(a.company),
      title: a.title,
      status: a.status,
      applicationId: a.id,
    });
  }
  return { urls, roles };
}

export type RuleResult =
  | { verdict: 'pass' }
  | { verdict: 'no-rules'; reason: string }
  | { verdict: 'duplicate'; reason: string; applicationId: number };

const NOT_PERMANENT = /contract|intern|temp|part[- ]?time|freelance|seasonal/i;

export function prefilter(
  job: Pick<
    BoardJob,
    | 'url'
    | 'title'
    | 'location'
    | 'remoteType'
    | 'salaryMin'
    | 'salaryMax'
    | 'hourly'
    | 'employmentType'
  > & { company: string },
  criteria: Criteria,
  tracked: Tracked,
): RuleResult {
  const tracking = tracked.urls.get(job.url);
  if (tracking != null)
    return { verdict: 'duplicate', reason: 'Already tracked', applicationId: tracking };

  const excluded = criteria.exclude.find((k) => hasPhrase(job.title, k));
  if (excluded) return { verdict: 'no-rules', reason: `Title has “${excluded}”` };

  if (job.employmentType && NOT_PERMANENT.test(job.employmentType))
    return { verdict: 'no-rules', reason: `Not a permanent role (${job.employmentType})` };
  if (job.hourly) return { verdict: 'no-rules', reason: 'Paid by the hour' };

  const pay = payCheck(criteria.minBase, job.salaryMin, job.salaryMax);
  if (pay?.status === 'fails') return { verdict: 'no-rules', reason: pay.note };

  // Remote always passes, and so does a posting that doesn't say where.
  const remote = job.remoteType === 'Remote' || /\bremote\b/i.test(job.location ?? '');
  if (criteria.places.length && job.location && !remote) {
    if (!criteria.places.some((p) => hasPhrase(job.location!, p)))
      return { verdict: 'no-rules', reason: `Not remote or near you: ${job.location}` };
  }

  const company = companyKey(job.company);
  // The same words in the title, not merely most of them: a company often has sibling roles
  // ("Research Program Manager" and "Research Program Manager, Governance") that are different jobs.
  const same = tracked.roles.find(
    (r) => r.company === company && titleOverlap(r.title, job.title) === 1,
  );
  if (same)
    return {
      verdict: 'duplicate',
      reason: `Same role as “${same.title}”, which you already track (${same.status})`,
      applicationId: same.applicationId,
    };

  return { verdict: 'pass' };
}
