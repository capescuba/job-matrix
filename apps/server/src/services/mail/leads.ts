/**
 * Recruiter emails → Screening. You move an email with a job description into an Outlook folder
 * ("Job leads" by default); each mail check turns every new email there into a Screening job —
 * from the posting it links to when it has one, else from the email itself — and runs the free
 * pre-screen on it. The paid fit score stays on your "Score" click.
 */
import { and, eq, sql } from 'drizzle-orm';
import { RateLimitError } from '@jm/ai';
import { NeedsSignIn, type MailClient, type MailMeta } from '@jm/mail';
import type { Db } from '../../db/client.ts';
import { applications, contacts, jobs, mailLeads } from '../../db/schema.ts';
import { addActivity, createApplication, findOrCreateCompany } from '../applications.ts';
import { logEvent } from '../log.ts';
import { PrescreenNotSetUp, prescreenApplication, type Prescreener } from '../crawl/prescreen.ts';
import { captureJob } from '../screening.ts';
import { FREE_MAIL, companyFromSenderName, rootDomain, titleFrom } from './rules.ts';

// ---------- reading a recruiter email (rules only) ----------

/** The recruiter's own message: no quoted thread below it, no long legal footer. */
export function leadBody(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (
      /^-{2,}\s*(original message|forwarded message)\s*-{2,}$/i.test(l) ||
      (/^from:\s+\S/i.test(l) && /^(sent|date):\s/i.test(lines[i + 1]?.trim() ?? '')) ||
      /^on .{6,120} wrote:$/i.test(l)
    ) {
      end = i;
      break;
    }
    if (
      i > 5 &&
      /^(this (e-?mail|message)( and any attachments)? (is|may be|contains) (confidential|intended)|confidentiality notice|disclaimer:|to unsubscribe|if you (no longer )?wish to (unsubscribe|be removed))/i.test(
        l,
      )
    ) {
      end = i;
      break;
    }
  }
  return lines
    .slice(0, end)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const label = (body: string, names: string) =>
  new RegExp(String.raw`^[\s*•\-–>]*(?:${names})\s*[*]*\s*:\s*[*]*\s*(.+?)\s*[*]*\s*$`, 'im').exec(
    body,
  )?.[1];

/** "Client: Fortune 500" isn't a name. */
const VAGUE_COMPANY =
  /\b(confidential|undisclosed|fortune\s*\d+|our client|a client|leading|top[- ]tier|major|global|well[- ]known|stealth)\b/i;

/** Hosts whose links are a job posting (not a careers home page or a signature link). */
const POSTING_LINK =
  /^https?:\/\/(?:[\w-]+\.)*(?:(?:greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|icims\.com|smartrecruiters\.com|jobvite\.com|workable\.com|bamboohr\.com|eightfold\.ai|avature\.net|breezy\.hr|applytojob\.com|rippling\.com|dover\.com)\/\S+|linkedin\.com\/(?:comm\/)?jobs\/view\/\d+\S*|indeed\.com\/(?:viewjob|rc\/clk|m\/viewjob)\S*|dice\.com\/job-detail\/\S+|wellfound\.com\/jobs\/\S+|builtin\.com\/job\/\S+|amazon\.jobs\/\S*jobs\/\d+\S*|jobs\.apple\.com\/\S*details\/\S+)/i;

/** Outlook's Safe Links wrapper → the link itself. */
function unwrap(url: string): string {
  try {
    const u = new URL(url);
    if (/safelinks\.protection\.outlook\.com$/i.test(u.hostname))
      return u.searchParams.get('url') ?? url;
  } catch {
    // not a URL
  }
  return url;
}

