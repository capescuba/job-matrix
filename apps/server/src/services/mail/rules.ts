/**
 * Free, rule-based reading of job emails: is it about an application, what kind of update is it,
 * and which company / job is it about. Built from what real ATS and company emails look like.
 */
import { CLOSED_STATUSES, type ActivityKind, type Status } from '@jm/shared';
import type { MailMeta } from '@jm/mail';
import type { Db } from '../../db/client.ts';
import { companies } from '../../db/schema.ts';
import { allAliases } from '../aliases.ts';
import { listApplications } from '../applications.ts';
import { SHARED_HOSTS, companyKey, titleOverlap } from '../extension.ts';

export const EMAIL_KINDS = [
  'confirmation',
  'rejection',
  'interview',
  'action',
  'offer',
  'viewed',
  'unclear',
] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

// ---------- is it about an application? ----------

/** Applicant-tracking systems that send application mail on companies' behalf. */
const ATS =
  /(^|\.)(greenhouse-mail\.io|greenhouse\.io|lever\.co|ashbyhq\.com|myworkday\.com|workday\.com|icims\.com|smartrecruiters\.com|jobvite\.com|taleo\.net|successfactors\.(com|eu)|workablemail\.com|workable\.com|bamboohr\.com|recruitee\.com|breezy\.hr|applytojob\.com|avature\.net|eightfold\.ai|phenompeople\.com|oraclecloud\.com|rippling\.com|gem\.com|dover\.com|paradox\.ai|teamtailor\.com|pinpointhq\.com|jazzhr\.com|indeedapply\.com)$/i;

/** Senders that never report on an application: alerts, digests, social, promos. */
const NOISE_SENDER =
  /^(jobalerts-noreply|jobs-listings|messages-noreply|notifications-noreply|invitations|messaging-digest-noreply|newsletters-noreply|updates-noreply|inmail-hit-reply|hit-reply|career-interests-noreply|security-noreply|billing-noreply|editors-noreply)@linkedin\.com$|@(match\.indeed\.com|us\.greenhouse-jobs\.com|greenhouse-jobs\.com|ziprecruiter\.com|glassdoor\.com|mypoints\.com)$/i;

const NOISE_SUBJECT =
  /\b(apply now to|looking for a new job|job alert|jobs? for you|new jobs|recommended jobs|jobs similar|is hiring|are hiring|dream job|security code|verification code|password|viewed your profile|referred you|been referred|salary at|insights:|people viewed|newsletter|webinar)\b/i;

/** LinkedIn's jobs-noreply mixes nudges with real application receipts. */
const LINKEDIN_RECEIPT = /your application was (sent|viewed)/i;

const APPLICATION_WORDS =
  /\b(appl(y|ied|ying|ication)|candida(cy|te)|interview|position|role|recruit(er|ing)|hiring team|talent acquisition|your interest)\b/i;

export const FREE_MAIL =
  /(^|\.)(gmail|hotmail|outlook|live|yahoo|icloud|aol|proton(mail)?)\.[a-z.]+$/i;

const domainOf = (addr: string | null) => addr?.split('@')[1]?.toLowerCase() ?? '';
/** "talent.icims.com" → "icims.com"; "mail.box.com" → "box.com". */
export function rootDomain(host: string): string {
  const parts = host
    .toLowerCase()
    .replace(/^www\./, '')
    .split('.')
    .filter(Boolean);
  const twoLevelTld = /^(co|com|org|net|ac|gov)\.[a-z]{2}$/.test(parts.slice(-2).join('.'));
  return parts.slice(twoLevelTld ? -3 : -2).join('.');
}

export interface MatchContext {
  /** Tracked companies by their names and aliases (an alias entry carries the company's own name). */
  companies: { id: number; name: string; key: string; compact: string }[];
  apps: {
    id: number;
    companyId: number;
    title: string;
    status: Status;
    appliedAt: string | null;
  }[];
  /** Company websites and job-page hosts (root domains) → company id. */
  domains: Map<string, number>;
}

const compact = (s: string) => companyKey(s).replace(/ /g, '');

