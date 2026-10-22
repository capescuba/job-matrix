/**
 * Which job and which company a page is about, without AI. Every source that names them — a
 * site template, the server's read of the posting, the page's structured data, the tab title,
 * the address — offers a candidate. Each is tidied (Workday's "2100 NVIDIA USA" → "NVIDIA",
 * "… - Jobs - Careers at Apple" → the title alone) and dropped when it can't be one (pay text,
 * "Careers", a site's own name), and a company you already track wins over a new spelling of it.
 * Capturing a job and the side panel both decide here, so they agree.
 */
import { looksLikeCompanyName, shortField } from '@jm/shared';
import type { Db } from '../db/client.ts';
import { companies, companyAliases } from '../db/schema.ts';
import { decodeEntities, type FetchedJob } from './jobfetch.ts';

/** "DocuSign, Inc." and "Docusign" → "docusign". */
export function companyKey(name: string | null | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(
      /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|ag|sa)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/** The same company under a longer or legal name: "Cisco Systems" and "Cisco", "Valon Tech" and "Valon". */
export function sameCompany(a: string | null | undefined, b: string | null | undefined) {
  const x = companyKey(a);
  const y = companyKey(b);
  return Boolean(x && y && (x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `)));
}

// ---------- from the tab title and the address ----------

const SITE_SUFFIX =
  /\s*[|–—-]\s*(LinkedIn|Indeed(\.com)?|Glassdoor|Greenhouse|Lever|Workday|Careers?)\s*$/i;

/** Best-effort title/company from a browser tab title. */
export function parsePageTitle(pageTitle: string | null | undefined): {
  title: string | null;
  company: string | null;
} {
  let t = decodeEntities(pageTitle ?? '')
    .replace(/^\(\d+\)\s*/, '') // "(3) " notification count
    .replace(/\s*[-–—(|]?\s*(?:Job|Req(?:uisition)?)\s*(?:ID|#)\s*:?\s*[\w-]+\)?/i, '') // "- Job ID: 10562876"
    .replace(/\b([A-Z][\w&-]*)\.(?:jobs|careers)\b/, '$1') // "Amazon.jobs" → "Amazon"
    .trim();
  if (!t) return { title: null, company: null };
  let m = t.match(/^(.+?) hiring (.+?)(?: in .+?)?(?:\s*\|\s*LinkedIn)?$/i); // "Acme hiring TPM in SF | LinkedIn"
  if (m) return { company: m[1].trim(), title: m[2].trim() };
  m = t.match(/^Job Application for (.+?) at (.+)$/i); // Greenhouse
  if (m) return { title: m[1].trim(), company: m[2].trim() };
  m = t.match(/^(.+?)\s+[|–—-]\s+(.+?)\s+(?:Careers?|Jobs)$/i); // "TPM - Walmart Careers"
  if (m) return { title: m[1].trim(), company: m[2].trim() };
  // LinkedIn sometimes says it twice: "TPM | LinkedIn | LinkedIn".
  while (SITE_SUFFIX.test(t)) t = t.replace(SITE_SUFFIX, '').trim();
  m = t.match(/^(.+?) at (.+)$/); // "TPM at Acme"
  if (m) return { title: m[1].trim(), company: m[2].trim() };
  // "TPM | Acme", but not a "|" inside the title: "TPM, Core AI (Mountain View, CA | New York, NY)".
  const parts = t.split(/\s+[|]\s+(?![^(]*\))/);
  if (parts.length >= 2) return { title: parts[0].trim(), company: parts[1].trim() };
  return { title: t, company: null };
}

/**
 * Hosts that serve many companies' jobs — a hostname there says nothing about the company.
 * Oracle Recruiting Cloud names its customers by a code (ehac.fa.us6.oraclecloud.com is
 * Williams-Sonoma), so neither "oraclecloud" nor the subdomain is the employer.
 */
export const SHARED_HOSTS =
  /(^|\.)(linkedin\.com|indeed\.com|glassdoor\.com|greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|workable\.com|wellfound\.com|builtin\.com|ziprecruiter\.com|google\.com|dice\.com|monster\.com|simplyhired\.com|otta\.com|welcometothejungle\.com|myworkdayjobs\.com|oraclecloud\.com)$/i;

/** Job platforms where each company gets its own subdomain: githubinc.icims.com, iren.careers.hibob.com. */
const TENANT_HOSTS =
  /(^|\.)(icims\.com|eightfold\.ai|avature\.net|taleo\.net|jobvite\.com|bamboohr\.com|recruitee\.com|breezy\.hr|applytojob\.com|teamtailor\.com|pinpointhq\.com|rippling\.com|hibob\.com|successfactors\.(com|eu))$/i;

/** Words careers sites put around the company's name in their address. */
const HOST_WORDS =
  /^(careers?|jobs?|apply|hiring|recruiting|talent|work|join|www\d*|en|us|global|external)$/i;

/**
 * Company from a careers site's own address: careers.oracle.com → "Oracle",
 * jobs.netflix.com → "Netflix", metacareers.com → "Meta", careers-githubinc.icims.com →
 * "Githubinc", x.company → "X". Null on shared job boards (LinkedIn, Greenhouse, …).
 */
export function companyFromHost(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (SHARED_HOSTS.test(host)) return null;
  const labels = host.split('.');
  const twoLevelTld = /^(co|com|org|net|ac|gov)\.[a-z]{2}$/.test(labels.slice(-2).join('.'));
  let name = TENANT_HOSTS.test(host)
    ? labels.length > 2
      ? labels[0]!
      : ''
    : (labels.at(twoLevelTld ? -3 : -2) ?? '');
  name = name.replace(/^(careers?|jobs?)[-_]/i, '').replace(/[-_]?(careers?|jobs?)$/i, '');
  if (!name || HOST_WORDS.test(name)) return null;
  return name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Company from an ATS board slug, e.g. jobs.ashbyhq.com/haydenai → "Haydenai". */
export function companyFromBoardUrl(url: string): string | null {
  const u = new URL(url);
  const h = u.hostname;
  const slug =
    h.endsWith('greenhouse.io') || h === 'jobs.lever.co' || h === 'jobs.ashbyhq.com'
      ? u.pathname.split('/')[1]
      : h.endsWith('myworkdayjobs.com')
        ? h.split('.')[0]
        : null;
  if (!slug) return null;
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------- tidying and checking a candidate ----------

const LEGAL_SUFFIX =
  /[\s,]+(Inc|Incorporated|LLC|L\.L\.C|Ltd|Limited|Corp|Corporation|Co|plc|GmbH|AG|S\.A)\.?$/i;
const COUNTRY_SUFFIX = /(?<!\bof)[\s,]+(U\.?S\.?A?\.?|United States|America)$/i;

/** Names that are a site, a platform or pay, not an employer. */
const NOT_AN_EMPLOYER =
  /\$|^[\d\s,.kK-]+$|candidate experience|career site|careers? (page|portal|site)|job (board|portal)|^(unknown|oraclecloud|myworkdayjobs|workday jobs|icims|eightfold|hibob)$/i;

/**
 * A company name as a source gave it, tidied — or null when it can't be one. Workday names the
 * legal entity behind a code ("2100 NVIDIA USA", "110 Visa U.S.A. Inc."); Oracle Recruiting's
 * default site name is "<Company> Candidate Experience page".
 */
export function cleanCompany(raw: string | null | undefined): string | null {
  let s = shortField(decodeEntities(raw ?? ''), 200);
  if (!s) return null;
  s = s.replace(/\s+Candidate Experience( page| site)?$/i, '');
  // Only a code before a legal name: "84 Lumber" and "3M" keep their numbers.
  const code = s.match(/^\d{3,5}\s+(?=[A-Za-z])/)?.[0];
  if (code && (LEGAL_SUFFIX.test(s) || COUNTRY_SUFFIX.test(s))) {
    s = s.slice(code.length).replace(LEGAL_SUFFIX, '').replace(COUNTRY_SUFFIX, '');
    s = s.replace(LEGAL_SUFFIX, '');
  }
  s = s.replace(/[\s,]+$/, '');
  return looksLikeCompanyName(s) && !NOT_AN_EMPLOYER.test(s) ? s : null;
}

/** Page and section names that land where a job title should be. */
const NOT_A_TITLE =
  /^(careers?|jobs?|job (details|search|description|posting)|search( results)?|home|apply( now)?|open (positions|roles)|current openings)$|candidate experience|careers? page/i;
/** Pay text a template picked instead of the title: "$200K/yr - $375K/yr". */
const PAY = /^\s*\$|\/\s*(yr|year|hr|hour)\b|\bper (year|hour)\b/i;

/**
 * A job title as a source gave it, tidied — or null when it can't be one. Careers sites append
 * themselves ("… - Jobs - Careers"), Ashby titles can carry "@ Company", and a site's own name
 * ("Stanford") or pay text is no title.
 */
export function cleanTitle(raw: string | null | undefined, company?: string | null): string | null {
  let t = shortField(decodeEntities(raw ?? ''), 300);
  if (!t) return null;
  t = t
    .replace(/(\s*[-–—|]\s*(Jobs|Careers?|Job Details))+(\s+at\s+.+)?$/i, '')
    .replace(/\s+@\s+[^@]+$/, '');
  const tail = t.match(/\s+(?:at|[-–—|])\s+([^-–—|]+)$/);
  // Only the company itself, not a team named after it ("TPM - Visa Direct").
  if (tail && company && companyKey(tail[1]) === companyKey(company)) t = t.slice(0, tail.index);
  t = t.trim();
  if (t.length < 3 || t.length > 200 || !/[a-z]/i.test(t)) return null;
  if (NOT_A_TITLE.test(t) || PAY.test(t)) return null;
  if (company && companyKey(t) === companyKey(company)) return null;
  return t;
}

// ---------- deciding ----------

export interface KnownCompany {
  id: number;
  name: string;
}
export type FindCompany = (name: string | null | undefined) => KnownCompany | undefined;

/** Looks a name up among the companies you track: their own names, then their aliases. */
export function companyFinder(db: Db): FindCompany {
  const all = db.select({ id: companies.id, name: companies.name }).from(companies).all();
  const aliases = db
    .select({ companyId: companyAliases.companyId, key: companyAliases.aliasKey })
    .from(companyAliases)
    .all();
  return (name) => {
    const k = companyKey(name);
    if (!k) return undefined;
    const aliasOf = aliases.find((a) => a.key === k)?.companyId;
    return all.find((c) => companyKey(c.name) === k) ?? all.find((c) => c.id === aliasOf);
  };
}

export interface IdentitySources {
  url: string;
  /** A site template's picks (what you're looking at). */
  template?: { title?: string | null; company?: string | null } | null;
  /** The server's own read of the posting (ATS API, page data). */
  fetched?: Pick<FetchedJob, 'title' | 'company' | 'pageTitle'> | null;
  /** schema.org JobPosting from the page. */
  ld?: { title?: string; hiringOrganization?: string | { name?: string } } | null;
  /** The browser's tab title. */
  pageTitle?: string | null;
}

export interface Identity {
  title: string | null;
  company: string | null;
  /** The tracked company it is, when it's one. */
  known: KnownCompany | null;
  /** Whether a source names the company, rather than the address or tab title suggesting it. */
  stated: boolean;
}

/**
 * Title and company from every source, in one order: template, the server's read, structured
 * data, then what the tab title and address suggest. A company named by a source wins over one
 * only suggested; among those, one you already track wins, and so does a tracked company the
 * address agrees with ("Cisco Systems" on cisco.wd5.myworkdayjobs.com → your "Cisco").
 */
export function resolveIdentity(
  src: IdentitySources,
  find: FindCompany = () => undefined,
): Identity {
  const org = src.ld?.hiringOrganization;
  const stated = [
    src.template?.company,
    src.fetched?.company,
    typeof org === 'string' ? org : org?.name,
  ]
    .map(cleanCompany)
    .filter((c): c is string => !!c);
  const fromTitles = [src.pageTitle, src.fetched?.pageTitle].map(parsePageTitle);
  const guessed = [
    ...fromTitles.map((t) => t.company),
    companyFromBoardUrl(src.url),
    companyFromHost(src.url),
  ]
    .map(cleanCompany)
    .filter((c): c is string => !!c);

  const pick = (): Omit<Identity, 'title'> => {
    for (const c of stated) {
      const k = find(c);
      if (k) return { company: k.name, known: k, stated: true };
    }
    if (stated.length) {
      for (const g of guessed) {
        const k = sameCompany(stated[0], g) ? find(g) : undefined;
        if (k) return { company: k.name, known: k, stated: true };
      }
      return { company: stated[0]!, known: null, stated: true };
    }
    for (const g of guessed) {
      const k = find(g);
      if (k) return { company: k.name, known: k, stated: false };
    }
    return { company: guessed[0] ?? null, known: null, stated: false };
  };
  const who = pick();

  const title =
    [src.template?.title, src.fetched?.title, src.ld?.title, ...fromTitles.map((t) => t.title)]
      .map((t) => cleanTitle(t, who.company))
      .find(Boolean) ?? null;
  return { ...who, title };
}
