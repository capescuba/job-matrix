import type {
  ActivityInput,
  ApplicationPatch,
  ContactInput,
  FitResult,
  GateReason,
  JobPatch,
  ProfilePatch,
  QuickAddInput,
  Status,
} from '@jm/shared';
import type {
  ApplicationRow,
  getApplicationDetail,
} from '../../server/src/services/applications.ts';
import type {
  FetchedJob,
  checkPostings,
  fetchMissingDescriptions,
} from '../../server/src/services/jobfetch.ts';
import type { FitBatchStatus } from '../../server/src/services/fit.ts';
import type { getProfile } from '../../server/src/services/resume.ts';
import type { linkedinSummary } from '../../server/src/services/linkedin.ts';
import type { analyzeApplication } from '../../server/src/services/analyze.ts';
import type { ResearchRow } from '../../server/src/services/research.ts';
import type { CaptureResult } from '../../server/src/services/screening.ts';
import type { StockQuote } from '../../server/src/services/stock.ts';
import type { getSettings } from '../../server/src/services/settings.ts';
import type { getStats } from '../../server/src/services/stats.ts';
import type { getCall, getUsageSummary } from '../../server/src/services/usage.ts';
import type { listAnswers } from '../../server/src/services/extension.ts';
import type { EmailUpdateRow } from '../../server/src/services/mail/updates.ts';
import type { EmailKind } from '../../server/src/services/mail/rules.ts';
import type { LogEntry, listLogs } from '../../server/src/services/logs.ts';
import type { MailStatus as MailConnection } from '@jm/mail';
import type { CrawlProgress } from '../../server/src/services/crawl/run.ts';
import type { LeadRow, SourceRow } from '../../server/src/services/crawl/watchlist.ts';

export type { LeadRow, SourceRow };
/** The watchlist: what to look for, and how the last check went. */
export interface CrawlStatus {
  enabled: boolean;
  intervalMinutes: number;
  intervals: readonly number[];
  titleInclude: string[];
  titleExclude: string[];
  locations: string[];
  lastRunAt: string | null;
  lastError: string | null;
  last: { boards: number; seen: number; matched: number; added: number; filtered: number };
  nextRunAt: string | null;
  progress: CrawlProgress;
  /** Boards followed, and jobs currently filtered out. */
  sources: number;
  filteredCount: number;
}

export type Settings = ReturnType<typeof getSettings>;
export type { EmailKind, EmailUpdateRow, LogEntry };
export type LogFile = ReturnType<typeof listLogs>[number];
export interface MailStatus extends MailConnection {
  enabled: boolean;
  intervalMinutes: number;
  intervals: readonly number[];
  lastSyncAt: string | null;
  scanned: number;
  found: number;
  watermark: string | null;
  nextSyncAt: string | null;
  pending: number;
  progress: { running: boolean; scanned: number; found: number; startedAt: string | null };
  askAiUsd: number | null;
}
export type Usage = ReturnType<typeof getUsageSummary>;

export type { ApplicationRow, FetchedJob, StockQuote };
export type ApplicationDetail = ReturnType<typeof getApplicationDetail>;
export type FitAssessment = Omit<ApplicationDetail['fits'][number], 'result' | 'gateReasons'> & {
  result: FitResult;
  gateReasons: GateReason[] | null;
};
export type Stats = ReturnType<typeof getStats>;
export type Contact = ApplicationDetail['contacts'][number];
export type Activity = ApplicationDetail['activities'][number];
export type LinkedInSummary = ReturnType<typeof linkedinSummary>;
export interface CareerProfileInfo {
  careerProfile: string | null;
  builtAt: string | null;
  buildUsd: number | null;
  hasResume: boolean;
  hasLinkedIn: boolean;
  linkedinNewer: boolean;
  staleJobs: number;
  rescoreUsd: number;
}
export interface ProfileResponse {
  profile: Omit<ReturnType<typeof getProfile>, 'linkedinText' | 'linkedinSections'>;
  linkedin: LinkedInSummary;
  resumes: { id: number; label: string; isDefault: boolean; createdAt: string; chars: number }[];
  aiConfigured: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    headers: body && !isForm ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, res.status);
  return data as T;
}

