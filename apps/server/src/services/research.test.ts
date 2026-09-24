import { beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { LLMProvider, StructuredRequest } from '@jm/ai';
import { companyResearchSchema, estimateCostUsd, type CompanyResearch } from '@jm/shared';
import { buildApp } from '../app.ts';
import { openDb, type Db } from '../db/client.ts';
import { resumeVersions } from '../db/schema.ts';
import { analyzeApplication } from './analyze.ts';
import { createApplication } from './applications.ts';
import { fitBatchStatus, startFitBatch } from './fit.ts';
import { ensureResearch, isStale, latestResearch } from './research.ts';
import { parseYahooChart } from './stock.ts';

const brief: CompanyResearch = {
  flags: [
    {
      tone: 'red',
      title: 'Layoffs in 2026',
      detail: '6% cut',
      whyItMatters: 'Stability',
      sourceIds: [1],
    },
    {
      tone: 'green',
      title: 'AI platform push',
      detail: 'IAM launch',
      whyItMatters: 'Matches agentic AI',
      sourceIds: [2],
    },
  ],
  snapshot: {
    whatTheyDo: 'E-signature and agreements',
    headquarters: 'San Francisco, CA',
    headcount: '~6,800',
    ownership: 'Public',
    ticker: 'docu',
    exchange: 'NASDAQ',
    fundingStage: null,
    lastFunding: null,
    sourceIds: [2],
  },
  momentum: { trend: 'Stable', summary: 'Raised FY27 guidance.', sourceIds: [1] },
  news: [
    {
      date: '2026-09-03',
      headline: 'Q2 FY27 results',
      summary: 'Beat.',
      category: 'Earnings',
      sourceIds: [1],
    },
  ],
  culture: {
    summary: 'Mixed reviews.',
    ratings: [{ site: 'Glassdoor', rating: 3.9, reviews: 4000, sourceIds: [3] }],
    pros: ['Pay'],
    cons: ['Reorgs'],
    workLifeBalance: 'Good',
    returnToOffice: '3 days/week',
    officeDaysPerWeek: 3,
    tpmOrg: null,
    sourceIds: [3],
  },
  interview: {
    process: 'Recruiter, HM, loop',
    rounds: ['Recruiter'],
    tips: ['STAR'],
    sourceIds: [],
  },
  comp: { tpmBands: null, sourceIds: [] },
  financials: { marketCap: '$14B', revenueTrend: '+7% YoY', sourceIds: [1] },
  questionsToAsk: ['How is the TPM org structured?'],
  sources: [
    {
      id: 1,
      title: 'Q2 results',
      url: 'https://investor.docusign.com/q2',
      publisher: 'DocuSign',
      date: '2026-09-03',
    },
    { id: 2, title: 'IAM', url: 'https://docusign.com/iam', publisher: 'DocuSign', date: null },
    { id: 3, title: 'Reviews', url: 'https://glassdoor.com/x', publisher: 'Glassdoor', date: null },
  ],
};
const fitResult = {
  verdict: 'Good fit',
  summary: 'ok',
  whyNotHigher: 'x',
  parts: {
    skills: { score: 8, why: 'x' },
    level: { score: 7, why: 'x' },
    logistics: { score: 9, why: 'x' },
    pay: { score: 6, why: 'x' },
    upside: { score: 7, why: 'x' },
  },
  criteria: [],
  strengths: [],
  gaps: [],
  flags: { levelMismatch: null, outreach: { recommended: false, why: '' } },
  facts: {
    officeDaysPerWeek: null,
    travelPercent: null,
    yearsRequired: null,
    employmentType: 'Full-time',
  },
  interviewFocus: [],
  talkingPoints: ['a', 'b', 'c'],
};

/** Fake provider: answers research or fit by schema; counts research calls; can fail research. */
function fakeProvider(opts: { failResearch?: boolean; delayMs?: number } = {}) {
  const calls = { research: 0, fit: 0, searches: [] as string[] };
  const provider: LLMProvider = {
    name: 'anthropic',
    defaultModel: 'claude-opus-5',
    complete: async () => '',
    async completeStructured<S extends z.ZodType>(req: StructuredRequest<S>) {
      const isResearch = req.schema === (companyResearchSchema as unknown);
      if (isResearch) {
        calls.research++;
        req.onEvent?.({ type: 'search', query: 'DocuSign layoffs 2026' });
        req.onEvent?.({ type: 'searchResults', count: 8 });
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (opts.failResearch) throw new Error('search unavailable');
        return {
          data: req.schema.parse(brief) as z.infer<S>,
          provider: 'anthropic',
          model: 'claude-opus-5',
          usage: { inputTokens: 60_000, outputTokens: 3_000, webSearches: 6 },
        };
      }
      calls.fit++;
      return {
        data: req.schema.parse(fitResult) as z.infer<S>,
        provider: 'anthropic',
        model: 'claude-opus-5',
      };
    },
  };
  return { provider, calls };
}

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
  db.insert(resumeVersions).values({ label: 'main', rawText: 'x', isDefault: true }).run();
});

