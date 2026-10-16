import { desc, eq, sql } from 'drizzle-orm';
import type { CallTrace, TokenUsage } from '@jm/ai';
import { PRICING_AS_OF, estimateCostUsd, pricingFor } from '@jm/shared';
import type { Db } from '../db/client.ts';
import { aiUsage, applications, companies, jobs } from '../db/schema.ts';
import { FIT_SYSTEM_PROMPT, unscoredApplicationIds } from './fit.ts';
import { getDefaultResume, getProfile } from './resume.ts';
import { logEvent } from './log.ts';
import { getSettings } from './settings.ts';

export type Feature =
  | 'fit'
  | 'research'
  | 'answer'
  | 'email'
  | 'profile'
  | 'prescreen'
  | 'coach'
  | 'prep'
  | 'debrief';

/** Output tokens (incl. thinking) a fit assessment typically uses, for forecasts before any history exists. */
const FIT_OUTPUT_TOKENS_GUESS = 4_000;
const CHARS_PER_TOKEN = 4;
/** Research cost before history exists, on Opus 5 (scaled for other models) — measured: DocuSign, 6 searches, ~108k tokens in = $0.78. */
const RESEARCH_ESTIMATE_USD = 0.8;

/** Logs one AI call (with its full trace when available). Returns the row id. */
export function recordUsage(
  db: Db,
  e: {
    feature: Feature;
    provider: string;
    model: string;
    usage?: TokenUsage;
    applicationId?: number;
    companyId?: number;
    trace?: CallTrace;
    error?: string;
  },
): number {
  const u = e.usage ?? { inputTokens: 0, outputTokens: 0 };
  const cost = estimateCostUsd(e.model, u);
  logEvent(
    'ai.call',
    `AI call (${e.feature}, ${e.model})${cost != null ? ` ≈ $${cost.toFixed(3)}` : ''}${e.error ? ` failed: ${e.error}` : ''}`,
    { feature: e.feature, model: e.model, costUsd: cost, applicationId: e.applicationId, companyId: e.companyId },
    e.error ? 'warn' : 'info',
  );
  return db
    .insert(aiUsage)
    .values({
      feature: e.feature,
      provider: e.provider,
      model: e.model,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens ?? 0,
      cacheWriteTokens: u.cacheWriteTokens ?? 0,
      costUsd: cost,
      applicationId: e.applicationId ?? null,
      companyId: e.companyId ?? null,
      durationMs: e.trace?.durationMs ?? null,
      stopReason: e.trace?.stopReason ?? null,
      error: e.error ?? null,
      requestJson: e.trace?.request ?? null,
      responseText: e.trace?.responseText ?? null,
      thinkingText: e.trace?.thinking ?? null,
    })
    .returning({ id: aiUsage.id })
    .get().id;
}

/** One call's full record, for the request inspector. */
export function getCall(db: Db, id: number) {
  return db.select().from(aiUsage).where(eq(aiUsage.id, id)).get() ?? null;
}

interface Agg {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number;
}
const emptyAgg = (): Agg => ({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheTokens: 0,
  costUsd: 0,
});

