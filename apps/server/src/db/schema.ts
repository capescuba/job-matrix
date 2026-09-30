import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const createdAt = () =>
  text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);

export const companies = sqliteTable(
  'companies',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    website: text('website'),
    linkedinUrl: text('linkedin_url'),
    notes: text('notes'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('companies_name_nocase').on(sql`lower(${t.name})`)],
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    title: text('title').notNull(),
    url: text('url'),
    source: text('source'),
    location: text('location'),
    remoteType: text('remote_type'),
    salaryMin: integer('salary_min'),
    salaryMax: integer('salary_max'),
    descriptionText: text('description_text'),
    descriptionHash: text('description_hash'),
    /** Where the description came from, e.g. "Your selection", "LinkedIn template", "Greenhouse API". */
    descriptionSource: text('description_source'),
    /** Signed-in LinkedIn extras: "people you know", alumni, etc. (string[]) */
    linkedinInsights: text('linkedin_insights', { mode: 'json' }),
    postedAt: text('posted_at'),
    /** Where postedAt came from, e.g. "Ashby publishedAt"; null for dates saved before tracking. */
    postedSource: text('posted_source'),
    postedApprox: integer('posted_approx', { mode: 'boolean' }).notNull().default(false),
    /** The original value/text the date was read from. */
    postedRaw: text('posted_raw'),
    applicantCount: integer('applicant_count'),
    /** 'open' | 'closed' from the last posting check; null = never checked. */
    postingStatus: text('posting_status'),
    postingCheckedAt: text('posting_checked_at'),
    postingNote: text('posting_note'),
    createdAt: createdAt(),
  },
  (t) => [index('jobs_company').on(t.companyId)],
);

export const resumeVersions = sqliteTable('resume_versions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  label: text('label').notNull(),
  rawText: text('raw_text').notNull(),
  filePath: text('file_path'),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAt(),
});

/** Single-row table (id = 1). */
export const profile = sqliteTable('profile', {
  id: integer('id').primaryKey(),
  name: text('name'),
  /** Background + target roles (free text). */
  goals: text('goals'),
  minBase: integer('min_base'),
  /** Newline-separated criteria lists. */
  mustHaves: text('must_haves'),
  dealBreakers: text('deal_breakers'),
  strongPluses: text('strong_pluses'),
  niceToHaves: text('nice_to_haves'),
  knownGaps: text('known_gaps'),
  updatedAt: text('updated_at'),
  /** Your LinkedIn profile, read by the Chrome extension (you're signed in there; the server can't be). */
  linkedinUrl: text('linkedin_url'),
  /** { about?, experience?, … } → the text of each section. */
  linkedinSections: text('linkedin_sections', { mode: 'json' }),
  /** All sections under headings, as the AI sees them. */
  linkedinText: text('linkedin_text'),
  linkedinImportedAt: text('linkedin_imported_at'),
  /** Detailed career inventory built from the resume + LinkedIn (AI, on request), editable. */
  careerProfile: text('career_profile'),
  careerProfileAt: text('career_profile_at'),
  careerProfileUsageId: integer('career_profile_usage_id'),
});

export const applications = sqliteTable(
  'applications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('Saved'),
    appliedAt: text('applied_at'),
    resumeVersionId: integer('resume_version_id').references(() => resumeVersions.id, {
      onDelete: 'set null',
    }),
    coverLetter: text('cover_letter'),
    nextAction: text('next_action'),
    nextActionDate: text('next_action_date'),
    priority: integer('priority'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: text('updated_at'),
  },
  (t) => [index('applications_job').on(t.jobId), index('applications_status').on(t.status)],
);

export const statusEvents = sqliteTable(
  'status_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    at: text('at').notNull(),
  },
  (t) => [index('status_events_app').on(t.applicationId)],
);

/** Dated touchpoints (applied, follow-ups, responses, interviews, notes) — a series per application. */
export const activities = sqliteTable(
  'activities',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** YYYY-MM-DD */
    at: text('at').notNull(),
    kind: text('kind').notNull(),
    summary: text('summary'),
    createdAt: createdAt(),
  },
  (t) => [index('activities_app').on(t.applicationId)],
);

export const contacts = sqliteTable(
  'contacts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    role: text('role'),
    linkedinUrl: text('linkedin_url'),
    relationship: text('relationship'),
    notes: text('notes'),
    createdAt: createdAt(),
  },
  (t) => [index('contacts_company').on(t.companyId)],
);

export const fitAssessments = sqliteTable(
  'fit_assessments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    resumeVersionId: integer('resume_version_id')
      .notNull()
      .references(() => resumeVersions.id, { onDelete: 'cascade' }),
    /** Hash of JD + resume + goals + prompt version — the cache key. */
    inputHash: text('input_hash').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    /** 0–10 weighted total of the parts. */
    overallScore: real('overall_score').notNull(),
    /** Must-haves / deal-breakers: 'pass' | 'fail' | 'check'. */
    gate: text('gate').notNull().default('pass'),
    gateReasons: text('gate_reasons', { mode: 'json' }),
    result: text('result', { mode: 'json' }).notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /** The ai_usage row for the call that produced this (for "Inspect request"). */
    usageId: integer('usage_id'),
    createdAt: createdAt(),
  },
  (t) => [index('fit_job').on(t.jobId), index('fit_input_hash').on(t.inputHash)],
);