export function buildMatchContext(db: Db): MatchContext {
  const rows = listApplications(db);
  const all = db
    .select({ id: companies.id, name: companies.name, website: companies.website })
    .from(companies)
    .all();
  const domains = new Map<string, number>();
  const learn = (url: string | null | undefined, companyId: number) => {
    try {
      const host = url ? new URL(url).hostname : '';
      if (host && !SHARED_HOSTS.test(host) && !ATS.test(host)) {
        const root = rootDomain(host);
        if (!domains.has(root)) domains.set(root, companyId);
        else if (domains.get(root) !== companyId) domains.set(root, -1); // ambiguous
      }
    } catch {
      // not a URL
    }
  };
  for (const c of all) learn(c.website, c.id);
  for (const r of rows) learn(r.url, r.companyId);
  for (const [k, v] of domains) if (v === -1) domains.delete(k);
  return {
    companies: [
      ...all.map((c) => ({
        id: c.id,
        name: c.name,
        key: companyKey(c.name),
        compact: compact(c.name),
      })),
      ...allAliases(db).flatMap((a) => {
        const c = all.find((x) => x.id === a.companyId);
        return c ? [{ id: c.id, name: c.name, key: a.key, compact: a.key.replace(/ /g, '') }] : [];
      }),
    ].filter((c) => c.compact.length >= 2),
    apps: rows.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      title: r.title,
      status: r.status,
      appliedAt: r.appliedAt,
    })),
    domains,
  };
}

/** Tracked companies named in the text as a whole word/phrase. */
function companiesNamedIn(text: string, ctx: MatchContext) {
  const t = ` ${companyKey(text)} `;
  return ctx.companies.filter((c) => c.key.length >= 3 && t.includes(` ${c.key} `));
}

/** Worth reading the body? Cheap: sender, subject and preview only. */
export function isCandidate(meta: MailMeta, ctx: MatchContext): boolean {
  const addr = meta.from.address ?? '';
  const domain = domainOf(addr);
  const subject = meta.subject ?? '';
  if (NOISE_SENDER.test(addr)) return false;
  if (/^jobs-noreply@linkedin\.com$/i.test(addr)) return LINKEDIN_RECEIPT.test(subject);
  if (NOISE_SUBJECT.test(subject)) return false;
  if (ATS.test(domain)) return true;
  const root = rootDomain(domain);
  if (ctx.domains.has(root) && APPLICATION_WORDS.test(`${subject} ${meta.preview}`)) return true;
  if (
    !FREE_MAIL.test(domain) &&
    ctx.companies.some((c) => c.compact.length >= 3 && compact(root.split('.')[0]!) === c.compact)
  )
    return APPLICATION_WORDS.test(`${subject} ${meta.preview}`);
  // A company-looking sender or subject that talks about an application.
  return (
    /\b(thank(s| you) for (applying|your application|your interest)|your application|application (received|status|update)|received your application)\b/i.test(
      subject,
    ) ||
    (companiesNamedIn(`${subject} ${meta.from.name ?? ''}`, ctx).length > 0 &&
      APPLICATION_WORDS.test(`${subject} ${meta.preview}`))
  );
}

// ---------- what kind of update ----------

