import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { openDb, type Db } from '../../db/client.ts';
import { crawlLeads } from '../../db/schema.ts';
import { createApplication, getApplicationDetail, listApplications } from '../applications.ts';
import { updateProfile } from '../resume.ts';
import { addLead, nextCrawlAt, runCrawl, scheduleCrawl, stopCrawlSchedule } from './run.ts';
import { fakeWeb } from './testWeb.ts';
import {
  addSource,
  crawlSettings,
  listFiltered,
  listSources,
  updateCrawlSettings,
} from './watchlist.ts';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
  updateProfile(db, { minBase: 200_000 });
});
afterEach(stopCrawlSchedule);

const inbox = () =>
  listApplications(db)
    .filter((a) => a.status === 'Screening')
    .map((a) => `${a.company} — ${a.title}`)
    .sort();
const leads = () =>
  Object.fromEntries(
    db
      .select()
      .from(crawlLeads)
      .all()
      .map((l) => [l.title, `${l.verdict}: ${l.reason}`]),
  );

describe('adding a board to the watchlist', () => {
  it('reads it once, names the company and counts the titles you watch for', async () => {
    const s = await addSource(
      db,
      { url: 'https://job-boards.greenhouse.io/anthropic/jobs/101' },
      { fetchFn: fakeWeb() },
    );
    expect(s).toMatchObject({
      kind: 'greenhouse',
      slug: 'anthropic',
      companyName: 'Anthropic',
      lastCount: 5,
      lastMatched: 4,
      enabled: true,
    });
  });

  it('uses the name of a company you already track', async () => {
    createApplication(db, { company: 'OpenAI', title: 'Something else' });
    const s = await addSource(
      db,
      { url: 'https://jobs.ashbyhq.com/openai' },
      { fetchFn: fakeWeb() },
    );
    expect(s.companyName).toBe('OpenAI');
  });

  it('refuses a board that is already followed, or one that cannot be read', async () => {
    const f = fakeWeb();
    await addSource(db, { url: 'https://jobs.lever.co/spotify' }, { fetchFn: f });
    await expect(
      addSource(db, { url: 'https://jobs.lever.co/spotify/abc/apply' }, { fetchFn: f }),
    ).rejects.toThrow(/already on your watchlist/);
    await expect(
      addSource(db, { url: 'https://jobs.lever.co/nosuch' }, { fetchFn: f }),
    ).rejects.toThrow(/Lever has no board/);
    expect(listSources(db)).toHaveLength(1);
  });
});

