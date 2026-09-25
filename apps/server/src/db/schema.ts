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
