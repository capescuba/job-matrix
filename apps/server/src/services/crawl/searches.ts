/**
 * Saved job searches on LinkedIn, Indeed, Glassdoor and ZipRecruiter. The server can't read
 * these sites (they block it, or want you signed in), so the Chrome extension opens each search
 * in your Chrome, reads the listings and posts them here. This file turns a listing into the
 * same shape as a board job, so the same rules and pre-screen apply.
 */
import { z } from 'zod';
import { parseSalaryRange, remoteFrom } from '../jobfetch.ts';
import { normalizeUrl } from '../screening.ts';
import type { FoundJob } from './run.ts';

export const SEARCH_SITES = ['linkedin', 'indeed', 'glassdoor', 'ziprecruiter'] as const;
export type SearchSite = (typeof SEARCH_SITES)[number];

export const SEARCH_SITE_LABEL: Record<SearchSite, string> = {
  linkedin: 'LinkedIn',
  indeed: 'Indeed',
  glassdoor: 'Glassdoor',
  ziprecruiter: 'ZipRecruiter',
};

/** Which site a results-page address is on; null for anything else. */
export function searchSiteOf(raw: string): SearchSite | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const h = u.hostname.toLowerCase();
  if (h.endsWith('linkedin.com') && u.pathname.startsWith('/jobs')) return 'linkedin';
  if (/(^|\.)indeed\.com$/.test(h)) return 'indeed';
  if (/(^|\.)glassdoor\.[a-z.]+$/.test(h)) return 'glassdoor';
  if (/(^|\.)ziprecruiter\.com$/.test(h)) return 'ziprecruiter';
  return null;
}

/** What the built-in site searches look for when you haven't said. */
export const DEFAULT_SEARCH_KEYWORDS = 'technical program manager';
export const DEFAULT_SEARCH_LOCATION = 'San Francisco Bay Area';

/**
 * The results page for keywords and a place on each site, newest first (the last week where the
 * site allows it). Glassdoor only takes a place by its own id, so its address carries the place
 * as text (locKeyword); the extension looks the id up inside Glassdoor on the first run.
 */
export function buildSearchUrl(site: SearchSite, keywords: string, location: string): string {
  const q = new URLSearchParams();
  switch (site) {
    case 'linkedin':
      q.set('keywords', keywords);
      q.set('location', location);
      q.set('sortBy', 'DD');
      q.set('f_TPR', 'r604800');
      return `https://www.linkedin.com/jobs/search/?${q}`;
    case 'indeed':
      q.set('q', keywords);
      q.set('l', location);
      q.set('sort', 'date');
      q.set('fromage', '7');
      return `https://www.indeed.com/jobs?${q}`;
    case 'glassdoor':
      q.set('sc.keyword', keywords);
      q.set('locKeyword', location);
      q.set('sortBy', 'date_desc');
      return `https://www.glassdoor.com/Job/jobs.htm?${q}`;
    case 'ziprecruiter':
      q.set('search', keywords);
      q.set('location', location);
      q.set('days', '7');
      return `https://www.ziprecruiter.com/jobs-search?${q}`;
  }
}

/** A default name for a search: its keywords and place, read from the address. */
export function searchLabel(raw: string): string {
  const u = new URL(raw.trim());
  const site = searchSiteOf(raw);
  const p = u.searchParams;
  const what = p.get('keywords') ?? p.get('q') ?? p.get('search') ?? p.get('sc.keyword') ?? null;
  const where = p.get('location') ?? p.get('l') ?? null;
  // Glassdoor keeps the search in the path: /Job/san-francisco-ca-technical-program-manager-jobs-SRCH…
  const glass = site === 'glassdoor' ? u.pathname.match(/\/Job\/(.+?)-jobs-SRCH/i)?.[1] : null;
  const words =
    [what, where && `in ${where}`].filter(Boolean).join(' ') || glass?.replace(/-/g, ' ');
  return `${site ? SEARCH_SITE_LABEL[site] : 'Search'}: ${words || u.pathname}`;
}

