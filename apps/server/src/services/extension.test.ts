import { beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { LLMProvider, StructuredRequest } from '@jm/ai';
import type { CompanyResearch } from '@jm/shared';
import { buildApp } from '../app.ts';
import { openDb, type Db } from '../db/client.ts';
import { companyResearch, profile, resumeVersions } from '../db/schema.ts';
import { createApplication } from './applications.ts';
import { assessFit } from './fit.ts';
import { companyKey, listAnswers, pageContext, similarTitles, suggestAnswer } from './extension.ts';
import { captureJob } from './screening.ts';
import { EXTENSION_ORIGIN } from './token.ts';
import type { AddressInfo } from 'node:net';

const TOKEN = 't'.repeat(48);
const offline = (async () => new Response('', { status: 404 })) as typeof fetch;

const brief = {
  flags: [
    {
      tone: 'green',
      title: 'AI agents launch',
      detail: 'IAM agents',
      whyItMatters: 'x',
      sourceIds: [1],
    },
    { tone: 'red', title: 'Layoffs in 2025', detail: '6% cut', whyItMatters: 'x', sourceIds: [1] },
  ],
  snapshot: {
    whatTheyDo: 'E-signature and agreements',
    headquarters: null,
    headcount: null,
    ownership: 'Private',
    ticker: null,
    exchange: null,
    fundingStage: 'Series F',
    lastFunding: '$1B, 2026',
    sourceIds: [],
  },
  momentum: { trend: 'Growing', summary: 'Raised guidance.', sourceIds: [] },
  news: [
    {
      date: '2026-09-03',
      headline: 'Q2 beat',
      summary: 'Up 9%.',
      category: 'Earnings',
      sourceIds: [],
    },
  ],
  culture: {
    summary: 'Mixed.',
    ratings: [{ site: 'Glassdoor', rating: 3.6, reviews: 100, sourceIds: [] }],
    pros: [],
    cons: [],
    workLifeBalance: null,
    returnToOffice: null,
    officeDaysPerWeek: 2,
    tpmOrg: null,
    sourceIds: [],
  },
  interview: { process: null, rounds: [], tips: [], sourceIds: [] },
  comp: { tpmBands: null, sourceIds: [] },
  financials: { marketCap: null, revenueTrend: null, sourceIds: [] },
  questionsToAsk: [],
  sources: [{ id: 1, title: 'x', url: 'https://example.com', publisher: null, date: null }],
} satisfies CompanyResearch;

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
  db.insert(resumeVersions)
    .values({ label: 'main', rawText: 'Led Workday agentic AI platform.', isDefault: true })
    .run();
});

const add = (
  company: string,
  title: string,
  url: string,
  status: 'Applied' | 'Screening' = 'Applied',
) =>
  createApplication(db, {
    company,
    title,
    url,
    status,
    appliedAt: '2026-09-12',
    descriptionText: 'Lead programs.',
  });
const companyIdOf = (appId: number) =>
  db.$client
    .prepare(
      'SELECT j.company_id FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?',
    )
    .pluck()
    .get(appId) as number;
const research = (companyId: number) =>
  db.insert(companyResearch).values({ companyId, model: 'claude-opus-5-5', result: brief }).run();

describe('matching helpers', () => {
  it('normalises company names', () => {
    expect(companyKey('DocuSign, Inc.')).toBe(companyKey('Docusign'));
    expect(companyKey('GitHub, Inc.')).toBe('github');
    expect(companyKey('Procter & Gamble Co.')).toBe('procter and gamble');
  });
  it('treats near-identical titles as the same role', () => {
    expect(similarTitles('Sr. Technical Program Manager', 'Senior TPM')).toBe(true);
    expect(similarTitles('Staff TPM, Payments (Remote)', 'Staff TPM - Payments')).toBe(true);
    expect(similarTitles('Staff TPM, Payments', 'Staff TPM, Identity')).toBe(false);
  });
});