export function postingLink(body: string): string | null {
  for (const m of body.matchAll(/https?:\/\/[^\s<>"'()[\]]+/g)) {
    const url = unwrap(m[0]).replace(/[.,;:!?]+$/, '');
    if (POSTING_LINK.test(url)) return url.replace(/linkedin\.com\/comm\//i, 'linkedin.com/');
  }
  return null;
}

/** "RE: FW: Exciting Opportunity: Senior TPM - Remote | 12 months" → "Senior TPM". */
function titleFromSubject(subject: string): { title: string | null; company: string | null } {
  let s = subject
    .replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '')
    .replace(
      /^\s*((new|urgent|immediate|exciting|great|job|career|exclusive|direct[- ]hire)\s+)*(opportunity|opening|role|position|requirement|need)\s*[:\-–|]\s*/i,
      '',
    )
    .replace(/^\s*(urgent|immediate need|hot)\s*[:\-–|]\s*/i, '')
    .trim();
  s = s.split(/\s+[-–—|]\s+|\s*\|\s*/)[0]!.trim();
  const at = /^(.+?)\s+(?:role|position|opportunity|opening)?\s*(?:at|with|@)\s+(.+)$/i.exec(s);
  let company: string | null = null;
  if (at) {
    s = at[1]!;
    company = at[2]!.replace(/[.!]+$/, '').trim();
  }
  s = s.replace(/\s+(role|position|opportunity|opening)$/i, '').trim();
  return {
    title: s.length >= 3 && s.length <= 120 ? s : null,
    company: company && !VAGUE_COMPANY.test(company) && company.length <= 60 ? company : null,
  };
}

/** Senders whose domain says nothing about the company (free mail, job sites, LinkedIn InMail). */
const NOT_A_COMPANY_DOMAIN =
  /(^|\.)(linkedin\.com|indeed\.com|dice\.com|ziprecruiter\.com|glassdoor\.com|monster\.com)$/i;

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface LeadFields {
  title: string;
  company: string;
  recruiter: { name: string | null; address: string | null };
  postingUrl: string | null;
}

export function leadFields(meta: MailMeta, body: string): LeadFields {
  const subj = titleFromSubject(meta.subject);
  const labelled = label(
    body,
    String.raw`(?:job\s+)?title|position(?:\s+title)?|role(?:\s+title)?`,
  );
  const title =
    (labelled && labelled.length <= 120 ? labelled : null) ??
    titleFrom(meta.subject, body) ??
    subj.title ??
    'Unknown role';

  const named = label(body, String.raw`(?:end\s+)?client|company|employer|organi[sz]ation`);
  const domain = meta.from.address?.split('@')[1]?.toLowerCase() ?? '';
  const person = meta.from.name?.replace(/\s+via\s+\w+$/i, '').trim();
  const sender = companyFromSenderName(meta.from.name);
  const company =
    (named && named.length <= 60 && !VAGUE_COMPANY.test(named) ? named : null) ??
    subj.company ??
    // "Box Recruiting" names a company; a recruiter's own name ("Jane Doe") doesn't.
    (sender && sender !== person ? sender : null) ??
    (domain && !FREE_MAIL.test(domain) && !NOT_A_COMPANY_DOMAIN.test(domain)
      ? capitalize(rootDomain(domain).split('.')[0]!)
      : null) ??
    'Unknown';

  return {
    title: title.replace(/\s+/g, ' ').trim(),
    company: company.replace(/\s+/g, ' ').trim(),
    recruiter: {
      name: meta.from.name?.replace(/\s+via\s+linkedin$/i, '').trim() || null,
      address: meta.from.address,
    },
    postingUrl: postingLink(body),
  };
}

// ---------- adding one ----------

export interface LeadDeps {
  fetchFn?: typeof fetch;
  /** null: no pre-screen; undefined: the configured pre-screen model. */
  screener?: Prescreener | null;
  sleep?: (ms: number) => Promise<void>;
  prescreenGapMs?: number;
}

const today = () => new Date().toISOString().slice(0, 10);

/** The recruiter as a contact at the job's company (skipped when already known). */
function addRecruiter(db: Db, companyId: number, f: LeadFields) {
  const name = f.recruiter.name ?? f.recruiter.address;
  if (!name) return;
  const known = db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.companyId, companyId), sql`lower(${contacts.name}) = lower(${name})`))
    .get();
  if (known) return;
  db.insert(contacts)
    .values({
      companyId,
      name,
      relationship: 'Recruiter',
      notes: `Sent a job by email${f.recruiter.address ? ` (${f.recruiter.address})` : ''}`,
    })
    .run();
}

