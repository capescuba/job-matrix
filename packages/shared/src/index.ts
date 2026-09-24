import { z } from 'zod';

export const STATUSES = [
  'Saved',
  'Applied',
  'Recruiter Screen',
  'Hiring Manager',
  'Interview Loop',
  'Offer',
  'Rejected',
  'Withdrawn',
  'Ghosted',
] as const;
export type Status = (typeof STATUSES)[number];

/** Terminal states — the application is closed. */
export const CLOSED_STATUSES: readonly Status[] = ['Offer', 'Rejected', 'Withdrawn', 'Ghosted'];

/** Statuses that mean the employer actually responded (used for response-rate stats). */
export const RESPONSE_STATUSES: readonly Status[] = [
  'Recruiter Screen',
  'Hiring Manager',
  'Interview Loop',
  'Offer',
  'Rejected',
];

export const SOURCES = [
  'LinkedIn',
  'Greenhouse',
  'Lever',
  'Ashby',
  'Workday',
  'Referral',
  'Company site',
  'Other',
] as const;
export const REMOTE_TYPES = ['Remote', 'Hybrid', 'Onsite'] as const;
export const RELATIONSHIPS = [
  'Connection',
  'Recruiter',
  'Hiring manager',
  'Referral',
  'Other',
] as const;

