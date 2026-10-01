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
    [
      // The search you pasted keeps its place; the keywords are the titles you watch for.
      'https://www.amazon.jobs/en/search?base_query=technical+program&loc_query=San+Francisco+Bay+Area%2C+CA%2C+United+States&latitude=&longitude=&loc_group_id=san-francisco-bay-area&invalid_location=false&country=&city=&region=&county=',
      {
        kind: 'amazon',
        slug: 'loc_group_id=san-francisco-bay-area&loc_query=San+Francisco+Bay+Area%2C+CA%2C+United+States',
        boardUrl:
          'https://www.amazon.jobs/en/search?loc_group_id=san-francisco-bay-area&loc_query=San+Francisco+Bay+Area%2C+CA%2C+United+States',
      },
    ],
    [
      'https://www.amazon.jobs/en/jobs/10562876/technical-program-management',
      { kind: 'amazon', slug: 'anywhere', boardUrl: 'https://www.amazon.jobs/en/search' },
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
      /Couldn't find a Greenhouse, Ashby, Lever, Workday or Amazon jobs board/,
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

  it('Amazon: searches each watched title in your place, newest first, descriptions included', async () => {
    const LONG = 'You will lead programs across teams. '.repeat(10);
    const listing = (id: string, title: string) => ({
      id_icims: id,
      title,
      company_name: 'Amazon.com Services LLC',
      job_path: `/en/jobs/${id}/x`,
      normalized_location: 'San Diego, California, USA',
      locations: [
        JSON.stringify({ normalizedLocation: 'San Diego, California, USA', type: 'ONSITE' }),
        JSON.stringify({ normalizedLocation: 'Sunnyvale, California, USA', type: 'ONSITE' }),
      ],
      posted_date: 'September 29, 2026',
      description: `<p>${LONG}</p>`,
      basic_qualifications: '- 5+ years of program management',
      preferred_qualifications:
        'The base pay for this position ranges from $136,000/year in our lowest geographic market up to $212,800/year in our highest geographic market.',
      job_schedule_type: 'full-time',
    });
    const calls: URL[] = [];
    const f = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      calls.push(u);
      const jobs =
        u.searchParams.get('base_query') === 'technical program'
          ? [
              listing('1', 'Sr. Technical Program Manager'),
              listing('2', 'Technical Program Manager II'),
            ]
          : [listing('1', 'Sr. Technical Program Manager')];
      return new Response(JSON.stringify({ hits: jobs.length, jobs }));
    }) as typeof fetch;
    const jobs = await listBoard(
      sourceFromUrl(
        'https://www.amazon.jobs/en/search?base_query=tpm&loc_group_id=san-francisco-bay-area',
      )!,
      f,
      { keywords: ['technical program', 'program manager'] },
    );
    expect(calls.map((u) => u.pathname)).toEqual(['/en/search.json', '/en/search.json']);
    expect(Object.fromEntries(calls[0]!.searchParams)).toMatchObject({
      base_query: 'technical program',
      loc_group_id: 'san-francisco-bay-area',
      sort: 'recent',
    });
    expect(jobs).toHaveLength(2); // job 1 came back from both searches, kept once
    expect(jobs[0]).toMatchObject({
      url: 'https://www.amazon.jobs/en/jobs/1/x',
      title: 'Sr. Technical Program Manager',
      location: 'San Diego, California, USA | Sunnyvale, California, USA',
      remoteType: 'Onsite',
      salaryMin: 136_000,
      salaryMax: 212_800,
      employmentType: 'full-time',
      postedAt: '2026-09-29',
    });
    expect(jobs[0]!.descriptionText).toContain(`Basic qualifications
- 5+ years`);
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
