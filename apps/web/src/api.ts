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
import type { analyzeApplication } from '../../server/src/services/analyze.ts';
import type { ResearchRow } from '../../server/src/services/research.ts';
import type { CaptureResult } from '../../server/src/services/screening.ts';
import type { StockQuote } from '../../server/src/services/stock.ts';
import type { getSettings } from '../../server/src/services/settings.ts';
import type { getStats } from '../../server/src/services/stats.ts';
import type { getCall, getUsageSummary } from '../../server/src/services/usage.ts';

export type Settings = ReturnType<typeof getSettings>;
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
export interface ProfileResponse {
  profile: ReturnType<typeof getProfile>;
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
  getSettings: () => request<Settings>('GET', '/api/settings'),
  updateSettings: (patch: {
    anthropicApiKey?: string | null;
    aiModel?: string | null;
    aiEffort?: Settings['effort'] | null;
  }) => request<Settings>('PUT', '/api/settings', patch),
};
