import { describe, expect, it } from 'vitest';
import { listBoard, rememberingFetch, resolveSource, sourceFromUrl } from './boards.ts';
import { fakeWeb } from './testWeb.ts';

describe('sourceFromUrl', () => {
  it.each([
    [
      'https://job-boards.greenhouse.io/anthropic/jobs/5162711008?gh_src=x',
      {
        kind: 'greenhouse',
        slug: 'anthropic',
        boardUrl: 'https://job-boards.greenhouse.io/anthropic',
      },
    ],
    [
      'https://boards.greenhouse.io/embed/job_board?for=Acme',
      { kind: 'greenhouse', slug: 'acme', boardUrl: 'https://job-boards.greenhouse.io/acme' },
    ],
    [
      'https://jobs.ashbyhq.com/openai/8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3/application',
      { kind: 'ashby', slug: 'openai', boardUrl: 'https://jobs.ashbyhq.com/openai' },
    ],
    [
      'https://jobs.lever.co/spotify',
      { kind: 'lever', slug: 'spotify', boardUrl: 'https://jobs.lever.co/spotify' },
    ],
    [
      'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/TPM_JR1',
      {
        kind: 'workday',
        slug: 'nvidia/NVIDIAExternalCareerSite',
        boardUrl: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite',
      },
    ],
  ])('%s', (url, ref) => {
    expect(sourceFromUrl(url)).toEqual(ref);
  });

  it('is null for a site that is not a job board', () => {
    expect(sourceFromUrl('https://www.emeraldai.co/careers')).toBeNull();
    expect(sourceFromUrl('not a url')).toBeNull();
  });
});

describe('resolveSource', () => {
  it('finds the board a careers page embeds', async () => {
    expect(await resolveSource('https://www.emeraldai.co/careers', fakeWeb())).toEqual({
      kind: 'ashby',
      slug: 'emerald-ai',
      boardUrl: 'https://jobs.ashbyhq.com/emerald-ai',
    });
  });

  it('says so when there is no board to find', async () => {
    await expect(resolveSource('https://www.nothing.example/careers', fakeWeb())).rejects.toThrow(
      /Couldn't find a Greenhouse, Ashby, Lever or Workday job board/,
    );
  });
});

describe('listBoard', () => {
  it('Greenhouse: every job, with description, pay from the text and the posted date', async () => {
    const jobs = await listBoard(
      sourceFromUrl('https://job-boards.greenhouse.io/anthropic')!,
      fakeWeb(),
    );
    expect(jobs).toHaveLength(5);
    expect(jobs[0]).toMatchObject({
      url: 'https://job-boards.greenhouse.io/anthropic/jobs/101',
      title: 'Staff Technical Program Manager, Compute',
      location: 'San Francisco, CA | Seattle, WA',
      remoteType: 'Hybrid',
      salaryMin: 300_000,
      salaryMax: 380_000,
      postedAt: '2026-09-20',
    });
    expect(jobs[0]!.descriptionText).toContain('lead programs across teams');
  });

  it('Ashby: structured pay, every location, hourly contracts flagged, unlisted jobs skipped', async () => {
    const jobs = await listBoard(sourceFromUrl('https://jobs.ashbyhq.com/openai')!, fakeWeb());
    expect(jobs.map((j) => j.title)).toEqual([
      'Technical Program Manager, Compute Infrastructure',
      'Program Manager, Events (Contract)',
    ]);
    expect(jobs[0]).toMatchObject({
      url: 'https://jobs.ashbyhq.com/openai/aaaa1111-0000-4000-8000-000000000001',
      location: 'San Francisco | Seattle',
      remoteType: 'Hybrid',
      salaryMin: 257_000,
      salaryMax: 335_000,
      hourly: false,
      employmentType: 'FullTime',
    });
    expect(jobs[1]).toMatchObject({ hourly: true, employmentType: 'Contract', salaryMin: null });
  });

  it('Lever: every job, and a clear error for a board that does not exist', async () => {
    const f = fakeWeb();
    const jobs = await listBoard(sourceFromUrl('https://jobs.lever.co/spotify')!, f);
    expect(jobs[0]).toMatchObject({
      url: 'https://jobs.lever.co/spotify/bbbb2222-0000-4000-8000-000000000001',
      title: 'Sr. TPM, Personalization',
      location: 'New York, NY | Toronto',
      remoteType: 'Remote',
      salaryMin: 210_000,
      salaryMax: 260_000,
      employmentType: 'Permanent',
    });
    expect(jobs[0]!.descriptionText).toContain('Run programs');
    await expect(listBoard(sourceFromUrl('https://jobs.lever.co/nosuch')!, f)).rejects.toThrow(
      /Lever has no board called "nosuch"/,
    );
  });

  it('Workday: searches for each watched title; titles and places only', async () => {
    const f = fakeWeb();
    const jobs = await listBoard(
      sourceFromUrl('https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite')!,
      f,
      { keywords: ['program manager', 'technical program'] },
    );
    expect(f.calls).toEqual([
      'POST https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs',
      'POST https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs',
    ]);
    expect(jobs).toHaveLength(3); // the same three from both searches, once each
    expect(jobs[0]).toMatchObject({
      url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-Technical-Program-Manager_JR1',
      location: 'US, CA, Santa Clara',
      descriptionText: null,
    });
    expect(jobs[2]!.location).toBeNull(); // "3 Locations" says nothing
  });
});

describe('rememberingFetch', () => {
  it('reads each address once', async () => {
    const f = fakeWeb();
    const once = rememberingFetch(f);
    const url = 'https://api.ashbyhq.com/posting-api/job-board/openai?includeCompensation=true';
    const a = await (await once(url)).json();
    const b = await (await once(url)).json();
    expect(a).toEqual(b);
    expect(f.calls).toHaveLength(1);
  });
});