describe('pageContext', () => {
  it('finds a tracked posting by its exact URL, with status, date and company brief', async () => {
    const id = add('DocuSign, Inc.', 'Sr. TPM', 'https://careers.docusign.com/jobs/30093?src=li');
    research(companyIdOf(id));
    const c = await pageContext(db, { url: 'https://careers.docusign.com/jobs/30093' });
    expect(c.tracked).toMatchObject({
      applicationId: id,
      status: 'Applied',
      appliedAt: '2026-09-12',
    });
    expect(c.company).toMatchObject({ name: 'DocuSign, Inc.' });
    expect(c.company?.brief).toMatchObject({
      green: ['AI agents launch'],
      red: ['Layoffs in 2025'],
      trend: 'Growing',
      rating: { site: 'Glassdoor', rating: 3.6 },
      officeDaysPerWeek: 2,
    });
    expect(c.costs.researchNeeded).toBe(false);
  });

  it('flags the LinkedIn copy of a posting you already applied to', async () => {
    const id = add(
      'Docusign',
      'Senior Technical Program Manager',
      'https://careers.docusign.com/jobs/1',
    );
    const c = await pageContext(db, {
      url: 'https://www.linkedin.com/jobs/view/4000000001/',
      fields: { title: 'Sr. Technical Program Manager', company: 'DocuSign, Inc.' },
    });
    expect(c.tracked).toBeNull();
    expect(c.similar.map((s) => s.applicationId)).toEqual([id]);
    expect(c.company?.name).toBe('Docusign');
  });

  it('says when and why you passed — on this posting and on its LinkedIn copy', async () => {
    const id = add(
      'OpenAI',
      'TPM, Applied Infrastructure',
      'https://www.linkedin.com/jobs/view/4461937123/',
      'Screening',
    );
    await buildApp(db, { extensionToken: TOKEN, fetchFn: offline }).inject({
      method: 'POST',
      url: `/api/applications/${id}/activities`,
      payload: {
        at: '2026-09-25',
        kind: 'Note',
        summary: "Passed: Too many -v's",
        setStatus: 'Passed',
      },
    });
    const c = await pageContext(db, {
      url: 'https://www.linkedin.com/jobs/search/?currentJobId=4461937123&keywords=tpm',
    });
    expect(c.tracked).toMatchObject({
      status: 'Passed',
      decision: { status: 'Passed', reason: "Too many -v's" },
    });
    expect(c.tracked?.decision?.at).toMatch(/^2026-09-25/);

    const copy = await pageContext(db, {
      url: 'https://openai.com/careers/tpm-applied-infrastructure',
      fields: { title: 'TPM, Applied Infrastructure', company: 'OpenAI' },
    });
    expect(copy.similar[0]).toMatchObject({
      status: 'Passed',
      decision: { reason: "Too many -v's" },
    });
  });

  it('a pass without a reason, and open applications, carry no reason', async () => {
    const id = add('Acme', 'TPM', 'https://acme.com/jobs/1', 'Screening');
    await buildApp(db, { extensionToken: TOKEN, fetchFn: offline }).inject({
      method: 'POST',
      url: `/api/applications/${id}/activities`,
      payload: {
        at: '2026-09-25',
        kind: 'Note',
        summary: 'Passed at screening',
        setStatus: 'Passed',
      },
    });
    const c = await pageContext(db, { url: 'https://acme.com/jobs/1' });
    expect(c.tracked?.decision).toMatchObject({ status: 'Passed', reason: null });
    const open = add('Acme', 'Staff TPM', 'https://acme.com/jobs/2');
    expect((await pageContext(db, { url: 'https://acme.com/jobs/2' })).tracked).toMatchObject({
      applicationId: open,
      decision: null,
    });
  });

  it('works out the company from a careers host it has seen before', async () => {
    add('Walmart', 'Distinguished TPM', 'https://careers.walmart.com/us/en/jobs/R-1');
    const c = await pageContext(db, { url: 'https://careers.walmart.com/us/en/jobs/R-2' });
    expect(c.company?.name).toBe('Walmart');
    expect(c.detected.company).toBe('Walmart');
  });

  it('but not from a job board many companies share', async () => {
    add('Acme', 'TPM', 'https://job-boards.greenhouse.io/acme/jobs/1');
    const c = await pageContext(db, { url: 'https://job-boards.greenhouse.io/globex/jobs/9' });
    expect(c.company).toBeNull();
    expect(c.detected.company).toBe('Globex');
  });

  it('reads the company from schema.org data on the page', async () => {
    add('Anthropic', 'TPM', 'https://job-boards.greenhouse.io/anthropic/jobs/1');
    const jsonLd = [
      JSON.stringify({
        '@type': 'JobPosting',
        title: 'Staff TPM',
        hiringOrganization: { name: 'Anthropic' },
      }),
    ];
    const c = await pageContext(db, { url: 'https://www.anthropic.com/careers/jobs/2', jsonLd });
    expect(c).toMatchObject({ detected: { title: 'Staff TPM', company: 'Anthropic' } });
    expect(c.company?.name).toBe('Anthropic');
  });

  it('an unknown company: no brief, and scoring would include research', async () => {
    const c = await pageContext(db, {
      url: 'https://jobs.example.org/42',
      pageTitle: 'Principal TPM - Initech Careers',
    });
    expect(c.company).toBeNull();
    expect(c.detected).toEqual({ title: 'Principal TPM', company: 'Initech' });
    expect(c.costs.researchNeeded).toBe(true);
  });
});

