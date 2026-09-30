/** A fake web for watchlist tests: three small job boards and a careers page that embeds one. */

const LONG = 'You will lead programs across teams, plan the work and ship it on time. '.repeat(5);

export const ANTHROPIC_JOBS = [
  {
    id: 101,
    title: 'Staff Technical Program Manager, Compute',
    content: `&lt;p&gt;${LONG}&lt;/p&gt;&lt;p&gt;The annual salary range is $300,000 - $380,000 USD.&lt;/p&gt;`,
    location: { name: 'San Francisco, CA | Seattle, WA' },
    first_published: '2026-09-20T10:00:00-04:00',
    metadata: [{ name: 'Location Type', value: 'Hybrid' }],
  },
  {
    id: 102,
    title: 'Technical Program Manager, Finance Systems',
    content: `&lt;p&gt;${LONG}&lt;/p&gt;&lt;p&gt;Salary: $150,000 - $180,000 USD.&lt;/p&gt;`,
    location: { name: 'San Francisco, CA' },
    first_published: '2026-09-21T10:00:00-04:00',
  },
  {
    id: 103,
    title: 'Senior Program Manager, Policy',
    content: `&lt;p&gt;${LONG}&lt;/p&gt;`,
    location: { name: 'London, UK' },
    first_published: '2026-09-22T10:00:00-04:00',
  },
  {
    id: 104,
    title: 'Software Engineer, Inference',
    content: `&lt;p&gt;${LONG}&lt;/p&gt;`,
    location: { name: 'San Francisco, CA' },
  },
  {
    id: 105,
    title: 'Program Manager Intern',
    content: `&lt;p&gt;${LONG}&lt;/p&gt;`,
    location: { name: 'San Francisco, CA' },
  },
];

export const OPENAI_JOBS = [
  {
    id: 'aaaa1111-0000-4000-8000-000000000001',
    title: 'Technical Program Manager, Compute Infrastructure',
    employmentType: 'FullTime',
    location: 'San Francisco',
    secondaryLocations: [{ location: 'Seattle' }],
    isListed: true,
    isRemote: null,
    workplaceType: 'Hybrid',
    publishedAt: '2026-09-12T16:38:15.322+00:00',
    descriptionPlain: LONG,
    compensation: {
      compensationTierSummary: '$257K – $335K • Offers Equity',
      summaryComponents: [
        { compensationType: 'Salary', interval: '1 YEAR', minValue: 257000, maxValue: 335000 },
      ],
    },
  },
  {
    id: 'aaaa1111-0000-4000-8000-000000000002',
    title: 'Program Manager, Events (Contract)',
    employmentType: 'Contract',
    location: 'San Francisco',
    isListed: true,
    descriptionPlain: LONG,
    compensation: {
      summaryComponents: [
        { compensationType: 'Salary', interval: '1 HOUR', minValue: 70, maxValue: 90 },
      ],
    },
  },
  {
    id: 'aaaa1111-0000-4000-8000-000000000003',
    title: 'Hidden Program Manager',
    location: 'San Francisco',
    isListed: false,
    descriptionPlain: LONG,
  },
];

export const SPOTIFY_JOBS = [
  {
    id: 'bbbb2222-0000-4000-8000-000000000001',
    text: 'Sr. TPM, Personalization',
    categories: {
      commitment: 'Permanent',
      location: 'New York, NY',
      allLocations: ['New York, NY', 'Toronto'],
    },
    workplaceType: 'remote',
    createdAt: 1790771208364,
    descriptionPlain: LONG,
    lists: [{ text: 'What you will do', content: '<li>Run programs</li>' }],
    salaryRange: { min: 210000, max: 260000, interval: 'per-year-salary' },
  },
];

const NVIDIA_JOBS = [
  {
    title: 'Senior Technical Program Manager, Data Center',
    externalPath: '/job/US-CA-Santa-Clara/Senior-Technical-Program-Manager_JR1',
    locationsText: 'US, CA, Santa Clara',
    postedOn: 'Posted Yesterday',
  },
  {
    title: 'Technical Program Manager, Infrastructure',
    externalPath: '/job/India-Bengaluru/Technical-Program-Manager_JR2',
    locationsText: 'India, Bengaluru',
    postedOn: 'Posted 30+ Days Ago',
  },
  {
    title: 'Technical Program Manager, Networking',
    externalPath: '/job/Multi/Technical-Program-Manager_JR3',
    locationsText: '3 Locations',
    postedOn: 'Posted Today',
  },
];

type Route = { status?: number; body: string };

/**
 * Canned replies by URL prefix (longest match wins), 404 otherwise. `calls` lists every request
 * as "METHOD url", so a test can check what was and wasn't fetched.
 */
export function fakeWeb(overrides: Record<string, Route> = {}) {
  const calls: string[] = [];
  const gh = 'https://boards-api.greenhouse.io/v1/boards/anthropic';
  const routes: Record<string, Route> = {
    [`${gh}/jobs?content=true`]: { body: JSON.stringify({ jobs: ANTHROPIC_JOBS }) },
    [gh]: { body: JSON.stringify({ name: 'Anthropic' }) },
    ...Object.fromEntries(
      ANTHROPIC_JOBS.map((j) => [
        `${gh}/jobs/${j.id}`,
        { body: JSON.stringify({ ...j, company_name: 'Anthropic' }) },
      ]),
    ),
    'https://api.ashbyhq.com/posting-api/job-board/openai': {
      body: JSON.stringify({ jobs: OPENAI_JOBS }),
    },
    'https://api.lever.co/v0/postings/spotify?mode=json': { body: JSON.stringify(SPOTIFY_JOBS) },
    'https://api.lever.co/v0/postings/spotify/': { body: JSON.stringify(SPOTIFY_JOBS[0]) },
    'https://api.lever.co/v0/postings/nosuch': {
      body: JSON.stringify({ ok: false, error: 'Document not found' }),
    },
    'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs': {
      body: JSON.stringify({ total: NVIDIA_JOBS.length, jobPostings: NVIDIA_JOBS }),
    },
    'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/': {
      body: JSON.stringify({
        jobPostingInfo: {
          title: 'Senior Technical Program Manager, Data Center',
          jobDescription: `<p>${LONG}</p>`,
          location: 'US, CA, Santa Clara',
        },
      }),
    },
    'https://www.emeraldai.co/careers': {
      body: `<html><body><script src="https://jobs.ashbyhq.com/emerald-ai/embed?version=2"></script></body></html>`,
    },
    'https://www.nothing.example/careers': { body: '<html><body>We are hiring!</body></html>' },
    ...overrides,
  };
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const key = keys.find((k) => url.startsWith(k));
    const r = key ? routes[key]! : { status: 404, body: '' };
    return new Response(r.body, { status: r.status ?? 200 });
  }) as typeof fetch;
  return Object.assign(fn, { calls });
}