/** Dated touchpoints on an application. Response/Interview count as the employer responding. */
export const ACTIVITY_KINDS = ['Applied', 'Follow-up', 'Response', 'Interview', 'Note'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const RESPONSE_ACTIVITY_KINDS: readonly ActivityKind[] = ['Response', 'Interview'];

export function guessSource(url: string | null | undefined): (typeof SOURCES)[number] | null {
  if (!url) return null;
  const u = url.toLowerCase();
  if (u.includes('linkedin.com')) return 'LinkedIn';
  if (u.includes('greenhouse.io')) return 'Greenhouse';
  if (u.includes('lever.co')) return 'Lever';
  if (u.includes('ashbyhq.com')) return 'Ashby';
  if (u.includes('myworkdayjobs.com') || u.includes('workday')) return 'Workday';
  return 'Company site';
}

// ---------- API input schemas ----------

export const quickAddSchema = z.object({
  company: z.string().trim().min(1),
  title: z.string().trim().min(1),
  url: z.string().trim().optional().nullable(),
  location: z.string().trim().optional().nullable(),
  remoteType: z.enum(REMOTE_TYPES).optional().nullable(),
  source: z.enum(SOURCES).optional().nullable(),
  descriptionText: z.string().optional().nullable(),
  status: z.enum(STATUSES).default('Saved'),
  appliedAt: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});
export type QuickAddInput = z.input<typeof quickAddSchema>;

export const applicationPatchSchema = z.object({
  status: z.enum(STATUSES).optional(),
  appliedAt: z.string().nullable().optional(),
  resumeVersionId: z.number().int().nullable().optional(),
  coverLetter: z.string().nullable().optional(),
  nextAction: z.string().nullable().optional(),
  nextActionDate: z.string().nullable().optional(),
  priority: z.number().int().min(0).max(3).nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type ApplicationPatch = z.infer<typeof applicationPatchSchema>;

export const jobPatchSchema = z.object({
  title: z.string().trim().min(1).optional(),
  url: z.string().nullable().optional(),
  source: z.enum(SOURCES).nullable().optional(),
  location: z.string().nullable().optional(),
  remoteType: z.enum(REMOTE_TYPES).nullable().optional(),
  salaryMin: z.number().int().nullable().optional(),
  salaryMax: z.number().int().nullable().optional(),
  descriptionText: z.string().nullable().optional(),
  postedAt: z.string().nullable().optional(),
  /** Manual override, e.g. when one site says filled and another says open. */
  postingStatus: z.enum(['open', 'closed']).nullable().optional(),
  postingNote: z.string().nullable().optional(),
});
export type JobPatch = z.infer<typeof jobPatchSchema>;

export const contactSchema = z.object({
  companyId: z.number().int(),
  name: z.string().trim().min(1),
  role: z.string().nullable().optional(),
  linkedinUrl: z.string().nullable().optional(),
  relationship: z.enum(RELATIONSHIPS).nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type ContactInput = z.infer<typeof contactSchema>;

export const activitySchema = z.object({
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Expected YYYY-MM-DD'),
  kind: z.enum(ACTIVITY_KINDS),
  summary: z.string().trim().nullable().optional(),
  /** Optionally move the application to this status at the same time. */
  setStatus: z.enum(STATUSES).nullable().optional(),
});
export type ActivityInput = z.infer<typeof activitySchema>;

/** Profile list fields: one criterion per line. */
export const PROFILE_LISTS = [
  'mustHaves',
  'dealBreakers',
  'strongPluses',
  'niceToHaves',
  'knownGaps',
] as const;
export type ProfileListKey = (typeof PROFILE_LISTS)[number];

export const profilePatchSchema = z.object({
  name: z.string().nullable().optional(),
  /** Background + target roles, free text. */
  goals: z.string().nullable().optional(),
  /** Minimum base salary (USD); checked in code against the posted range. */
  minBase: z.number().int().nullable().optional(),
  mustHaves: z.string().nullable().optional(),
  dealBreakers: z.string().nullable().optional(),
  strongPluses: z.string().nullable().optional(),
  niceToHaves: z.string().nullable().optional(),
  knownGaps: z.string().nullable().optional(),
});
export type ProfilePatch = z.infer<typeof profilePatchSchema>;

export const splitLines = (s: string | null | undefined) =>
  (s ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean);

// ---------- AI fit assessment (0–10) ----------

/** The parts of a fit score and how much each contributes to the total. */
export const FIT_PARTS = {
  skills: { label: 'Skills match', weight: 0.35 },
  level: { label: 'Level match', weight: 0.2 },
  logistics: { label: 'Logistics', weight: 0.15 },
  pay: { label: 'Pay', weight: 0.15 },
  upside: { label: 'Upside & interest', weight: 0.15 },
} as const;
export type FitPartKey = keyof typeof FIT_PARTS;

const part = z.object({
  score: z.number().describe('0-10, one decimal allowed'),
  why: z.string().describe('One or two sentences: why this score and not higher'),
});

export const CRITERION_STATUSES = ['ok', 'fails', 'unclear'] as const;

export const fitResultSchema = z.object({
  verdict: z.enum(['Strong fit', 'Good fit', 'Stretch', 'Weak fit']),
  summary: z.string().describe('2-3 sentence bottom line for the candidate'),
  whyNotHigher: z
    .string()
    .describe('The main things holding the total back from a higher score, concretely'),
  parts: z.object({
    skills: part.describe('Program types, domain and technical depth vs. the resume'),
    level: part.describe('Title/level/years/scope vs. Principal/Staff target'),
    logistics: part.describe('Location, office days per week, commute from home base, travel'),
    pay: part.describe('Posted range vs. the minimum base and a high top end; equity'),
    upside: part.describe('Strong pluses, company trajectory, equity upside, how interesting'),
  }),
  criteria: z
    .array(
      z.object({
        kind: z.enum(['must', 'dealbreaker']),
        criterion: z.string().describe('The criterion text, copied from the candidate list'),
        status: z
          .enum(CRITERION_STATUSES)
          .describe('must: ok = met, fails = not met. dealbreaker: fails = triggered, ok = clear'),
        note: z.string().describe('Evidence from the posting, or what is missing'),
      }),
    )
    .describe('One entry for every must-have and every deal-breaker, in order'),
  strengths: z.array(
    z.object({
      point: z.string(),
      evidence: z.string().describe('Specific line or fact from the resume that supports it'),
    }),
  ),
  gaps: z.array(
    z.object({
      gap: z.string().describe('The specific gap for this job'),
      theme: z
        .string()
        .describe('Short reusable label, 2-5 words; reuse an existing theme when it fits'),
      severity: z.enum(['Minor', 'Moderate', 'Major']),
      knownGap: z.boolean().describe("True if it matches one of the candidate's known gaps"),
      mitigation: z.string().describe('How to address it in the application or interview'),
    }),
  ),
  flags: z.object({
    levelMismatch: z
      .string()
      .nullable()
      .describe('If the level/years asked are clearly below or above target, say how; else null'),
    outreach: z.object({
      recommended: z.boolean(),
      why: z.string().describe('Whether contacting someone directly would help, and who'),
    }),
  }),
  facts: z.object({
    officeDaysPerWeek: z.number().nullable().describe('Required in-office days, null if unstated'),
    travelPercent: z.number().nullable(),
    yearsRequired: z.number().nullable(),
    employmentType: z.enum(['Full-time', 'Contract', 'Part-time', 'Unknown']),
  }),
  interviewFocus: z.array(z.string()).describe('Topics the interviewers will most likely probe'),
  talkingPoints: z.array(z.string()).describe('Exactly 3 talking points to lead with'),
});
export type FitResult = z.infer<typeof fitResultSchema>;

/** Weighted 0–10 total from the parts, one decimal. */
export function fitTotal(parts: FitResult['parts']): number {
  const t = (Object.keys(FIT_PARTS) as FitPartKey[]).reduce(
    (sum, k) => sum + Math.max(0, Math.min(10, parts[k].score)) * FIT_PARTS[k].weight,
    0,
  );
  return Math.round(t * 10) / 10;
}

export type Gate = 'pass' | 'fail' | 'check';
export interface GateReason {
  kind: 'must' | 'dealbreaker' | 'pay';
  label: string;
  status: 'fails' | 'unclear';
  note: string;
}

// ---------- AI usage pricing ----------

/** USD per million tokens (Anthropic list prices, Sep 2026). Cache reads bill at 10% of input, writes at 125%. */
export const MODEL_PRICING: Record<string, { label: string; input: number; output: number }> = {
  'claude-fable-5-1': { label: 'Claude Fable 5.1', input: 10, output: 50 },
  'claude-opus-5-5': { label: 'Claude Opus 5.5', input: 4, output: 20 },
  'claude-opus-5': { label: 'Claude Opus 5', input: 5, output: 25 },
  'claude-sonnet-5': { label: 'Claude Sonnet 5', input: 2, output: 10 },
  'claude-haiku-4-5': { label: 'Claude Haiku 4.5', input: 1, output: 5 },
};
export const PRICING_AS_OF = 'Sep 2026';

/** Longest-prefix match so dated/suffixed ids (e.g. "claude-opus-5-…") still price correctly. */
export function pricingFor(model: string) {
  const key = Object.keys(MODEL_PRICING)
    .filter((k) => model === k || model.startsWith(`${k}-`) || model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? { id: key, ...MODEL_PRICING[key] } : null;
}

export function estimateCostUsd(
  model: string,
  t: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
): number | null {
  const p = pricingFor(model);
  if (!p) return null;
  const input = t.inputTokens + (t.cacheReadTokens ?? 0) * 0.1 + (t.cacheWriteTokens ?? 0) * 1.25;
  return (input * p.input + t.outputTokens * p.output) / 1_000_000;
}