describe('fit score in the panel', () => {
  it('shows the latest fit as short labels, without researching the company', async () => {
    const id = add('Initech', 'Staff TPM', 'https://initech.com/jobs/7', 'Screening');
    const fit = {
      verdict: 'Good fit',
      summary: 'You fit.',
      whyNotHigher: 'Held back by 5 office days.',
      parts: {
        skills: { score: 8, why: 'x' },
        level: { score: 7, why: 'x' },
        logistics: { score: 4, why: 'x' },
        pay: { score: 6, why: 'x' },
        upside: { score: 7, why: 'x' },
      },
      criteria: [],
      strengths: [
        { label: 'Platform program depth', point: 'p', evidence: 'e' },
        { label: 'Agentic AI delivery', point: 'p', evidence: 'e' },
      ],
      gaps: [
        {
          label: 'Five office days',
          gap: 'g',
          theme: 't',
          severity: 'Major',
          knownGap: false,
          mitigation: 'm',
        },
        {
          label: 'Minor tooling gap',
          gap: 'g',
          theme: 't',
          severity: 'Minor',
          knownGap: false,
          mitigation: 'm',
        },
      ],
      flags: { levelMismatch: null, outreach: { recommended: false, why: '' } },
      facts: {
        officeDaysPerWeek: 5,
        travelPercent: null,
        yearsRequired: null,
        employmentType: 'Full-time',
      },
      interviewFocus: [],
      talkingPoints: ['a', 'b', 'c'],
    };
    let calls = 0;
    const provider: LLMProvider = {
      name: 'anthropic',
      defaultModel: 'claude-opus-5-5',
      complete: async () => '',
      async completeStructured<S extends z.ZodType>(req: StructuredRequest<S>) {
        calls++;
        return {
          data: req.schema.parse(fit) as z.infer<S>,
          provider: 'anthropic',
          model: 'claude-opus-5-5',
        };
      },
    };
    const before = await pageContext(db, { url: 'https://initech.com/jobs/7' });
    expect(before.tracked?.fit).toBeNull();

    await assessFit(db, id, { provider });
    const c = await pageContext(db, { url: 'https://initech.com/jobs/7' });
    expect(calls).toBe(1); // fit only — no research call
    expect(db.$client.prepare('SELECT count(*) FROM company_research').pluck().get()).toBe(0);
    expect(c.tracked?.fit).toMatchObject({
      verdict: 'Good fit',
      whyNotHigher: 'Held back by 5 office days.',
      strengths: ['Platform program depth', 'Agentic AI delivery'],
      gaps: ['Five office days'],
      parts: { skills: 8, logistics: 4 },
    });
    expect(c.company?.brief).toBeNull();
    expect(c.costs.researchNeeded).toBe(true);
  });
});