describe('checking the watchlist', () => {
  it('adds the jobs that pass to the inbox and keeps the rest with a reason', async () => {
    const f = fakeWeb();
    await addSource(db, { url: 'https://job-boards.greenhouse.io/anthropic' }, { fetchFn: f });
    await addSource(db, { url: 'https://jobs.ashbyhq.com/openai' }, { fetchFn: f });
    const r = await runCrawl(db, { fetchFn: f });

    expect(r).toMatchObject({ boards: 2, seen: 7, matched: 6, added: 2, filtered: 4 });
    expect(inbox()).toEqual([
      'Anthropic — Staff Technical Program Manager, Compute',
      'Openai — Technical Program Manager, Compute Infrastructure',
    ]);
    expect(leads()).toEqual({
      'Staff Technical Program Manager, Compute': 'yes: Passed your rules',
      'Technical Program Manager, Finance Systems':
        'no-rules: Top of range $180,000 is below $200,000',
      'Senior Program Manager, Policy': 'no-rules: Not remote or near you: London, UK',
      'Program Manager Intern': 'no-rules: Title has “intern”',
      'Technical Program Manager, Compute Infrastructure': 'yes: Passed your rules',
      'Program Manager, Events (Contract)': 'no-rules: Title has “contract”',
    });
    // The software engineer's title isn't watched for: not stored at all.
    expect(listFiltered(db)).toHaveLength(4);
    expect(crawlSettings(db)).toMatchObject({ added: 2, filtered: 4, lastError: null });

    // The inbox card has the description from the board, and says where it came from.
    const app = listApplications(db).find((a) => a.company === 'Anthropic')!;
    const detail = getApplicationDetail(db, app.id);
    expect(detail.job.descriptionText).toContain('lead programs across teams');
    expect(detail.job.salaryMax).toBe(380_000);
    expect(detail.activities.map((a) => a.summary)).toContain(
      "Found on Anthropic's Greenhouse job board (watchlist)",
    );
  });

  it('decides each job once: a second check adds nothing and reads no postings', async () => {
    const f = fakeWeb();
    await addSource(db, { url: 'https://job-boards.greenhouse.io/anthropic' }, { fetchFn: f });
    await runCrawl(db, { fetchFn: f });
    f.calls.length = 0;
    const again = await runCrawl(db, { fetchFn: f });
    expect(again).toMatchObject({ matched: 4, added: 0, filtered: 0 });
    expect(f.calls).toEqual([
      'GET https://boards-api.greenhouse.io/v1/boards/anthropic/jobs?content=true',
    ]);
    expect(inbox()).toHaveLength(1);
  });

  it('a job you deleted from the inbox is not added again', async () => {
    const f = fakeWeb();
    await addSource(db, { url: 'https://job-boards.greenhouse.io/anthropic' }, { fetchFn: f });
    await runCrawl(db, { fetchFn: f });
    const app = buildApp(db, { fetchFn: f });
    const id = listApplications(db)[0]!.id;
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/applications/${id}` })).statusCode,
    ).toBe(204);
    await runCrawl(db, { fetchFn: f });
    expect(inbox()).toEqual([]);
  });

  it('a change to the rules applies to jobs they had filtered out', async () => {
    const f = fakeWeb();
    await addSource(db, { url: 'https://job-boards.greenhouse.io/anthropic' }, { fetchFn: f });
    await runCrawl(db, { fetchFn: f });
    updateCrawlSettings(db, { locations: ['san francisco', 'london'] });
    const r = await runCrawl(db, { fetchFn: f });
    expect(r).toMatchObject({ added: 1, filtered: 0 });
    expect(inbox()).toContain('Anthropic — Senior Program Manager, Policy');
  });

  it('skips a job you already track and a second posting of the same role', async () => {
    createApplication(db, {
      company: 'Anthropic',
      title: 'Staff Technical Program Manager, Compute',
      status: 'Passed',
    });
    const f = fakeWeb();
    await addSource(db, { url: 'https://job-boards.greenhouse.io/anthropic' }, { fetchFn: f });
    const r = await runCrawl(db, { fetchFn: f });
    expect(r.added).toBe(0);
    expect(leads()['Staff Technical Program Manager, Compute']).toBe(
      'duplicate: Same role as “Staff Technical Program Manager, Compute”, which you already track (Passed)',
    );
  });

  it('one unreadable board does not stop the others', async () => {
    const f = fakeWeb();
    await addSource(db, { url: 'https://job-boards.greenhouse.io/anthropic' }, { fetchFn: f });
    await addSource(db, { url: 'https://jobs.lever.co/spotify' }, { fetchFn: f });
    const broken = fakeWeb({
      'https://api.lever.co/v0/postings/spotify?mode=json': { status: 500, body: 'oops' },
    });
    const r = await runCrawl(db, { fetchFn: broken });
    expect(r.added).toBe(1);
    expect(crawlSettings(db).lastError).toBe("Couldn't read: Spotify");
    const spotify = listSources(db).find((s) => s.kind === 'lever')!;
    expect(spotify.lastError).toMatch(/HTTP 500/);
  });

  it('Workday: reads the description of a job only once it has passed the rules', async () => {
    const f = fakeWeb();
    await addSource(
      db,
      {
        url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite',
        companyName: 'NVIDIA',
      },
      { fetchFn: f },
    );
    f.calls.length = 0;
    const r = await runCrawl(db, { fetchFn: f });
    // Santa Clara passes; Bengaluru is filtered; "3 Locations" passes (place unknown).
    expect(r).toMatchObject({ matched: 3, added: 2, filtered: 1 });
    expect(f.calls.filter((c) => c.startsWith('GET')).length).toBe(2);
    const app = listApplications(db).find((a) => /Data Center/.test(a.title))!;
    expect(app).toMatchObject({ company: 'NVIDIA', hasDescription: 1 });
  });
});

describe('filtered-out jobs', () => {
  it('Add anyway puts one in the inbox', async () => {
    const f = fakeWeb();
    await addSource(db, { url: 'https://job-boards.greenhouse.io/anthropic' }, { fetchFn: f });
    await runCrawl(db, { fetchFn: f });
    const lead = listFiltered(db).find((l) => /Finance/.test(l.title))!;
    const r = await addLead(db, lead.id, { fetchFn: f });
    expect(r.existing).toBe(false);
    expect(inbox()).toContain('Anthropic — Technical Program Manager, Finance Systems');
    expect(listFiltered(db).map((l) => l.title)).not.toContain(lead.title);
  });
});

describe('routes', () => {
  it('status, settings, sources, a check and the filtered list', async () => {
    const f = fakeWeb();
    const app = buildApp(db, { fetchFn: f });
    const added = await app.inject({
      method: 'POST',
      url: '/api/crawl/sources',
      payload: { url: 'https://job-boards.greenhouse.io/anthropic' },
    });
    expect(added.statusCode).toBe(201);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/crawl/sources',
      payload: { url: 'https://www.nothing.example/careers' },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toMatch(/Couldn't find/);

    const set = await app.inject({
      method: 'POST',
      url: '/api/crawl/settings',
      payload: { intervalMinutes: -1, titleExclude: ['intern'] },
    });
    expect(set.json()).toMatchObject({ intervalMinutes: -1, titleExclude: ['intern'], sources: 1 });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/crawl/settings',
          payload: { intervalMinutes: 7 },
        })
      ).statusCode,
    ).toBe(400);

    await app.inject({ method: 'POST', url: '/api/crawl/run' });
    await expect
      .poll(async () => (await app.inject({ url: '/api/crawl/status' })).json().progress.running)
      .toBe(false);
    const status = (await app.inject({ url: '/api/crawl/status' })).json();
    expect(status).toMatchObject({ last: { added: 1, filtered: 3 }, filteredCount: 3 });

    const list = (await app.inject({ url: '/api/crawl/leads' })).json() as { id: number }[];
    expect(list).toHaveLength(3);
    const add = await app.inject({ method: 'POST', url: `/api/crawl/leads/${list[0]!.id}/add` });
    expect(add.statusCode).toBe(200);
    expect(inbox()).toHaveLength(2);

    const id = added.json().id as number;
    const off = await app.inject({
      method: 'PATCH',
      url: `/api/crawl/sources/${id}`,
      payload: { enabled: false },
    });
    expect(off.json().enabled).toBe(false);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/crawl/sources/${id}` })).statusCode,
    ).toBe(204);
    expect(listSources(db)).toEqual([]);
  });
});

describe('schedule', () => {
  it('manual never arms; "when the app opens" arms only at start-up; hours arm each time', () => {
    updateCrawlSettings(db, { intervalMinutes: -1 });
    scheduleCrawl(db, {}, { startup: true });
    expect(nextCrawlAt()).toBeNull();

    updateCrawlSettings(db, { intervalMinutes: 0 });
    scheduleCrawl(db, {}, { startup: true });
    expect(nextCrawlAt()).not.toBeNull();
    scheduleCrawl(db, {});
    expect(nextCrawlAt()).toBeNull();

    updateCrawlSettings(db, { intervalMinutes: 60 });
    scheduleCrawl(db, {});
    expect(Date.parse(nextCrawlAt()!) - Date.now()).toBeGreaterThan(59 * 60_000);
  });
});