/** One email → a Screening job (or the job it links to, if already tracked). */
export async function addLead(db: Db, client: MailClient, meta: MailMeta, deps: LeadDeps = {}) {
  const msg = await client.message(meta.id);
  const body = leadBody(msg.bodyText);
  const f = leadFields(meta, body);
  const from = [f.recruiter.name, f.recruiter.address && `<${f.recruiter.address}>`]
    .filter(Boolean)
    .join(' ');

  let applicationId: number;
  let existing = false;
  if (f.postingUrl) {
    const r = await captureJob(
      db,
      { url: f.postingUrl, pageText: body.length >= 40 ? body : null },
      { fetchFn: deps.fetchFn },
    );
    applicationId = r.applicationId;
    existing = r.existing;
    if (!existing) {
      const job = db
        .select({ jobId: applications.jobId })
        .from(applications)
        .where(eq(applications.id, applicationId))
        .get()!;
      // The posting couldn't be read: the email fills in what it names.
      db.update(jobs)
        .set({
          ...(r.title === 'Unknown role' && f.title !== 'Unknown role' && { title: f.title }),
          ...(r.company === 'Unknown' &&
            f.company !== 'Unknown' && { companyId: findOrCreateCompany(db, f.company) }),
          ...(r.descriptionSource === 'Page text (whole page)' && {
            descriptionSource: 'Recruiter email',
          }),
        })
        .where(eq(jobs.id, job.jobId))
        .run();
    }
  } else {
    applicationId = createApplication(db, {
      company: f.company,
      title: f.title,
      status: 'Screening',
      source: 'Recruiter',
      descriptionText: body.length >= 40 ? body : null,
    });
    const job = db
      .select({ jobId: applications.jobId })
      .from(applications)
      .where(eq(applications.id, applicationId))
      .get()!;
    db.update(jobs)
      .set({ descriptionSource: body.length >= 40 ? 'Recruiter email' : null })
      .where(eq(jobs.id, job.jobId))
      .run();
  }

  const row = db
    .select({ companyId: jobs.companyId })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(eq(applications.id, applicationId))
    .get()!;
  addRecruiter(db, row.companyId, f);
  addActivity(db, applicationId, {
    at: meta.receivedAt.slice(0, 10) || today(),
    kind: 'Note',
    summary: `${existing ? 'A recruiter also sent this job' : 'From a recruiter email'}: “${meta.subject || '(no subject)'}”${from ? ` — ${from}` : ''}${meta.webLink ? ` · ${meta.webLink}` : ''}`,
  });

  db.insert(mailLeads)
    .values({
      internetMessageId: meta.internetMessageId ?? meta.id,
      messageId: meta.id,
      receivedAt: meta.receivedAt,
      fromName: meta.from.name,
      fromAddr: meta.from.address,
      subject: meta.subject || '(no subject)',
      webLink: meta.webLink,
      applicationId,
      existing,
    })
    .onConflictDoNothing()
    .run();
  return { applicationId, existing, ...f };
}

// ---------- the folder ----------

export interface LeadsResult {
  folderFound: boolean;
  added: number;
  screened: number;
}

/**
 * Every new email in the leads folder → Screening, then the free pre-screen on each new job
 * (one at a time, a pause between; stops for this check when the provider says "later").
 */
export async function syncLeads(
  db: Db,
  client: MailClient,
  folderName: string,
  deps: LeadDeps = {},
): Promise<LeadsResult> {
  const folderId = await client.folderByName(folderName);
  if (!folderId) return { folderFound: false, added: 0, screened: 0 };
  const known = new Set(
    db
      .select({ id: mailLeads.internetMessageId })
      .from(mailLeads)
      .all()
      .map((r) => r.id),
  );
  const fresh: number[] = [];
  let added = 0;
  for await (const page of client.messagesIn(folderId)) {
    for (const meta of page) {
      const key = meta.internetMessageId ?? meta.id;
      if (known.has(key)) continue;
      known.add(key);
      try {
        const r = await addLead(db, client, meta, deps);
        added++;
        if (!r.existing) fresh.push(r.applicationId);
        logEvent(
          'mail.leads.added',
          `${r.existing ? 'Recruiter email matched' : 'Added'} "${r.title}" at ${r.company} from a recruiter email`,
          { applicationId: r.applicationId, existing: r.existing, posting: r.postingUrl },
        );
      } catch (e) {
        if (e instanceof NeedsSignIn) throw e;
        // Left out of mail_leads, so the next check tries it again.
        logEvent(
          'mail.leads.error',
          `Couldn't add the recruiter email "${meta.subject}": ${(e as Error).message}`,
          { messageId: meta.id },
          'warn',
        );
      }
    }
  }

  let screened = 0;
  if (deps.screener !== null) {
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const gap = deps.prescreenGapMs ?? 2100;
    for (const [i, applicationId] of fresh.entries()) {
      if (i > 0) await sleep(gap);
      try {
        await prescreenApplication(db, applicationId, { screener: deps.screener });
        screened++;
      } catch (e) {
        if (e instanceof PrescreenNotSetUp) break; // pre-screen from the card once one is set up
        const msg = (e as Error).message;
        db.update(mailLeads)
          .set({ error: `Pre-screen failed: ${msg}` })
          .where(eq(mailLeads.applicationId, applicationId))
          .run();
        logEvent(
          'mail.leads.prescreen',
          `Pre-screen of a recruiter lead failed: ${msg}`,
          {},
          'warn',
        );
        if (e instanceof RateLimitError) break; // the rest wait for a click or the next lead
      }
    }
  }
  return { folderFound: true, added, screened };
}