export const api = {
  listApplications: () => request<ApplicationRow[]>('GET', '/api/applications'),
  getApplication: (id: number) => request<ApplicationDetail>('GET', `/api/applications/${id}`),
  createApplication: (input: QuickAddInput) =>
    request<{ id: number }>('POST', '/api/applications', input),
  updateApplication: (id: number, patch: ApplicationPatch) =>
    request<ApplicationDetail>('PATCH', `/api/applications/${id}`, patch),
  deleteApplication: (id: number) => request<void>('DELETE', `/api/applications/${id}`),
  updateJob: (id: number, patch: JobPatch) =>
    request<{ ok: true }>('PATCH', `/api/jobs/${id}`, patch),
  updateCompany: (
    id: number,
    patch: { website?: string | null; linkedinUrl?: string | null; notes?: string | null },
  ) => request<{ ok: true }>('PATCH', `/api/companies/${id}`, patch),
  scoreFit: (id: number, force = false) =>
    request<{ assessment: FitAssessment; cached: boolean }>(
      'POST',
      `/api/applications/${id}/fit${force ? '?force=1' : ''}`,
    ),
  /** Starts background scoring of every unscored job (or joins the running batch). */
  /** Screening's Score: fit + company research (when not fresh). */
  analyze: (id: number, force = false) =>
    request<Awaited<ReturnType<typeof analyzeApplication>>>(
      'POST',
      `/api/applications/${id}/analyze${force ? '?force=1' : ''}`,
    ),
  getResearch: (companyId: number) =>
    request<(ResearchRow & { stale: boolean }) | null>(
      'GET',
      `/api/companies/${companyId}/research`,
    ),
  refreshResearch: (companyId: number) =>
    request<ResearchRow>('POST', `/api/companies/${companyId}/research?force=1`),
  getStock: (companyId: number) =>
    request<StockQuote | null>('GET', `/api/companies/${companyId}/stock`),
  startScoreAllWithResearch: (status: Status) =>
    request<FitBatchStatus>(
      'POST',
      `/api/fit/batch?status=${encodeURIComponent(status)}&research=1`,
    ),
  startScoreAll: (status?: Status) =>
    request<FitBatchStatus>(
      'POST',
      `/api/fit/batch${status ? `?status=${encodeURIComponent(status)}` : ''}`,
    ),
  /** Add a job to the Screening inbox from its URL (server-side fetch). */
  screenUrl: (url: string) => request<CaptureResult>('POST', '/api/screen/url', { url }),
  scoreAllStatus: () => request<FitBatchStatus | null>('GET', '/api/fit/batch'),
  /** Re-score open jobs whose score predates your current profile. */
  rescoreStale: () => request<FitBatchStatus>('POST', '/api/fit/batch?stale=1'),
  // ----- LinkedIn profile and career profile -----
  setLinkedInUrl: (url: string | null) =>
    request<LinkedInSummary>('PUT', '/api/linkedin/url', { url }),
  linkedinText: () => request<{ text: string }>('GET', '/api/linkedin/text'),
  clearLinkedIn: () => request<LinkedInSummary>('DELETE', '/api/linkedin'),
  careerProfile: () => request<CareerProfileInfo>('GET', '/api/career-profile'),
  buildCareerProfile: () =>
    request<{ careerProfile: string; conflicts: string[] }>('POST', '/api/career-profile'),
  /** Fetch a posting's details from its URL without saving (for forms). */
  fetchJob: (url: string) => request<FetchedJob>('POST', '/api/fetch-job', { url }),
  /** Fetch and save descriptions for every job with a URL but no description. */
  /** Re-check open applications' postings: open/closed and posted date. */
  checkPostings: () =>
    request<Awaited<ReturnType<typeof checkPostings>>>('POST', '/api/jobs/check-postings'),
  fetchMissingDescriptions: () =>
    request<Awaited<ReturnType<typeof fetchMissingDescriptions>>>(
      'POST',
      '/api/jobs/fetch-missing',
    ),
  createContact: (input: ContactInput) => request<Contact>('POST', '/api/contacts', input),
  deleteContact: (id: number) => request<void>('DELETE', `/api/contacts/${id}`),
  addActivity: (applicationId: number, input: ActivityInput) =>
    request<Activity>('POST', `/api/applications/${applicationId}/activities`, input),
  deleteActivity: (id: number) => request<void>('DELETE', `/api/activities/${id}`),
  getProfile: () => request<ProfileResponse>('GET', '/api/profile'),
  updateProfile: (patch: ProfilePatch) => request('PATCH', '/api/profile', patch),
  uploadResume: (label: string, file: File) => {
    const form = new FormData();
    form.append('label', label); // must precede the file so the server sees it
    form.append('file', file);
    return request<{ id: number }>('POST', '/api/resumes', form);
  },
  getResume: (id: number) =>
    request<{ id: number; label: string; rawText: string }>('GET', `/api/resumes/${id}`),
  setDefaultResume: (id: number) => request('POST', `/api/resumes/${id}/default`),
  deleteResume: (id: number) => request<void>('DELETE', `/api/resumes/${id}`),
  stats: () => request<Stats>('GET', '/api/stats'),
  usage: () => request<Usage>('GET', '/api/usage'),
  /** One AI call's full record: request body, response, thinking. */
  getCall: (id: number) =>
    request<NonNullable<ReturnType<typeof getCall>>>('GET', `/api/ai/calls/${id}`),
  /** Answers drafted by the extension's application helper. */
  listAnswers: (applicationId: number) =>
    request<ReturnType<typeof listAnswers>>('GET', `/api/applications/${applicationId}/answers`),
  deleteAnswer: (id: number) => request<void>('DELETE', `/api/answers/${id}`),
  getSettings: () => request<Settings>('GET', '/api/settings'),
  updateSettings: (patch: {
    anthropicApiKey?: string | null;
    aiModel?: string | null;
    /** null = same as the fit model. */
    aiResearchModel?: string | null;
    aiEmailModel?: string | null;
    aiEffort?: Settings['effort'] | null;
  }) => request<Settings>('PUT', '/api/settings', patch),

  // ----- email -----
  mailStatus: () => request<MailStatus>('GET', '/api/mail/status'),
  mailConnect: () =>
    request<{ userCode: string; verificationUri: string; expiresAt: number }>(
      'POST',
      '/api/mail/connect',
    ),
  mailSettings: (patch: { enabled?: boolean; intervalMinutes?: number }) =>
    request<MailStatus>('POST', '/api/mail/settings', patch),
  mailSync: () => request<MailStatus>('POST', '/api/mail/sync'),
  mailRescan: () => request<MailStatus>('POST', '/api/mail/rescan'),
  emailUpdates: (state: 'pending' | 'done') =>
    request<EmailUpdateRow[]>('GET', `/api/email-updates?state=${state}`),
  applyEmailUpdate: (
    id: number,
    body: {
      applicationId?: number;
      status?: Status | null;
      nextAction?: string | null;
      rememberAlias?: string | null;
    } = {},
  ) => request('POST', `/api/email-updates/${id}/apply`, body),
  dismissEmailUpdate: (id: number) => request('POST', `/api/email-updates/${id}/dismiss`),
  restoreEmailUpdate: (id: number) => request('POST', `/api/email-updates/${id}/restore`),
  relabelEmailUpdate: (
    id: number,
    body: {
      kind?: EmailKind;
      applicationId?: number | null;
      companyId?: number;
      rememberAlias?: boolean;
    },
  ) => request('POST', `/api/email-updates/${id}/relabel`, body),
  trackEmailUpdate: (id: number, body: { company: string; title: string }) =>
    request('POST', `/api/email-updates/${id}/track`, body),
  classifyEmailUpdate: (id: number) => request('POST', `/api/email-updates/${id}/classify`),

  // ----- companies and the other names they go by -----
  companies: () => request<{ id: number; name: string }[]>('GET', '/api/companies'),
  aliases: (companyId: number) =>
    request<{ id: number; alias: string; createdAt: string }[]>(
      'GET',
      `/api/companies/${companyId}/aliases`,
    ),
  addAlias: (companyId: number, alias: string) =>
    request('POST', `/api/companies/${companyId}/aliases`, { alias }),
  removeAlias: (id: number) => request<void>('DELETE', `/api/aliases/${id}`),

  // ----- watchlist: company job boards checked for new jobs -----
  crawlStatus: () => request<CrawlStatus>('GET', '/api/crawl/status'),
  crawlSettings: (patch: {
    enabled?: boolean;
    intervalMinutes?: number;
    titleInclude?: string[];
    titleExclude?: string[];
    locations?: string[];
  }) => request<CrawlStatus>('POST', '/api/crawl/settings', patch),
  /** Starts a check; follow it through crawlStatus().progress. */
  crawlRun: () => request<CrawlStatus>('POST', '/api/crawl/run'),
  crawlSources: () => request<SourceRow[]>('GET', '/api/crawl/sources'),
  /** Follow the board behind a board, job or careers-page address. */
  addCrawlSource: (url: string, companyName?: string | null) =>
    request<SourceRow>('POST', '/api/crawl/sources', { url, companyName }),
  updateCrawlSource: (id: number, patch: { enabled?: boolean; companyName?: string }) =>
    request<SourceRow>('PATCH', `/api/crawl/sources/${id}`, patch),
  removeCrawlSource: (id: number) => request<void>('DELETE', `/api/crawl/sources/${id}`),
  /** Jobs that matched a watched title but were kept out of the inbox. */
  crawlLeads: () => request<LeadRow[]>('GET', '/api/crawl/leads'),
  addCrawlLead: (id: number) => request<CaptureResult>('POST', `/api/crawl/leads/${id}/add`),

  // ----- logs -----
  logs: () => request<{ dir: string; files: LogFile[] }>('GET', '/api/logs'),
  log: (name: string, lines = 2000) =>
    request<{ name: string; size: number; truncated: boolean; entries: LogEntry[] }>(
      'GET',
      `/api/logs/${encodeURIComponent(name)}?lines=${lines}`,
    ),
};