const addJob = (company: string, title = 'TPM') =>
  createApplication(db, { company, title, descriptionText: 'Run programs.', status: 'Screening' });
const companyOf = (appId: number) =>
  db.$client
    .prepare(
      'SELECT j.company_id FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?',
    )
    .pluck()
    .get(appId) as number;

describe('company research', () => {
  it('validates the brief schema', () => {
    expect(companyResearchSchema.safeParse(brief).success).toBe(true);
  });

  it('is reused however old it is; only Refresh researches again', async () => {
    const { provider, calls } = fakeProvider();
    const id = addJob('DocuSign');
    const cid = companyOf(id);
    const first = await ensureResearch(db, cid, { provider });
    expect(first.reused).toBe(false);
    expect(first.research.ticker).toBe('DOCU');
    expect((await ensureResearch(db, cid, { provider })).reused).toBe(true);
    expect(calls.research).toBe(1);

    // Old briefs are only flagged, never redone automatically — even after a model change.
    const row = latestResearch(db, cid)!;
    const later = new Date(Date.parse(row.createdAt) + 30 * 86_400_000);
    expect(isStale(row, later)).toBe(true);
    expect(isStale(row)).toBe(false);
    db.$client
      .prepare(
        "UPDATE company_research SET created_at = '2020-01-01T00:00:00Z', model = 'claude-sonnet-5'",
      )
      .run();
    expect((await ensureResearch(db, cid, { provider })).reused).toBe(true);
    expect(calls.research).toBe(1);
    // Only Refresh (force) researches again.
    await ensureResearch(db, cid, { provider, force: true });
    expect(calls.research).toBe(2);
  });

  it('runs once for two jobs at the same company scored at the same time', async () => {
    const { provider, calls } = fakeProvider({ delayMs: 30 });
    const a = addJob('DocuSign', 'TPM');
    const b = addJob('DocuSign', 'Sr TPM');
    const [ra, rb] = await Promise.all([
      analyzeApplication(db, a, { provider }),
      analyzeApplication(db, b, { provider }),
    ]);
    expect(calls.research).toBe(1);
    expect(calls.fit).toBe(2);
    expect([ra.researchReused, rb.researchReused].sort()).toEqual([false, true]);
  });

  it('keeps the fit score when research fails, and logs the failed call', async () => {
    const { provider } = fakeProvider({ failResearch: true });
    const id = addJob('Acme');
    const r = await analyzeApplication(db, id, { provider });
    expect(r.fit?.assessment.overallScore).toBe(7.5);
    expect(r.researchError).toMatch(/search unavailable/);
  });

  it('the inbox batch researches each company once', async () => {
    const { provider, calls } = fakeProvider({ delayMs: 10 });
    addJob('DocuSign', 'A');
    addJob('DocuSign', 'B');
    addJob('Visa', 'C');
    startFitBatch(db, {
      status: 'Screening',
      task: (id) => analyzeApplication(db, id, { provider }),
    });
    while (fitBatchStatus()?.running) await new Promise((r) => setTimeout(r, 10));
    expect(fitBatchStatus()).toMatchObject({ total: 3, scored: 3 });
    expect(calls.research).toBe(2);
  });

  it('does not save a brief with no sources (the searches found nothing usable)', async () => {
    const provider: LLMProvider = {
      name: 'anthropic',
      defaultModel: 'claude-opus-5',
      complete: async () => '',
      async completeStructured<S extends z.ZodType>(req: StructuredRequest<S>) {
        return {
          data: req.schema.parse({ ...brief, sources: [] }) as z.infer<S>,
          provider: 'anthropic',
          model: 'claude-opus-5',
          usage: { inputTokens: 1000, outputTokens: 100, webSearches: 6 },
        };
      },
    };
    const id = addJob('Hollow');
    await expect(ensureResearch(db, companyOf(id), { provider })).rejects.toThrow(
      /no usable sources/,
    );
    expect(latestResearch(db, companyOf(id))).toBeNull();
    const err = db.$client
      .prepare("SELECT error FROM ai_usage WHERE feature = 'research'")
      .pluck()
      .get();
    expect(err).toMatch(/No sources found/);
  });

  it('records research cost including web searches', async () => {
    const { provider } = fakeProvider();
    const id = addJob('DocuSign');
    await analyzeApplication(db, id, { provider });
    const cost = db.$client
      .prepare("SELECT cost_usd FROM ai_usage WHERE feature = 'research'")
      .pluck()
      .get() as number;
    // Opus 5: 60k in × $5/M + 3k out × $25/M + 6 searches × $0.01
    expect(cost).toBeCloseTo(0.3 + 0.075 + 0.06, 6);
    expect(
      estimateCostUsd('claude-opus-5', { inputTokens: 0, outputTokens: 0, webSearches: 10 }),
    ).toBeCloseTo(0.1);
  });
});