/** One listing as the extension read it from a results page. */
export const listingSchema = z.object({
  url: z.string().trim().url().max(2000),
  /** Null when the card hadn't rendered (LinkedIn); the server then reads the posting. */
  title: z.string().trim().max(300).nullable().optional(),
  company: z.string().trim().max(200).nullable().optional(),
  location: z.string().trim().max(300).nullable().optional(),
  /** Pay as the page words it: "$150K - $250K/yr", "$35/hr", "(Glassdoor est.)". */
  pay: z.string().trim().max(200).nullable().optional(),
  /** A line or two of the description, when the results page shows one. */
  snippet: z.string().trim().max(2000).nullable().optional(),
});
export type SearchListing = z.infer<typeof listingSchema>;

export const searchResultsSchema = z.object({
  listings: z.array(listingSchema).max(500).default([]),
  /** Why the page couldn't be read: a robot check, signed out, an unknown layout. */
  problem: z.string().trim().max(500).nullable().optional(),
});

/** "San Francisco, CA (Hybrid)" / "San Francisco, CA · On-site" → the place, and how. */
function place(raw: string | null | undefined) {
  const text = raw?.replace(/\s+/g, ' ').trim() || null;
  if (!text) return { location: null, remoteType: null };
  const how = text.match(/\((remote|hybrid|on-?site)\)|·\s*(remote|hybrid|on-?site)\b/i);
  const location =
    text
      .replace(/\s*\((remote|hybrid|on-?site)\)\s*/i, ' ')
      .replace(/\s*·\s*(remote|hybrid|on-?site)\b/i, '')
      .trim() || null;
  return { location, remoteType: remoteFrom(how?.[1] ?? how?.[2] ?? text) };
}

/**
 * Pay from a listing. Hourly pay is flagged (the rules filter it). A site's own estimate
 * ("Glassdoor est.") isn't the employer's range, so it is ignored.
 */
function pay(raw: string | null | undefined) {
  const text = raw?.trim() ?? '';
  if (!text || /\best(imate|\.)?\b/i.test(text)) return { min: null, max: null, hourly: false };
  if (/\/\s*h(ou)?r\b|an hour|per hour|hourly/i.test(text))
    return { min: null, max: null, hourly: true };
  const r = parseSalaryRange(text.replace(/\/\s*yr\b/gi, '/year'));
  if (r) return { ...r, hourly: false };
  // "Up to $250K/yr", "$180K/yr": one figure.
  const one = text.match(/\$\s?(\d{2,3}(?:\.\d+)?)\s?[kK]\b|\$\s?(\d{2,3}(?:,\d{3})+)/);
  const n = one
    ? one[1]
      ? Math.round(parseFloat(one[1]) * 1000)
      : Number(one[2]!.replace(/,/g, ''))
    : null;
  if (n && n >= 40_000 && n <= 2_000_000)
    return /up to/i.test(text)
      ? { min: null, max: n, hourly: false }
      : { min: n, max: n, hourly: false };
  return { min: null, max: null, hourly: false };
}

/** A listing in the shape the rules and the pre-screen take; null if its address is unusable. */
export function listingToJob(l: SearchListing): FoundJob | null {
  if (!l.title) return null;
  let url: string;
  try {
    url = normalizeUrl(l.url);
  } catch {
    return null;
  }
  const { location, remoteType } = place(l.location);
  const p = pay(l.pay);
  return {
    url,
    title: l.title.replace(/\s+with verification$/i, '').trim(),
    company: l.company?.trim() || 'Unknown',
    location,
    remoteType,
    salaryMin: p.min,
    salaryMax: p.max,
    hourly: p.hourly,
    employmentType: /\bcontract\b/i.test(`${l.title} ${l.pay ?? ''}`) ? 'Contract' : null,
    postedAt: null,
    descriptionText: null,
    snippet: l.snippet ?? null,
  };
}
