import { beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { LLMProvider, StructuredRequest } from '@jm/ai';
import {
  agencyEmailSignals,
  clientGuessSchema,
  isAgencyCompany,
  isListedAgency,
  namedAfterSender,
  type ClientGuess,
} from '@jm/shared';
import { buildApp } from '../../app.ts';
import { openDb, type Db } from '../../db/client.ts';
import { aiUsage, applications, crawlSources, mailLeads } from '../../db/schema.ts';
import { createApplication, getApplicationDetail, listApplications } from '../applications.ts';
import { fakeWeb } from '../crawl/testWeb.ts';
import { cluesFromText, copiedShare } from './clues.ts';
import { checkDirect, roleTitle } from './direct.ts';
import {
  addManualClient,
  adoptDirect,
  clientState,
  dismissClient,
  mergeCandidates,
} from './index.ts';
import { findClient } from './lookup.ts';

/** The client's own description, as its board would have it. */
const CLIENT_JD = `About the team: the Compute Platform group builds the fleet scheduler that places every
training run across our clusters. As Staff TPM you will own the capacity roadmap for accelerator
fleets, run the weekly capacity council with research and infrastructure leads, and land the
migration of training jobs onto the new scheduler before the next model generation ships. You have
led multi-quarter infrastructure programs with hard hardware dependencies and can explain power,
cooling and supply constraints to researchers.`;

const AGENCY_EMAIL = `Hi Dave,

Our client, a fast-growing AI research company in San Francisco, is hiring a Staff TPM.
Fortune 500 partners, 2,000+ employees.
Location: San Francisco, CA (hybrid)

${CLIENT_JD}

Pay: $95/hr W2.

Thanks,
Jane`;

const GH_BOARD = 'https://job-boards.greenhouse.io/anthropic';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

const agencyLead = (company = 'Teksystems', title = 'Staff TPM - Compute (Contract, Remote)') =>
  createApplication(db, {
    company,
    title,
    descriptionText: AGENCY_EMAIL,
    status: 'Screening',
  });

const rowOf = (id: number) => listApplications(db).find((r) => r.id === id)!;

describe('spotting a staffing agency', () => {
  it('knows the common firms, however the name arrives', () => {
    for (const n of [
      'TEKsystems',
      'Teksystems', // from jane@teksystems.com
      'Robert Half Technology',
      'Roberthalf',
      'Insight Global, LLC',
      'Bay Area Staffing',
      'Acme Recruiting',
      'Kelly Services',
    ])
      expect(isListedAgency(n), n).toBe(true);
    for (const n of ['Anthropic', 'Kelly-Moore Paints', 'Judge.me', 'Volta', 'Haystack'])
      expect(isListedAgency(n), n).toBe(false);
  });

  it('lets your setting win over the list', () => {
    expect(isAgencyCompany({ name: 'TEKsystems', isAgency: false })).toBe(false);
    expect(isAgencyCompany({ name: 'Acme Talent', isAgency: true })).toBe(true);
    expect(isAgencyCompany({ name: 'Acme Talent', isAgency: null })).toBe(false);
  });

  it('reads a small vendor from its email', () => {
    expect(namedAfterSender('Itech-us', 'jo@itech-us.com')).toBe(true);
    expect(namedAfterSender('Acme', 'jo@mail.acme.co.uk')).toBe(true);
    expect(namedAfterSender('Contoso', 'jo@itech-us.com')).toBe(false);
    expect(namedAfterSender('Acme', null)).toBe(false);
    const vendor = 'Duration: 12 months\nRate: $85/hr on W2. Please share your updated resume.';
    expect(agencyEmailSignals(vendor)).toBe(4);
    expect(agencyEmailSignals('Hi, I lead recruiting for our platform team.')).toBe(0);
    // Named after the sender + one signal; an in-house recruiter talks neither W2 nor clients.
    const lead = (text: string) => ({ text, fromAddr: 'jo@itech-us.com' });
    expect(isAgencyCompany({ name: 'Itech-us' }, lead('Duration: Full Time'))).toBe(true);
    expect(isAgencyCompany({ name: 'Itech-us' }, lead('We are hiring a TPM.'))).toBe(false);
    expect(isAgencyCompany({ name: 'Contoso' }, lead('Duration: 6 months, W2 only'))).toBe(true);
    expect(isAgencyCompany({ name: 'Itech-us', isAgency: false }, lead(vendor))).toBe(false);
  });

  it('flags a lead by its email on inbox rows', () => {
    const id = createApplication(db, {
      company: 'Itech-us',
      title: 'Vendor Program Manager',
      descriptionText: 'Please share suitable profiles for the position below.',
      status: 'Screening',
    });
    expect(rowOf(id).isAgency).toBe(false);
    db.insert(mailLeads)
      .values({
        internetMessageId: '<a@mail>',
        messageId: 'a',
        receivedAt: '2026-10-20T10:00:00Z',
        fromAddr: 'raj@itech-us.com',
        subject: 'Vendor Program Manager',
        applicationId: id,
      })
      .run();
    expect(rowOf(id).isAgency).toBe(true);
    expect(clientState(db, id).isAgency).toBe(true);
  });

  it('shows on inbox rows', () => {
    const id = agencyLead();
    expect(rowOf(id)).toMatchObject({ isAgency: true, client: null });
  });
});

describe('free clues', () => {
  it('reads what the email says about the client', () => {
    const clues = cluesFromText(AGENCY_EMAIL);
    expect(clues[0]).toMatch(/^Our client, a fast-growing AI research company/);
    expect(clues).toContain('Fortune 500 partners, 2,000+ employees.');
    expect(clues).toContain('Location: San Francisco, CA (hybrid)');
    expect(cluesFromText(null)).toEqual([]);
  });

  it('strips what agencies add to a title', () => {
    expect(roleTitle('Staff TPM - Compute (Contract, Remote)')).toBe('Staff TPM');
    expect(roleTitle('Senior Technical Program Manager [W2 only]')).toBe(
      'Senior Technical Program Manager',
    );
    expect(roleTitle('Contract')).toBe('Contract');
  });

  it('finds the tracked job whose description the email copies', () => {
    const direct = createApplication(db, {
      company: 'Anthropic',
      title: 'Staff Technical Program Manager, Compute',
      url: `${GH_BOARD}/jobs/101`,
      descriptionText: CLIENT_JD,
      status: 'Screening',
    });
    // Another agency's copy is not a client.
    createApplication(db, {
      company: 'Insight Global',
      title: 'TPM',
      descriptionText: CLIENT_JD,
      status: 'Screening',
    });
    const id = agencyLead();
    expect(copiedShare(AGENCY_EMAIL, CLIENT_JD)).toBeGreaterThan(0.4);
    // The same Safe Links address in two emails isn't shared wording.
    const link =
      'https://na01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fx.example%2Fa&data=05%7C02';
    expect(copiedShare(`Apply here ${link} today`, `Read more ${link} now`)).toBe(0);
    const { lookup } = clientState(db, id);
    expect(lookup.result.candidates).toHaveLength(1);
    expect(lookup.result.candidates[0]).toMatchObject({
      company: 'Anthropic',
      confidence: 'high',
      via: 'clues',
      direct: { status: 'match', matches: [{ applicationId: direct }] },
    });
    expect(rowOf(id).client).toMatchObject({ company: 'Anthropic', direct: 'match' });
    // Looking again saves nothing new.
    const again = clientState(db, id);
    expect(again.lookup.id).toBe(lookup.id);
  });
});

describe("checking the client's own board", () => {
  it('finds a similar role from a careers address', async () => {
    const d = await checkDirect(
      db,
      'Anthropic',
      GH_BOARD,
      { title: 'Staff TPM - Compute (Contract)' },
      fakeWeb(),
    );
    expect(d.status).toBe('match');
    expect(d.boardUrl).toBe(GH_BOARD);
    expect(d.matches[0]).toMatchObject({ title: 'Staff Technical Program Manager, Compute' });
    expect(d.matches.every((m) => m.overlap >= 0.5)).toBe(true);
  });

  it('counts a posting the email copies, whatever its title', async () => {
    // The fake board's postings all share this text.
    const text = 'You will lead programs across teams, plan the work and ship it on time. '.repeat(
      5,
    );
    const d = await checkDirect(db, 'Anthropic', GH_BOARD, { title: 'Director', text }, fakeWeb());
    expect(d.status).toBe('match');
    expect(d.matches[0]!.copied).toBeGreaterThan(0.9);
    expect(d.matches[0]!.overlap).toBe(0);
  });

  it("uses the watchlist's board for a company you watch", async () => {
    db.insert(crawlSources)
      .values({
        kind: 'greenhouse',
        companyName: 'Anthropic, Inc.',
        slug: 'anthropic',
        boardUrl: GH_BOARD,
      })
      .run();
    const d = await checkDirect(db, 'Anthropic', null, { title: 'Staff TPM' }, fakeWeb());
    expect(d.status).toBe('match');
  });

  it('says when nothing similar is posted, or no board is known', async () => {
    const none = await checkDirect(
      db,
      'Anthropic',
      GH_BOARD,
      { title: 'Director of Sales' },
      fakeWeb(),
    );
    expect(none).toMatchObject({ status: 'none', matches: [] });
    expect(none.note).toMatch(/open roles on their board/);
    expect(await checkDirect(db, 'Nobody', null, { title: 'TPM' }, fakeWeb())).toMatchObject({
      status: 'no_board',
    });
    const page = await checkDirect(
      db,
      'Nothing',
      'https://www.nothing.example/careers',
      { title: 'TPM' },
      fakeWeb(),
    );
    expect(page.status).toBe('no_board');
    expect(page.note).toMatch(/Couldn't find/);
  });
});

describe('candidates', () => {
  it('folds a company found twice into one, a direct role first', () => {
    const merged = mergeCandidates(
      [
        { company: 'Contoso', confidence: 'low', via: 'clues', evidence: [{ text: 'a' }] },
        { company: 'Anthropic', confidence: 'medium', via: 'clues', evidence: [{ text: 'b' }] },
      ],
      [
        {
          company: 'Anthropic, Inc.',
          confidence: 'high',
          via: 'ai',
          evidence: [{ text: 'b' }, { text: 'c' }],
          direct: { checkedAt: 'x', status: 'match', boardUrl: null, matches: [] },
        },
      ],
    );
    expect(merged.map((c) => c.company)).toEqual(['Anthropic', 'Contoso']);
    expect(merged[0]).toMatchObject({ confidence: 'high', via: 'clues' });
    expect(merged[0]!.evidence.map((e) => e.text)).toEqual(['b', 'c']);
  });

  it('adds one you name, checks its board, and drops one that is not it', async () => {
    const id = agencyLead();
    const s = await addManualClient(
      db,
      id,
      { company: 'Anthropic', careersUrl: GH_BOARD },
      fakeWeb(),
    );
    expect(s.lookup.source).toBe('manual');
    expect(s.lookup.result.candidates[0]).toMatchObject({
      company: 'Anthropic',
      via: 'manual',
      direct: { status: 'match' },
    });
    expect(dismissClient(db, id, 'anthropic').lookup.result.candidates).toEqual([]);
  });
});

/** Fake model: names the clients given, counting calls. */
function fakeProvider(guess: ClientGuess) {
  const calls = { n: 0, prompts: [] as string[] };
  const provider: LLMProvider = {
    name: 'anthropic',
    defaultModel: 'claude-sonnet-5-5',
    complete: async () => '',
    async completeStructured<S extends z.ZodType>(req: StructuredRequest<S>) {
      calls.n++;
      calls.prompts.push(req.prompt);
      expect(req.schema).toBe(clientGuessSchema);
      expect(req.webSearch?.maxUses).toBe(5);
      // It's told to spend the whole budget, angle by angle, before giving up.
      expect(req.system).toContain('you have 5 searches — use them all');
      expect(req.system).toContain('only if all 5 searches turned up nothing');
      req.onEvent?.({ type: 'search', query: '"fleet scheduler" "capacity council"' });
      return {
        data: req.schema.parse(guess) as z.infer<S>,
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        usage: { inputTokens: 40_000, outputTokens: 1_000, webSearches: 3 },
      };
    },
  };
  return { provider, calls };
}

const GUESS: ClientGuess = {
  candidates: [
    {
      company: 'Anthropic',
      confidence: 'high',
      evidence: [{ text: 'Same wording on its Greenhouse posting.', url: `${GH_BOARD}/jobs/101` }],
      careersUrl: GH_BOARD,
    },
  ],
  notes: 'Exact phrase match.',
};

describe('Find client (paid)', () => {
  it('runs once per job, checks the boards, and logs the cost', async () => {
    const id = agencyLead();
    const { provider, calls } = fakeProvider(GUESS);
    const s = await findClient(db, id, { provider, fetchFn: fakeWeb() });
    expect(calls.n).toBe(1);
    expect(calls.prompts[0]).toContain('Agency: Teksystems');
    expect(calls.prompts[0]).toContain('Our client, a fast-growing AI research company');
    expect(s.lookup).toMatchObject({ source: 'ai', model: 'claude-sonnet-5-5' });
    expect(s.lookup.costUsd).toBeGreaterThan(0);
    expect(s.lookup.result.notes).toBe('Exact phrase match.');
    expect(s.lookup.result.candidates[0]).toMatchObject({
      company: 'Anthropic',
      via: 'ai',
      direct: { status: 'match' },
    });
    const usage = db.select().from(aiUsage).all();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ feature: 'client', applicationId: id });

    // Cached: no second call unless forced.
    await findClient(db, id, { provider, fetchFn: fakeWeb() });
    expect(calls.n).toBe(1);
    await findClient(db, id, { provider, fetchFn: fakeWeb(), force: true });
    expect(calls.n).toBe(2);
  });
});

