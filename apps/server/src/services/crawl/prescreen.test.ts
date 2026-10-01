import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { RateLimitError, LLMError, type LLMProvider, type StructuredRequest } from '@jm/ai';
import { buildApp } from '../../app.ts';
import { openDb, type Db } from '../../db/client.ts';
import { aiUsage, crawlLeads, resumeVersions } from '../../db/schema.ts';
import { createApplication, getApplicationDetail, listApplications } from '../applications.ts';
import { updateProfile } from '../resume.ts';
import { getSettings } from '../settings.ts';
import { buildPrescreenPrompt, type PrescreenResult } from './prescreen.ts';
import { runCrawl, searchProgress, stopCrawlSchedule } from './run.ts';
import { fakeWeb } from './testWeb.ts';
import { addSearch, addSource, listFiltered } from './watchlist.ts';

type Answer = PrescreenResult | Error;

/** A fake pre-screen model: answers by job title (or throws), and records what it was asked. */
function fakeScreener(answers: (title: string, call: number) => Answer) {
  const prompts: string[] = [];
  const provider: LLMProvider = {
    name: 'Fake',
    defaultModel: 'fake-small',
    complete: async () => '',
    async completeStructured<S extends z.ZodType>(req: StructuredRequest<S>) {
      prompts.push(req.prompt);
      const title = req.prompt.match(/^Title: (.+)$/m)![1]!;
      const a = answers(title, prompts.length);
      if (a instanceof Error) throw a;
      return {
        data: req.schema.parse(a) as z.infer<S>,
        provider: 'Fake',
        model: 'fake-small',
        usage: { inputTokens: 900, outputTokens: 40 },
      };
    },
  };
  return { screener: { provider, model: 'fake-small' }, prompts };
}

const yes: PrescreenResult = { verdict: 'yes', reason: 'Infra TPM role in SF', dealBreaker: null };
const maybe: PrescreenResult = {
  verdict: 'maybe',
  reason: 'Office days not stated',
  dealBreaker: null,
};
const no: PrescreenResult = {
  verdict: 'no',
  reason: 'A policy program role, not technical program management',
  dealBreaker: 'Pure coordination/PMO',
};

let db: Db;
const saved = { ...process.env };
beforeEach(() => {
  db = openDb(':memory:');
  updateProfile(db, {
    goals: 'Principal TPM, platform and AI infrastructure.',
    minBase: 200_000,
    mustHaves: 'Remote or hybrid',
    dealBreakers: 'Contract roles\nPure coordination/PMO',
  });
  db.insert(resumeVersions)
    .values({ label: 'r', rawText: 'RESUME-SECRET-TEXT', isDefault: true })
    .run();
});
afterEach(() => {
  stopCrawlSchedule();
  process.env = { ...saved };
});

const inbox = () =>
  listApplications(db)
    .filter((a) => a.status === 'Screening')
    .map((a) => a.title)
    .sort();
const verdicts = () =>
  Object.fromEntries(
    db
      .select()
      .from(crawlLeads)
      .all()
      .map((l) => [l.title, l.verdict]),
  );
const fast = { prescreenGapMs: 0, sleep: async () => {} };

/** Anthropic's fake board with a London filter lifted, so three jobs reach the pre-screen. */
async function follow(f = fakeWeb()) {
  await addSource(db, { url: 'https://job-boards.greenhouse.io/anthropic' }, { fetchFn: f });
  return f;
}

describe('the prompt', () => {
  it('carries the posting and your criteria, and never the resume', () => {
    const prompt = buildPrescreenPrompt(db, {
      company: 'Acme',
      title: 'Staff TPM',
      location: 'San Francisco, CA',
      remoteType: 'Hybrid',
      salaryMin: 250_000,
      salaryMax: 300_000,
      descriptionText: 'x'.repeat(9000),
    });
    expect(prompt).toContain('Company: Acme');
    expect(prompt).toContain('Location: San Francisco, CA (Hybrid)');
    expect(prompt).toContain('Pay: $250,000 - $300,000');
    expect(prompt).toContain('Principal TPM, platform and AI infrastructure.');
    expect(prompt).toContain('<minimum_base_salary>$200,000</minimum_base_salary>');
    expect(prompt).toContain('- Pure coordination/PMO');
    expect(prompt).not.toContain('RESUME-SECRET-TEXT');
    expect(prompt.length).toBeLessThan(6500); // the description is cut
  });
});