const RULES: { kind: EmailKind; strong?: boolean; re: RegExp }[] = [
  {
    kind: 'rejection',
    re: /\b(not (to )?(move|moving) forward|decided to (move|go|proceed) forward with (other|another)|(move|moving) forward with (other|another) (candidate|applicant)s?|pursue other candidates|other candidates (whose|who)|(have|has) not been selected|not selected (to|for)|won[’']?t be (moving|proceeding)|will not be (moving|proceeding)|decided not to proceed|position has been filled|no longer (under consideration|being considered)|regret to inform|not a (fit|match) (for this|at this time))/i,
  },
  {
    kind: 'offer',
    re: /\b(pleased to (extend|offer)|offer letter|extend (you )?an offer|verbal offer|offer of employment)\b/i,
  },
  {
    kind: 'action',
    re: /\b(online assessment|coding (assessment|challenge|exercise)|take[- ]home|hackerrank|codesignal|codility|complete (the|an|this|your) (assessment|form|questionnaire)|pre-?screen(ing)? (form|questionnaire)|additional information (needed|required|request))/i,
  },
  {
    kind: 'interview',
    strong: true,
    re: /(calendly\.com\/|goodtime\.io\/|\byour availability|share (your|some) availability|invite you to (an? )?(interview|call|speak|chat|meet)|(like|love) to (schedule|set up) (a|an|some)|interview (invitation|invite|request)|schedule (your|an|the) interview)/i,
  },
  {
    kind: 'interview',
    re: /\b(schedule (a|an|some) (call|chat|conversation|time|phone screen)|phone screen|recruiter screen|next round|speak with you (about|further))/i,
  },
  {
    kind: 'confirmation',
    re: /\b(thank(s| you) for (applying|your application|your interest|submitting)|received your application|application (has been |was |is )?(received|submitted)|we[’']?ve received|we have received|your application was sent|successfully (applied|submitted))/i,
  },
  { kind: 'viewed', re: /\b(application was viewed|viewed your application)\b/i },
  // Last: "unfortunately" near "application" without a clearer rejection phrase.
  {
    kind: 'rejection',
    re: /\bunfortunately\b[^.!?\n]{0,160}\b(application|position|role|candidacy)\b/i,
  },
];

/** The sentence around a match, trimmed. */
function sentenceAround(text: string, index: number): string {
  const start = Math.max(
    text.lastIndexOf('.', index - 1),
    text.lastIndexOf('!', index - 1),
    text.lastIndexOf('?', index - 1),
    text.lastIndexOf('\n', index - 1),
  );
  const ends = ['.', '!', '?', '\n'].map((c) => text.indexOf(c, index)).filter((i) => i >= 0);
  const end = ends.length ? Math.min(...ends) + 1 : text.length;
  const s = text
    .slice(start + 1, end)
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 300 ? `${s.slice(0, 297)}…` : s;
}

/** "If you are not selected…", "Should we decide to move forward…": a condition, not news. */
function isConditional(text: string, index: number): boolean {
  const start = Math.max(...['.', '!', '?', '\n'].map((c) => text.lastIndexOf(c, index - 1)));
  return /\b(if|should|in case|in the event|unless|whether|once)\b/i.test(
    text.slice(start + 1, index),
  );
}

/** The first match that isn't inside a condition. */
function firstReal(re: RegExp, text: string): RegExpExecArray | null {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of text.matchAll(g)) if (!isConditional(text, m.index)) return m as RegExpExecArray;
  return null;
}

export function classify(
  subject: string,
  body: string,
): { kind: EmailKind; confidence: 'high' | 'medium' | 'low'; evidence: string | null } {
  const text = `${subject}\n${body}`;
  const hits = RULES.map((r) => ({ ...r, m: firstReal(r.re, text) })).filter((h) => h.m);
  const first = (kind: EmailKind, strong?: boolean) =>
    hits.find((h) => h.kind === kind && (strong === undefined || Boolean(h.strong) === strong));
  // A confirmation often says "a recruiter will reach out to schedule a call": only a strong
  // interview signal (a scheduling link, "your availability") beats it.
  const confirmation = first('confirmation');
  const pick =
    first('rejection') ??
    first('offer') ??
    first('action') ??
    first('interview', true) ??
    (confirmation ? confirmation : first('interview')) ??
    first('viewed');
  if (!pick) return { kind: 'unclear', confidence: 'low', evidence: null };
  const weakRejection = pick.kind === 'rejection' && /unfortunately/i.test(pick.m![0]);
  return {
    kind: pick.kind,
    confidence: weakRejection ? 'medium' : 'high',
    evidence: sentenceAround(text, pick.m!.index),
  };
}

// ---------- which company and job ----------

const GENERIC_NAME =
  /^(no[-_ ]?reply|do[-_ ]?not[-_ ]?reply|noreply|notifications?|hello|info|careers?|jobs|recruiting|talent|hr|team|linkedin|indeed|greenhouse|workday|lever|ashby|icims|smartrecruiters|mygreenhouse)$/i;

/** "Box Recruiting", "The Plaid Team", "GitHub, Inc. @ icims", "do-not-reply adobe" → the company. */
export function companyFromSenderName(name: string | null): string | null {
  if (!name || /\S+@\S+\.\S+/.test(name)) return null;
  let n = name
    .replace(/\s*@\s*\w+$/i, '') // "GitHub, Inc. @ icims"
    .replace(/\s+via\s+\w+$/i, '')
    .replace(/^(the\s+)?(recruiting|talent|hiring|careers?)\s+team\s+at\s+/i, '')
    .replace(/^(do[-_ ]?not[-_ ]?reply|no[-_ ]?reply)\s+/i, '')
    .replace(/^the\s+/i, '')
    .replace(
      /\s+(hiring team|recruiting( team)?|talent acquisition( team)?|talent( team)?|people team|people|careers?|jobs|hr|team)$/i,
      '',
    )
    .trim();
  if (!n || GENERIC_NAME.test(n) || n.split(/\s+/).length > 5) return null;
  return n;
}

const SUBJECT_COMPANY: RegExp[] = [
  /\bthank(?:s| you) for (?:applying|your application|your interest)(?: (?:to|at|in|with))?(?: joining)? (?:the )?(.+?)(?:[!.,:|]|$)/i,
  /\b(?:application|position|role|opportunity) (?:for .+? )?at (.+?)(?:[!.,:|]|$)/i,
  /\byour (?:application (?:to|at|with)|interest in) (.+?)(?:[!.,:|]|$)/i,
  /\byour application was (?:sent|viewed)(?: to| by)? (.+?)(?:[!.,:|]|$)/i,
  /\bon your (.+?) application\b/i,
  /^(.+?)\s+(?:-|–|—)?\s*(?:application (?:status|update|received)|follow-up|recruiting|interview)\b/i,
  /^(.+?)\s*\|\s*/,
];

const TITLE_PATTERNS: RegExp[] = [
  /\bapplication for (?:the )?(.+?)\s+(?:position |role )?at\s+/i,
  /\bappl(?:ying|ication|ied) (?:to|for) the (.+?)\s+(?:role|position|opening|job)\b/i,
  /\bfor the (.+?)\s+(?:role|position|opening)\b/i,
  /\b(?:to|for) the (.+?) position\b/i,
  /\bfollow-up for (.+?)(?:\s*\||$)/i,
  /\bposition of (.+?)[.,\n]/i,
  /\binterest in (?:the|our) (.+?)\s+(?:role|position|opening)\b/i,
  /\bapplication for (?:the )?(.+?)(?:\s+(?:position|role))?\s*[.!\n]/i,
];

export function titleFrom(subject: string, body: string): string | null {
  for (const text of [subject, body.slice(0, 1500)]) {
    for (const re of TITLE_PATTERNS) {
      const t = re.exec(text)?.[1]?.replace(/\s+/g, ' ').trim();
      if (t && t.length >= 3 && t.length <= 120 && !/\byour\b|\bthis\b/i.test(t)) return t;
    }
  }
  return null;
}

/** Company names the email gives, most specific first. */
export function companyNamesFrom(meta: MailMeta, body: string): string[] {
  const out: string[] = [];
  const add = (s: string | null | undefined) => {
    const v = s
      ?.replace(/\s+/g, ' ')
      .replace(/^(the|joining)\s+/i, '')
      .trim();
    if (v && v.length >= 2 && v.length <= 60 && !out.includes(v)) out.push(v);
  };
  for (const re of SUBJECT_COMPANY) add(re.exec(meta.subject)?.[1]);
  add(companyFromSenderName(meta.from.name));
  for (const re of SUBJECT_COMPANY.slice(0, 3)) add(re.exec(body.slice(0, 1500))?.[1]);
  return out;
}

/** Candidate strings from addresses: "githubinc+autoreply@talent.icims.com" → "githubinc". */
function companyHintsFromAddresses(meta: MailMeta): string[] {
  const hints: string[] = [];
  for (const a of [meta.from, ...meta.replyTo]) {
    const addr = a.address ?? '';
    const [local = '', domain = ''] = addr.split('@');
    if (ATS.test(domain)) {
      const l = local
        .split('+')[0]!
        .replace(
          /[-_.]?(no-?reply|autoreply|donotreply|do-not-reply|recruiting|careers|jobs)$/i,
          '',
        );
      if (
        l &&
        !GENERIC_NAME.test(l) &&
        !/^(no-?reply|notification|notifications|do-?not-?reply)$/i.test(l)
      )
        hints.push(l);
    } else if (domain && !FREE_MAIL.test(domain)) {
      hints.push(rootDomain(domain).split('.')[0]!);
    }
  }
  return hints;
}

export interface Match {
  companyName: string | null;
  jobTitle: string | null;
  companyId: number | null;
  applicationId: number | null;
  /** title-only: no company matched, but exactly one tracked job has this title — check it. */
  matchedBy: 'title' | 'only' | 'only-open' | 'title-only' | null;
}

/** A job title close enough to count as the same role when nothing else links them. */
const SAME_TITLE = 0.85;

/** Which of a company's applications the email is about, if that can be told. */
export function pickApplication(
  ctx: MatchContext,
  companyId: number,
  jobTitle: string | null,
): Pick<Match, 'applicationId' | 'matchedBy'> {
  const apps = ctx.apps.filter((a) => a.companyId === companyId);
  if (jobTitle && apps.length) {
    const scored = apps
      .map((a) => ({ a, s: titleOverlap(a.title, jobTitle) }))
      .sort((x, y) => y.s - x.s);
    if (scored[0]!.s >= 0.5 && (scored.length === 1 || scored[0]!.s > scored[1]!.s))
      return { applicationId: scored[0]!.a.id, matchedBy: 'title' };
  }
  if (apps.length === 1) return { applicationId: apps[0]!.id, matchedBy: 'only' };
  const open = apps.filter((a) => !CLOSED_STATUSES.includes(a.status) && a.status !== 'Passed');
  if (open.length === 1) return { applicationId: open[0]!.id, matchedBy: 'only-open' };
  return { applicationId: null, matchedBy: null };
}

/** Which tracked company, then which of its applications, the email is about. */
export function matchApplication(meta: MailMeta, body: string, ctx: MatchContext): Match {
  const names = companyNamesFrom(meta, body);
  const jobTitle = titleFrom(meta.subject, body);
  const byKey = (n: string) => {
    const k = companyKey(n);
    const c = compact(n);
    return ctx.companies.find((co) => co.key === k || co.compact === c);
  };
  let company = names.map(byKey).find(Boolean);
  if (!company) {
    // Addresses: exact company, a known domain, or "githubinc" for GitHub.
    for (const h of companyHintsFromAddresses(meta)) {
      const c = compact(h);
      company =
        ctx.companies.find((co) => co.compact === c) ??
        ctx.companies.find((co) => co.compact.length >= 4 && c.startsWith(co.compact));
      if (company) break;
    }
  }
  if (!company) {
    const id = [meta.from, ...meta.replyTo]
      .map((a) => ctx.domains.get(rootDomain(domainOf(a.address))))
      .find((v) => v != null);
    company = ctx.companies.find((c) => c.id === id);
  }
  if (!company) {
    // A tracked company named in the subject.
    company = companiesNamedIn(meta.subject, ctx)[0];
  }
  if (!company) {
    // Renamed or acquired companies (e.g. an email from "SpaceXAI" about a job you track at
    // Cursor): the same job title at exactly one tracked job is a possible match to confirm.
    if (jobTitle) {
      const scored = ctx.apps
        .map((a) => ({ a, s: titleOverlap(a.title, jobTitle) }))
        .filter((x) => x.s >= SAME_TITLE)
        .sort((x, y) => y.s - x.s);
      if (scored.length && (scored.length === 1 || scored[0]!.s > scored[1]!.s))
        return {
          companyName: names[0] ?? null,
          jobTitle,
          companyId: scored[0]!.a.companyId,
          applicationId: scored[0]!.a.id,
          matchedBy: 'title-only',
        };
    }
    return {
      companyName: names[0] ?? null,
      jobTitle,
      companyId: null,
      applicationId: null,
      matchedBy: null,
    };
  }
  return {
    companyName: company.name,
    jobTitle,
    companyId: company.id,
    ...pickApplication(ctx, company.id, jobTitle),
  };
}

// ---------- what to suggest ----------

const STAGE: Partial<Record<Status, number>> = {
  Screening: 0,
  Saved: 0,
  Applied: 1,
  // Hearing back means it wasn't ghosting after all.
  Ghosted: 1,
  'Recruiter Screen': 2,
  'Hiring Manager': 3,
  'Interview Loop': 4,
  Offer: 5,
};

export interface Suggestion {
  /** New status, or null to only log the email. */
  status: Status | null;
  nextAction: string | null;
  /** Timeline entry kind when applied. */
  activityKind: ActivityKind;
  /** Nothing would change (e.g. a receipt for a job already marked Applied with its date). */
  noop: boolean;
}

export function activityKindFor(kind: EmailKind): ActivityKind {
  return kind === 'confirmation'
    ? 'Applied'
    : kind === 'interview'
      ? 'Interview'
      : kind === 'viewed' || kind === 'unclear'
        ? 'Note'
        : 'Response';
}

/** What the email should change, never moving a job backwards or reopening a closed one. */
export function suggest(
  app: { status: Status; appliedAt: string | null } | null,
  kind: EmailKind,
): Suggestion {
  const activityKind = activityKindFor(kind);
  const none = { status: null, nextAction: null, activityKind, noop: false };
  if (!app) return none;
  const closed = !(app.status in STAGE); // Rejected, Withdrawn, Passed
  const stage = STAGE[app.status] ?? -1;
  switch (kind) {
    case 'confirmation':
      if (stage === 0) return { ...none, status: 'Applied' };
      return { ...none, noop: Boolean(app.appliedAt) };
    case 'rejection':
      if (app.status === 'Rejected') return { ...none, noop: true };
      if (app.status === 'Withdrawn' || app.status === 'Passed') return none;
      return { ...none, status: 'Rejected' };
    case 'interview':
      if (closed) return none;
      return {
        ...none,
        status: stage < 2 ? 'Recruiter Screen' : null,
        nextAction: 'Reply to the scheduling email',
      };
    case 'action':
      return closed ? none : { ...none, nextAction: 'Do what the email asks (form or assessment)' };
    case 'offer':
      return closed || app.status === 'Offer' ? none : { ...none, status: 'Offer' };
    default:
      return none;
  }
}