export function getUsageSummary(db: Db, now = new Date()) {
  const rows = db
    .select({
      id: aiUsage.id,
      at: aiUsage.at,
      feature: aiUsage.feature,
      model: aiUsage.model,
      inputTokens: aiUsage.inputTokens,
      outputTokens: aiUsage.outputTokens,
      cacheReadTokens: aiUsage.cacheReadTokens,
      cacheWriteTokens: aiUsage.cacheWriteTokens,
      costUsd: aiUsage.costUsd,
      applicationId: aiUsage.applicationId,
      durationMs: aiUsage.durationMs,
      error: aiUsage.error,
      company: companies.name,
      jobTitle: jobs.title,
    })
    .from(aiUsage)
    .leftJoin(applications, eq(applications.id, aiUsage.applicationId))
    .leftJoin(jobs, eq(jobs.id, applications.jobId))
    .leftJoin(companies, eq(companies.id, sql`coalesce(${aiUsage.companyId}, ${jobs.companyId})`))
    .orderBy(desc(aiUsage.at), desc(aiUsage.id))
    .all();
  const add = (a: Agg, r: (typeof rows)[number]) => {
    a.calls++;
    a.inputTokens += r.inputTokens;
    a.outputTokens += r.outputTokens;
    a.cacheTokens += r.cacheReadTokens + r.cacheWriteTokens;
    a.costUsd += r.costUsd ?? 0;
  };

  const total = emptyAgg();
  const monthKey = now.toISOString().slice(0, 7);
  const thisMonth = emptyAgg();
  const byModel = new Map<string, Agg>();
  const byFeature = new Map<string, Agg>();
  const DAY = 86_400_000;
  const days = Array.from({ length: 30 }, (_, i) => ({
    date: new Date(now.getTime() - (29 - i) * DAY).toISOString().slice(0, 10),
    costUsd: 0,
    calls: 0,
  }));

  for (const r of rows) {
    add(total, r);
    if (r.at.startsWith(monthKey)) add(thisMonth, r);
    add(byModel.get(r.model) ?? byModel.set(r.model, emptyAgg()).get(r.model)!, r);
    add(byFeature.get(r.feature) ?? byFeature.set(r.feature, emptyAgg()).get(r.feature)!, r);
    const d = days.find((x) => x.date === r.at.slice(0, 10));
    if (d) {
      d.costUsd += r.costUsd ?? 0;
      d.calls++;
    }
  }

  return {
    pricingAsOf: PRICING_AS_OF,
    total,
    thisMonth,
    last30Days: days,
    byModel: [...byModel].map(([model, a]) => ({
      model,
      label: pricingFor(model)?.label ?? model,
      ...a,
    })),
    byFeature: [...byFeature].map(([feature, a]) => ({ feature, ...a })),
    recent: rows.slice(0, 25).map((r) => ({
      id: r.id,
      at: r.at,
      feature: r.feature,
      model: r.model,
      inputTokens: r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens,
      outputTokens: r.outputTokens,
      costUsd: r.costUsd,
      applicationId: r.jobTitle == null ? null : r.applicationId,
      company: r.company,
      jobTitle: r.jobTitle,
      durationMs: r.durationMs,
      error: r.error,
    })),
    forecast: forecastFitBatch(db, rows),
  };
}

type UsageRow = {
  feature: string;
  model: string;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/**
 * Average cost of past calls for a feature as if made with `model`: their tokens at its prices,
 * plus what they spent on anything else (web searches). Null without usable history.
 */
export function repricedAverage(rows: UsageRow[], feature: string, model: string): number | null {
  const costs = rows
    .filter((r) => r.feature === feature && r.costUsd != null && pricingFor(r.model))
    .map((r) => {
      const tokens = {
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheWriteTokens: r.cacheWriteTokens,
      };
      const other = r.costUsd! - (estimateCostUsd(r.model, tokens) ?? 0);
      const at = estimateCostUsd(model, tokens);
      return at == null ? null : at + Math.max(0, other);
    })
    .filter((c): c is number => c != null);
  return costs.length ? costs.reduce((s, c) => s + c, 0) / costs.length : null;
}

/** Estimated cost of scoring every job that has a description but no score yet, with the current model. */
function forecastFitBatch(db: Db, rows: UsageRow[]) {
  const { model, researchModel } = getSettings();
  const ids = unscoredApplicationIds(db);
  const history = rows.filter((r) => r.feature === 'fit' && r.costUsd != null);
  let perCallUsd: number | null;
  let basis: 'history' | 'estimate';
  if (history.length >= 3) {
    perCallUsd = repricedAverage(rows, 'fit', model);
    basis = 'history';
  } else {
    // Rough: system prompt + resume + goals + an average JD in, a typical assessment out.
    const avgJd =
      (db.$client
        .prepare(
          `SELECT avg(length(j.description_text)) FROM jobs j WHERE length(coalesce(j.description_text,'')) > 0`,
        )
        .pluck()
        .get() as number | null) ?? 6_000;
    const chars =
      FIT_SYSTEM_PROMPT.length +
      (getDefaultResume(db)?.rawText.length ?? 6_000) +
      (getProfile(db).goals?.length ?? 0) +
      (getProfile(db).careerProfile?.length ?? 0) +
      avgJd;
    perCallUsd = estimateCostUsd(model, {
      inputTokens: Math.round(chars / CHARS_PER_TOKEN),
      outputTokens: FIT_OUTPUT_TOKENS_GUESS,
    });
    basis = 'estimate';
  }
  const researchPerCallUsd =
    repricedAverage(rows, 'research', researchModel) ??
    (RESEARCH_ESTIMATE_USD * (pricingFor(researchModel)?.input ?? 5)) / 5;
  return {
    model,
    modelLabel: pricingFor(model)?.label ?? model,
    researchModel,
    researchModelLabel: pricingFor(researchModel)?.label ?? researchModel,
    researchPerCallUsd,
    pending: ids.length,
    perCallUsd,
    totalUsd: perCallUsd == null ? null : perCallUsd * ids.length,
    basis,
  };
}