describe('checking the watchlist with a pre-screen', () => {
  it('yes and maybe go to the inbox with the reason; no is kept out with it', async () => {
    const f = await follow();
    const { screener, prompts } = fakeScreener((title) =>
      /Compute/.test(title) ? yes : /Finance/.test(title) ? maybe : no,
    );
    // Lift the pay floor so the Finance job reaches the model too.
    updateProfile(db, { minBase: 100_000 });
    const r = await runCrawl(db, { fetchFn: f, prescreen: screener, ...fast });

    // Rules first: the intern and the London job never reach the model.
    expect(prompts).toHaveLength(2);
    expect(r).toMatchObject({ matched: 4, screened: 2, added: 2, filtered: 2, waiting: 0 });
    expect(verdicts()).toEqual({
      'Staff Technical Program Manager, Compute': 'yes',
      'Technical Program Manager, Finance Systems': 'maybe',
      'Senior Program Manager, Policy': 'no-rules',
      'Program Manager Intern': 'no-rules',
    });
    const app = listApplications(db).find((a) => /Compute/.test(a.title))!;
    expect(getApplicationDetail(db, app.id).activities.map((a) => a.summary)).toContain(
      "Found on Anthropic's Greenhouse job board (watchlist). Pre-screen (fake-small): yes — Infra TPM role in SF",
    );
    // Each call is on the AI usage page, under its own heading, at no known cost.
    const usage = db.select().from(aiUsage).all();
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({ feature: 'prescreen', model: 'fake-small', costUsd: null });
  });

  it('a "no" is listed under Filtered out with the model’s reason, and can be added anyway', async () => {
    const f = await follow();
    const { screener } = fakeScreener(() => no);
    const app = buildApp(db, { fetchFn: f, crawl: { prescreen: screener, ...fast } });
    await runCrawl(db, { fetchFn: f, prescreen: screener, ...fast });
    expect(inbox()).toEqual([]);
    const lead = listFiltered(db).find((l) => l.verdict === 'no-ai')!;
    expect(lead).toMatchObject({
      title: 'Staff Technical Program Manager, Compute',
      reason: 'A policy program role, not technical program management',
      model: 'fake-small',
    });
    expect(lead.usageId).toBeGreaterThan(0);
    const status = (await app.inject({ url: '/api/crawl/status' })).json();
    expect(status.prescreen).toEqual({ label: 'Fake', model: 'fake-small' });
    await app.inject({ method: 'POST', url: `/api/crawl/leads/${lead.id}/add` });
    expect(inbox()).toEqual(['Staff Technical Program Manager, Compute']);
  });

  it('asks about each job once: a second check makes no calls', async () => {
    const f = await follow();
    const { screener, prompts } = fakeScreener(() => no);
    await runCrawl(db, { fetchFn: f, prescreen: screener, ...fast });
    await runCrawl(db, { fetchFn: f, prescreen: screener, ...fast });
    expect(prompts).toHaveLength(1);
  });

  it('a rate limit leaves the rest waiting, and the next check picks them up', async () => {
    const f = await follow();
    updateProfile(db, { minBase: 100_000 });
    const limited = fakeScreener((_t, call) =>
      call === 1 ? yes : new RateLimitError('Groq rate limit reached: daily limit', null),
    );
    const r = await runCrawl(db, { fetchFn: f, prescreen: limited.screener, ...fast });
    expect(r).toMatchObject({ screened: 1, added: 1, waiting: 1 });
    expect(verdicts()['Technical Program Manager, Finance Systems']).toBe('waiting');
    expect(listFiltered(db).find((l) => l.verdict === 'waiting')!.reason).toBe(
      'Pre-screen paused until the next check: Groq rate limit reached: daily limit',
    );
    expect(inbox()).toHaveLength(1); // nothing reaches the inbox unscreened, and nothing is paid for

    const later = fakeScreener(() => maybe);
    const again = await runCrawl(db, { fetchFn: f, prescreen: later.screener, ...fast });
    expect(later.prompts).toHaveLength(1); // only the waiting one
    expect(again).toMatchObject({ added: 1, waiting: 0 });
    expect(inbox()).toHaveLength(2);
  });

  it('a short "slow down" is waited out and the job asked again', async () => {
    const f = await follow();
    const waits: number[] = [];
    const { screener, prompts } = fakeScreener((_t, call) =>
      call === 1 ? new RateLimitError('slow down', 6) : yes,
    );
    const r = await runCrawl(db, {
      fetchFn: f,
      prescreen: screener,
      prescreenGapMs: 0,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(waits).toContain(6000);
    expect(prompts).toHaveLength(2);
    expect(r).toMatchObject({ added: 1, waiting: 0 });
  });

  it('a broken set-up stops after three failures instead of hammering the service', async () => {
    const f = fakeWeb();
    await addSource(db, { url: 'https://jobs.ashbyhq.com/openai' }, { fetchFn: f });
    await follow(f);
    updateProfile(db, { minBase: 100_000 });
    const { screener, prompts } = fakeScreener(
      () => new LLMError('Groq API error 401: Invalid API Key'),
    );
    const r = await runCrawl(db, { fetchFn: f, prescreen: screener, ...fast });
    expect(prompts).toHaveLength(3);
    expect(r).toMatchObject({ added: 0, waiting: 3 });
    expect(inbox()).toEqual([]);
  });

  it('Workday: the posting is read for the model, since the board lists titles only', async () => {
    const f = fakeWeb();
    await addSource(
      db,
      {
        url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite',
        companyName: 'NVIDIA',
      },
      { fetchFn: f },
    );
    const { screener, prompts } = fakeScreener(() => yes);
    await runCrawl(db, { fetchFn: f, prescreen: screener, ...fast });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('lead programs across teams');
  });

  it('with the pre-screen off, jobs that pass the rules go straight in', async () => {
    const f = await follow();
    const r = await runCrawl(db, { fetchFn: f, prescreen: null });
    expect(r).toMatchObject({ screened: 0, added: 1 });
    expect(verdicts()['Staff Technical Program Manager, Compute']).toBe('yes');
  });
});

describe('a saved search being sorted', () => {
  it('says which job the pre-screen is on, for the side panel, and clears when done', async () => {
    const seen: string[] = [];
    const { screener } = fakeScreener((title) => {
      const [p] = searchProgress();
      seen.push(`${p!.checking}/${p!.matched} +${p!.added} -${p!.filtered}`);
      return title.includes('Policy') ? no : yes;
    });
    const token = 't'.repeat(48);
    const app = buildApp(db, {
      extensionToken: token,
      fetchFn: fakeWeb(),
      crawl: { prescreen: screener, prescreenGapMs: 0 },
    });
    const s = addSearch(db, {
      url: 'https://www.ziprecruiter.com/jobs-search?search=technical+program+manager&location=San+Francisco%2C+CA',
    });
    const listing = (n: number, title: string) => ({
      url: `https://www.ziprecruiter.com/jobs-search?lk=${n}`,
      title,
      company: `Co ${n}`,
      location: 'San Francisco, CA',
      snippet: 'Lead programs across teams.',
    });
    const r = await app.inject({
      method: 'POST',
      url: `/api/crawl/searches/${s.id}/results`,
      headers: { 'x-jm-token': token },
      payload: {
        listings: [
          listing(1, 'Staff Technical Program Manager'),
          listing(2, 'Senior Program Manager, Policy'),
          listing(3, 'Technical Program Manager, Infra'),
        ],
      },
    });
    expect(r.json()).toMatchObject({ matched: 3, added: 2, filtered: 1 });
    expect(seen).toEqual(['1/3 +0 -0', '2/3 +1 -0', '3/3 +1 -1']);
    expect(searchProgress()).toEqual([]);
    const status = (await app.inject({ url: '/api/crawl/status' })).json();
    expect(status.searching).toEqual([]);
  });
});

describe('pre-screen settings', () => {
  it('off by default; a provider is ready once it has what it needs', () => {
    delete process.env.PRESCREEN_PROVIDER;
    delete process.env.PRESCREEN_API_KEY;
    delete process.env.PRESCREEN_MODEL;
    delete process.env.PRESCREEN_BASE_URL;
    expect(getSettings().prescreen).toMatchObject({ provider: 'off', ready: false });

    process.env.PRESCREEN_PROVIDER = 'groq';
    expect(getSettings().prescreen).toMatchObject({
      provider: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'openai/gpt-oss-120b',
      ready: false,
      apiKeyHint: null,
    });
    process.env.PRESCREEN_API_KEY = 'gsk_secret_abcd';
    const s = getSettings().prescreen;
    expect(s).toMatchObject({ ready: true, apiKeyHint: '…abcd' });
    expect(JSON.stringify(s)).not.toContain('gsk_secret');

    process.env.PRESCREEN_PROVIDER = 'ollama';
    delete process.env.PRESCREEN_API_KEY;
    process.env.PRESCREEN_MODEL = 'llama3.2';
    expect(getSettings().prescreen).toMatchObject({
      ready: true,
      model: 'llama3.2',
      baseUrl: 'http://localhost:11434/v1',
    });
  });
});

describe('telling watchlist jobs apart in the inbox', () => {
  it('each row says where the watchlist found it and what the pre-screen said', async () => {
    const f = await follow();
    updateProfile(db, { minBase: 100_000 });
    const { screener } = fakeScreener((title) =>
      /Compute/.test(title) ? { ...yes, score: 8.46 } : maybe,
    );
    await runCrawl(db, { fetchFn: f, prescreen: screener, ...fast });
    createApplication(db, { company: 'Acme', title: 'TPM I added', status: 'Screening' });

    const rows = Object.fromEntries(
      listApplications(db).map((a) => [
        a.title,
        [a.foundBy, a.prescreenVerdict, a.prescreenScore, a.prescreenReason, a.prescreenModel],
      ]),
    );
    expect(rows).toEqual({
      'Staff Technical Program Manager, Compute': [
        'Anthropic board',
        'yes',
        8.5,
        'Infra TPM role in SF',
        'fake-small',
      ],
      'Technical Program Manager, Finance Systems': [
        'Anthropic board',
        'maybe',
        null,
        'Office days not stated',
        'fake-small',
      ],
      'TPM I added': [null, null, null, null, null],
    });
  });

  it('without a pre-screen, only where it was found', async () => {
    const f = await follow();
    await runCrawl(db, { fetchFn: f, prescreen: null });
    const row = listApplications(db).find((a) => /Compute/.test(a.title))!;
    expect(row).toMatchObject({
      foundBy: 'Anthropic board',
      prescreenVerdict: null,
      prescreenScore: null,
    });
  });
});

describe('pre-screening a job you added, before a paid score', () => {
  const jd = 'You will lead programs across teams, plan the work and ship it on time. '.repeat(5);
  const addJob = () =>
    createApplication(db, {
      company: 'Acme',
      title: 'Staff TPM, Infrastructure',
      status: 'Screening',
      descriptionText: jd,
    });

  it('asks the model once, keeps the answer, notes it on the timeline and records the call', async () => {
    const id = addJob();
    const { screener, prompts } = fakeScreener(() => ({ ...yes, score: 7.25 }));
    const app = buildApp(db, { crawl: { prescreen: screener } });
    const r = await app.inject({ method: 'POST', url: `/api/applications/${id}/prescreen` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ verdict: 'yes', score: 7.3, model: 'fake-small' });
    expect(prompts[0]).toContain('Title: Staff TPM, Infrastructure');
    expect(prompts[0]).toContain('lead programs across teams');

    const row = listApplications(db).find((a) => a.id === id)!;
    expect(row).toMatchObject({
      foundBy: null,
      prescreenVerdict: 'yes',
      prescreenScore: 7.3,
      prescreenReason: 'Infra TPM role in SF',
    });
    expect(getApplicationDetail(db, id).activities.map((a) => a.summary)).toContain(
      'Pre-screen (fake-small): yes, 7.3/10 — Infra TPM role in SF',
    );
    expect(db.select().from(aiUsage).all()[0]).toMatchObject({
      feature: 'prescreen',
      applicationId: id,
    });
  });

  it('a "no" is shown too; asking again replaces what is shown', async () => {
    const id = addJob();
    let answer: Answer = no;
    const { screener } = fakeScreener(() => answer);
    const app = buildApp(db, { crawl: { prescreen: screener } });
    await app.inject({ method: 'POST', url: `/api/applications/${id}/prescreen` });
    expect(listApplications(db).find((a) => a.id === id)!.prescreenVerdict).toBe('no');
    answer = maybe;
    await app.inject({ method: 'POST', url: `/api/applications/${id}/prescreen` });
    expect(listApplications(db).find((a) => a.id === id)!.prescreenVerdict).toBe('maybe');
  });

  it('says how to set it up when no model is chosen, and how long to wait on a rate limit', async () => {
    const id = addJob();
    const off = buildApp(db, { crawl: { prescreen: null } });
    const r = await off.inject({ method: 'POST', url: `/api/applications/${id}/prescreen` });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatch(/No pre-screen model is set up yet/);

    const limited = fakeScreener(() => new RateLimitError('Groq rate limit reached: TPM', 20));
    const busy = buildApp(db, { crawl: { prescreen: limited.screener } });
    const b = await busy.inject({ method: 'POST', url: `/api/applications/${id}/prescreen` });
    expect(b.statusCode).toBe(429);
    expect(b.json().error).toMatch(/Groq rate limit reached: TPM\. Try again in a minute\./);
  });
});