/** One row per AI API call — powers the Usage page. */
export const aiUsage = sqliteTable(
  'ai_usage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: createdAt(),
    /** What it was for, e.g. "fit". */
    feature: text('feature').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    /** Cost at the time of the call, so later price changes don't rewrite history. */
    costUsd: real('cost_usd'),
    applicationId: integer('application_id'),
    /** The company it was about — kept when the job is deleted, and set for company-only research. */
    companyId: integer('company_id'),
    durationMs: integer('duration_ms'),
    stopReason: text('stop_reason'),
    /** Error message when the call failed after reaching the model. */
    error: text('error'),
    /** Full request body, raw response and summarized thinking — for the request inspector. */
    requestJson: text('request_json', { mode: 'json' }),
    responseText: text('response_text'),
    thinkingText: text('thinking_text'),
  },
  (t) => [index('ai_usage_at').on(t.at)],
);

/** Cited company briefs from web research; the latest row per company is the current one. */
export const companyResearch = sqliteTable(
  'company_research',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    usageId: integer('usage_id'),
    ticker: text('ticker'),
    result: text('result', { mode: 'json' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('company_research_company').on(t.companyId)],
);

/** Gaps from each assessment, stored separately so recurring themes can be counted. */
export const fitGaps = sqliteTable(
  'fit_gaps',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    assessmentId: integer('assessment_id')
      .notNull()
      .references(() => fitAssessments.id, { onDelete: 'cascade' }),
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    theme: text('theme').notNull(),
    severity: text('severity').notNull(),
    knownGap: integer('known_gap', { mode: 'boolean' }).notNull().default(false),
    detail: text('detail'),
  },
  (t) => [index('fit_gaps_theme').on(t.theme), index('fit_gaps_assessment').on(t.assessmentId)],
);

/** "Teach this site": CSS selectors for a job site's fields, one template per host. */
export const siteTemplates = sqliteTable(
  'site_templates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    host: text('host').notNull(),
    name: text('name').notNull(),
    /** { title?, company?, location?, salary?, description? } → CSS selector. */
    selectors: text('selectors', { mode: 'json' }).notNull(),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [uniqueIndex('site_templates_host').on(t.host)],
);

/** Drafted answers to application-form questions ("Why do you want to work at X?"). */
export const applicationAnswers = sqliteTable(
  'application_answers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    usageId: integer('usage_id'),
    createdAt: createdAt(),
  },
  (t) => [index('application_answers_app').on(t.applicationId)],
);

/**
 * Job-related emails found in your mailbox, each with what it seems to mean for an application.
 * Nothing changes until you apply one; emails that aren't job-related are never stored.
 */
export const emailUpdates = sqliteTable(
  'email_updates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    messageId: text('message_id').notNull(),
    receivedAt: text('received_at').notNull(),
    fromName: text('from_name'),
    fromAddr: text('from_addr'),
    subject: text('subject').notNull(),
    webLink: text('web_link'),
    /** The start of the email (plain text, a few hundred characters). */
    excerpt: text('excerpt'),
    /** confirmation | rejection | interview | assessment | offer | viewed | unclear */
    kind: text('kind').notNull(),
    confidence: text('confidence').notNull().default('medium'),
    /** The sentence that gave the kind away. */
    evidence: text('evidence'),
    /** Company and job title as the email names them. */
    companyName: text('company_name'),
    jobTitle: text('job_title'),
    companyId: integer('company_id').references(() => companies.id, { onDelete: 'set null' }),
    applicationId: integer('application_id').references(() => applications.id, {
      onDelete: 'set null',
    }),
    /** How the application was found: title | only | only-open | ai | you */
    matchedBy: text('matched_by'),
    suggestedStatus: text('suggested_status'),
    suggestedNextAction: text('suggested_next_action'),
    /** 'rules' or 'ai'. */
    classifiedBy: text('classified_by').notNull().default('rules'),
    /** pending | applied | dismissed | noop (nothing to change) */
    state: text('state').notNull().default('pending'),
    activityId: integer('activity_id'),
    usageId: integer('usage_id'),
    createdAt: createdAt(),
    resolvedAt: text('resolved_at'),
  },
  (t) => [
    uniqueIndex('email_updates_message').on(t.messageId),
    index('email_updates_state').on(t.state),
    index('email_updates_app').on(t.applicationId),
  ],
);