describe('stock', () => {
  it('parses the Yahoo chart feed', () => {
    const q = parseYahooChart({
      chart: {
        result: [
          {
            meta: {
              symbol: 'DOCU',
              currency: 'USD',
              fullExchangeName: 'NasdaqGS',
              regularMarketPrice: 68.99,
              regularMarketTime: 1790280001,
              fiftyTwoWeekHigh: 83.29,
              fiftyTwoWeekLow: 40.16,
              longName: 'DocuSign, Inc.',
            },
            timestamp: [1758672000, 1759276800, 1759881600],
            indicators: { quote: [{ close: [81.52, null, 70] }] },
          },
        ],
      },
    });
    expect(q).toMatchObject({
      ticker: 'DOCU',
      price: 68.99,
      high52: 83.29,
      low52: 40.16,
      name: 'DocuSign, Inc.',
    });
    expect(q!.series).toHaveLength(2); // null closes dropped
    expect(q!.change1yPct).toBeCloseTo(((68.99 - 81.52) / 81.52) * 100, 6);
    expect(parseYahooChart({ chart: { result: [] } })).toBeNull();
  });

  it('serves the stock for a researched public company', async () => {
    const { provider } = fakeProvider();
    const id = addJob('DocuSign');
    await ensureResearch(db, companyOf(id), { provider });
    const yahoo = (async () =>
      new Response(
        JSON.stringify({
          chart: {
            result: [
              {
                meta: { symbol: 'DOCU', regularMarketPrice: 68.99 },
                timestamp: [1758672000],
                indicators: { quote: [{ close: [81.52] }] },
              },
            ],
          },
        }),
      )) as unknown as typeof fetch;
    const app = buildApp(db, { fetchFn: yahoo });
    const res = await app.inject(`/api/companies/${companyOf(id)}/stock`);
    expect(res.json()).toMatchObject({ ticker: 'DOCU', price: 68.99 });
    const r = await app.inject(`/api/companies/${companyOf(id)}/research`);
    expect(r.json()).toMatchObject({ ticker: 'DOCU', stale: false });
  });
});

describe('delete from the inbox', () => {
  it('removes the application and its job', async () => {
    const app = buildApp(db);
    const id = addJob('Tmp');
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/applications/${id}` })).statusCode,
    ).toBe(204);
    expect(db.$client.prepare('SELECT count(*) FROM jobs').pluck().get()).toBe(0);
  });
});