describe('applying direct', () => {
  it("adds the client's posting and passes the agency's lead", async () => {
    const id = agencyLead();
    const s = await addManualClient(
      db,
      id,
      { company: 'Anthropic', careersUrl: GH_BOARD },
      fakeWeb(),
    );
    const url = s.lookup.result.candidates[0]!.direct!.matches[0]!.url;
    const r = await adoptDirect(db, id, { url, company: 'Anthropic' }, fakeWeb());
    expect(r).toMatchObject({ existing: false, company: 'Anthropic' });
    const agency = getApplicationDetail(db, id);
    expect(agency.application.status).toBe('Passed');
    expect(agency.activities.at(-1)!.summary).toMatch(
      /^Passed: Duplicate — applying direct at Anthropic/,
    );
    const direct = getApplicationDetail(db, r.applicationId);
    expect(direct.application.status).toBe('Screening');
    expect(direct.activities.at(-1)!.summary).toMatch(/Also pitched by Teksystems/);
    // That posting is now tracked, so the board check says so.
    const again = await addManualClient(
      db,
      id,
      { company: 'Anthropic', careersUrl: GH_BOARD },
      fakeWeb(),
    );
    expect(again.lookup.result.candidates[0]!.direct!.matches[0]!.applicationId).toBe(
      r.applicationId,
    );
  });

  it("won't switch a job to itself", async () => {
    const id = createApplication(db, {
      company: 'Anthropic',
      title: 'Staff TPM',
      url: `${GH_BOARD}/jobs/101`,
      status: 'Screening',
    });
    await expect(
      adoptDirect(db, id, { url: `${GH_BOARD}/jobs/101`, company: 'Anthropic' }, fakeWeb()),
    ).rejects.toThrow(/this job itself/);
  });
});

describe('client routes', () => {
  it('serves the panel and the agency toggle', async () => {
    const id = agencyLead();
    const app = buildApp(db, { fetchFn: fakeWeb() });
    const res = await app.inject(`/api/applications/${id}/client`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ isAgency: true, aiDone: false, model: 'claude-sonnet-5-5' });
    expect(body.estimateUsd).toBeGreaterThan(0);
    expect(body.lookup.result.clues.length).toBeGreaterThan(0);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/companies/${body.companyId}`,
      payload: { isAgency: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(rowOf(id).isAgency).toBe(false);

    const bad = await app.inject({
      method: 'POST',
      url: `/api/applications/${id}/client/manual`,
      payload: { company: '' },
    });
    expect(bad.statusCode).toBe(400);
    expect(db.select().from(applications).all()).toHaveLength(1);
  });
});