/** One row (id 1): mailbox checking settings and progress. */
export const mailSync = sqliteTable('mail_sync', {
  id: integer('id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** -1 manual only (default), 0 when the app opens, else minutes between checks. */
  intervalMinutes: integer('interval_minutes').notNull().default(-1),
  /** Checked up to here (receivedDateTime of the newest message seen). */
  watermark: text('watermark'),
  lastSyncAt: text('last_sync_at'),
  lastError: text('last_error'),
  /** Last check: messages looked at, job-related ones found. */
  scanned: integer('scanned').notNull().default(0),
  found: integer('found').notNull().default(0),
});

/**
 * Other names a company goes by ("SpaceXAI" for Cursor after an acquisition, a parent brand, an
 * old name), so emails and pages that use them still match. `aliasKey` is companyKey(alias).
 */
export const companyAliases = sqliteTable(
  'company_aliases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    alias: text('alias').notNull(),
    aliasKey: text('alias_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('company_aliases_key').on(t.aliasKey),
    index('company_aliases_company').on(t.companyId),
  ],
);

/** The watchlist: company career boards checked for new jobs. */
export const crawlSources = sqliteTable(
  'crawl_sources',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** greenhouse | ashby | lever | workday */
    kind: text('kind').notNull(),
    companyName: text('company_name').notNull(),
    /** The board's name at the job site: "anthropic", or "nvidia/NVIDIAExternalCareerSite" on Workday. */
    slug: text('slug').notNull(),
    /** The board's public page, e.g. https://jobs.ashbyhq.com/openai. */
    boardUrl: text('board_url').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastCheckedAt: text('last_checked_at'),
    lastError: text('last_error'),
    /** Last check: open jobs on the board, and how many had a title you watch for. */
    lastCount: integer('last_count'),
    lastMatched: integer('last_matched'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('crawl_sources_board').on(t.kind, t.slug)],
);

/**
 * Saved job searches on LinkedIn, Indeed, Glassdoor or ZipRecruiter. The Chrome extension opens
 * each one in your signed-in Chrome, reads the listings and sends them here.
 */
export const crawlSearches = sqliteTable('crawl_searches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** linkedin | indeed | glassdoor | ziprecruiter */
  site: text('site').notNull(),
  label: text('label').notNull(),
  /** The results page, as you had it in Chrome. */
  url: text('url').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** True for the built-in search on each site (made from your keywords and place); false for one you pasted. */
  preset: integer('preset', { mode: 'boolean' }).notNull().default(false),
  lastRunAt: text('last_run_at'),
  lastError: text('last_error'),
  /** Last run: listings read, how many had a title you watch for, and how many were added. */
  lastCount: integer('last_count'),
  lastMatched: integer('last_matched'),
  lastAdded: integer('last_added'),
  createdAt: createdAt(),
});

/**
 * Jobs found on watched boards or saved searches whose title matched, each with what was decided
 * about it. A job is decided once: added to the Screening inbox, or kept here with the reason it
 * wasn't.
 */
export const crawlLeads = sqliteTable(
  'crawl_leads',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceId: integer('source_id').references(() => crawlSources.id, { onDelete: 'cascade' }),
    searchId: integer('search_id').references(() => crawlSearches.id, { onDelete: 'set null' }),
    /** Normalized posting URL (see normalizeUrl). */
    url: text('url').notNull(),
    company: text('company').notNull(),
    title: text('title').notNull(),
    location: text('location'),
    remoteType: text('remote_type'),
    salaryMin: integer('salary_min'),
    salaryMax: integer('salary_max'),
    postedAt: text('posted_at'),
    /** yes | maybe (in the inbox) · no-rules | no-ai | duplicate (filtered out) · waiting | error (try again) */
    verdict: text('verdict').notNull(),
    reason: text('reason'),
    /** The model that judged it, when one did. */
    model: text('model'),
    usageId: integer('usage_id'),
    applicationId: integer('application_id').references(() => applications.id, {
      onDelete: 'set null',
    }),
    decidedAt: text('decided_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('crawl_leads_url').on(t.url), index('crawl_leads_verdict').on(t.verdict)],
);

/** One row (id 1): watchlist settings and the last check. */
export const crawlState = sqliteTable('crawl_state', {
  id: integer('id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** -1 manual only, 0 when the app opens (default), else minutes between checks. */
  intervalMinutes: integer('interval_minutes').notNull().default(0),
  /** Newline-separated lists; null = the built-in defaults. */
  titleInclude: text('title_include'),
  titleExclude: text('title_exclude'),
  locations: text('locations'),
  lastRunAt: text('last_run_at'),
  lastError: text('last_error'),
  /** Last check: boards read, jobs seen, titles matched, added to the inbox, filtered out. */
  boards: integer('boards').notNull().default(0),
  seen: integer('seen').notNull().default(0),
  matched: integer('matched').notNull().default(0),
  added: integer('added').notNull().default(0),
  filtered: integer('filtered').notNull().default(0),
  /** When the extension last started running the saved searches. */
  searchRunAt: text('search_run_at'),
  /** What the built-in job-site searches look for, and where; null = the defaults. */
  searchKeywords: text('search_keywords'),
  searchLocation: text('search_location'),
});