describe('live progress feed', () => {
  it('lets the extension read the live AI stream, and no other site', async () => {
    const app = buildApp(db, { extensionToken: TOKEN, fetchFn: offline });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const allowOrigin = async (origin: string) => {
      const ctrl = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/ai/events`, {
        headers: { origin },
        signal: ctrl.signal,
      });
      const header = res.headers.get('access-control-allow-origin');
      ctrl.abort();
      return header;
    };
    try {
      expect(await allowOrigin(EXTENSION_ORIGIN)).toBe(EXTENSION_ORIGIN);
      expect(await allowOrigin('https://evil.example')).toBeNull();
    } finally {
      app.server.closeAllConnections();
      await app.close();
    }
  });
});

describe('extension routes', () => {
  it('need the token', async () => {
    const app = buildApp(db, { extensionToken: TOKEN, fetchFn: offline });
    for (const [method, url] of [
      ['GET', '/api/ext/hello'],
      ['POST', '/api/ext/context'],
      ['GET', '/api/ext/templates/example.com'],
      ['POST', '/api/ext/answer'],
    ] as const)
      expect((await app.inject({ method, url })).statusCode).toBe(401);
    const ok = await app.inject({ url: '/api/ext/hello', headers: { 'x-jm-token': TOKEN } });
    expect(ok.json()).toEqual({ ok: true, app: 'job-matrix' });
  });

  it('save a site template and hand it back with the page context', async () => {
    const app = buildApp(db, { extensionToken: TOKEN, fetchFn: offline });
    const headers = { 'x-jm-token': TOKEN };
    const put = await app.inject({
      method: 'PUT',
      url: '/api/ext/templates/Jobs.Example.org',
      headers,
      payload: { name: 'Example jobs', selectors: { title: 'h1.job', description: '#jd' } },
    });
    expect(put.statusCode).toBe(200);
    const c = await app.inject({
      method: 'POST',
      url: '/api/ext/context',
      headers,
      payload: { url: 'https://jobs.example.org/42' },
    });
    expect(c.json().template).toMatchObject({
      host: 'jobs.example.org',
      name: 'Example jobs',
      selectors: { title: 'h1.job', description: '#jd' },
    });
  });

  it('capture uses the fields a template read', async () => {
    const r = await captureJob(
      db,
      {
        url: 'https://jobs.example.org/42',
        templateName: 'Example jobs',
        fields: {
          title: 'Staff TPM',
          company: 'Initech',
          descriptionText: 'Lead the platform program across teams. '.repeat(4),
        },
      },
      { fetchFn: offline },
    );
    expect(r).toMatchObject({
      title: 'Staff TPM',
      company: 'Initech',
      descriptionSource: 'Example jobs template',
    });
  });
});

describe('application answers', () => {
  function fakeProvider() {
    const prompts: string[] = [];
    const provider: LLMProvider = {
      name: 'anthropic',
      defaultModel: 'claude-opus-5-5',
      complete: async () => '',
      async completeStructured<S extends z.ZodType>(req: StructuredRequest<S>) {
        prompts.push(`${req.system}\n${req.prompt}`);
        return {
          data: req.schema.parse({
            answer:
              'I led an agentic AI platform at Workday, and your IAM agents launch is the same bet.',
            basedOn: 'Workday agentic AI + their AI agents launch',
          }) as z.infer<S>,
          provider: 'anthropic',
          model: 'claude-opus-5-5',
          usage: { inputTokens: 10_000, outputTokens: 400 },
        };
      },
    };
    return { provider, prompts };
  }

  it('drafts from the resume, the job and the brief; saves it and records the cost', async () => {
    db.insert(profile).values({ id: 1, goals: 'Principal TPM, AI platforms' }).run();
    const id = add('Docusign', 'Sr. TPM', 'https://careers.docusign.com/jobs/1');
    research(companyIdOf(id));
    const { provider, prompts } = fakeProvider();
    const a = await suggestAnswer(
      db,
      { applicationId: id, question: 'Why do you want to work at Docusign?', maxLength: 60 },
      { provider },
    );
    expect(prompts[0]).toContain('Led Workday agentic AI platform.');
    expect(prompts[0]).toContain('Lead programs.');
    expect(prompts[0]).toContain('AI agents launch');
    expect(prompts[0]).toContain('Principal TPM, AI platforms');
    expect(prompts[0]).toContain('<character_limit>60</character_limit>');
    expect(a.answer.length).toBeLessThanOrEqual(60);
    expect(listAnswers(db, id)).toHaveLength(1);
    const usage = db.$client
      .prepare("SELECT feature, company_id, cost_usd FROM ai_usage WHERE feature = 'answer'")
      .get() as { feature: string; company_id: number; cost_usd: number };
    expect(usage.company_id).toBe(companyIdOf(id));
    expect(usage.cost_usd).toBeCloseTo((10_000 * 4 + 400 * 20) / 1e6);
  });
});
