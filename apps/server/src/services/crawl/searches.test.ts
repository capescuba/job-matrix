import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { openDb, type Db } from '../../db/client.ts';
import { crawlLeads } from '../../db/schema.ts';
import { getApplicationDetail, listApplications } from '../applications.ts';
import { updateProfile } from '../resume.ts';
import { normalizeUrl } from '../screening.ts';
import { stopCrawlSchedule } from './run.ts';
import { listingToJob, searchLabel, searchSiteOf } from './searches.ts';
import {
  addSearch,
  getSearch,
  jobSites,
  listFiltered,
  markSearchRun,
  removeSearch,
  searchesDue,
  setJobSiteSearch,
  updateCrawlSettings,
  updateSearch,
} from './watchlist.ts';

const TOKEN = 't'.repeat(48);
const LONG = 'You will lead programs across teams, plan the work and ship it on time. '.repeat(5);
const LI_SEARCH =
  'https://www.linkedin.com/jobs/search/?keywords=technical%20program%20manager&location=San%20Francisco%20Bay%20Area&sortBy=DD';
const ZIP_SEARCH =
  'https://www.ziprecruiter.com/jobs-search?search=technical+program+manager&location=San+Francisco%2C+CA';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
  updateProfile(db, { minBase: 200_000 });
});
afterEach(stopCrawlSchedule);

/** The server may read LinkedIn postings (guest API); everything else 404s, and is recorded. */
function fakeWeb() {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/jobs-guest/jobs/api/jobPosting/'))
      return new Response(
        `<html><h2 class="top-card-layout__title">Staff TPM</h2><div class="show-more-less-html__markup">${LONG}</div></html>`,
      );
    return new Response('', { status: 404 });
  }) as typeof fetch;
  return Object.assign(fn, { calls });
}

describe('saved search addresses', () => {
  it.each([
    [LI_SEARCH, 'linkedin'],
    ['https://www.indeed.com/jobs?q=tpm&l=Oakland', 'indeed'],
    [
      'https://www.glassdoor.com/Job/san-francisco-ca-technical-program-manager-jobs-SRCH_IL.0,16_IC1147401_KO17,42.htm',
      'glassdoor',
    ],
    [ZIP_SEARCH, 'ziprecruiter'],
    ['https://www.dice.com/jobs?q=tpm&location=San%20Francisco%20Bay%20Area', 'dice'],
    ['https://www.dice.com/job-detail/1d0c780f-20e4-4689-8a71-74a8c1abaa53', null],
    ['https://www.linkedin.com/in/someone/', null],
    ['https://jobs.ashbyhq.com/openai', null],
  ])('%s → %s', (url, site) => expect(searchSiteOf(url)).toBe(site));

  it('names a search after its keywords and place', () => {
    expect(searchLabel(LI_SEARCH)).toBe(
      'LinkedIn: technical program manager in San Francisco Bay Area',
    );
    expect(
      searchLabel(
        'https://www.glassdoor.com/Job/san-francisco-ca-technical-program-manager-jobs-SRCH_IL.0,16.htm',
      ),
    ).toBe('Glassdoor: san francisco ca technical program manager');
  });

  it('refuses a page that is not a search on a supported site', () => {
    expect(() => addSearch(db, { url: 'https://example.com/jobs' })).toThrow(
      /LinkedIn, Indeed, Glassdoor, ZipRecruiter/,
    );
    addSearch(db, { url: LI_SEARCH });
    expect(() => addSearch(db, { url: LI_SEARCH })).toThrow(/already saved/);
  });
});

describe('one posting, one address', () => {
  it.each([
    [
      'https://www.indeed.com/rc/clk?jk=abc123&from=serp&vjs=3',
      'https://www.indeed.com/viewjob?jk=abc123',
    ],
    ['https://www.indeed.com/viewjob?jk=abc123&tk=xyz', 'https://www.indeed.com/viewjob?jk=abc123'],
    [
      'https://www.glassdoor.com/job-listing/tpm-openai-JV_IC1147401_KO0,3.htm?jl=1010258777897&src=GD&ao=1',
      'https://www.glassdoor.com/job-listing/index.htm?jl=1010258777897',
    ],
    [
      // "Jobs for you" (from Glassdoor's email): a list page showing one job in its pane.
      'https://www.glassdoor.com/Job/index.htm?utm_source=jobsForYou&src=GD_JOB_AD&ao=1136043&jrtk=5-yul1&s=373&t=REC_JOBS&pos=101&guid=000001a1&jobListingId=1010212172303&ea=1&rdforyou=true&vt=e&cb=1793001220163&gdir=1',
      'https://www.glassdoor.com/job-listing/index.htm?jl=1010212172303',
    ],
    [
      `${ZIP_SEARCH}&page=2&lk=trPNRZulzs1iw4H6l07HGA`,
      'https://www.ziprecruiter.com/jobs-search?search=technical+program+manager&location=San+Francisco%2C+CA&lk=trPNRZulzs1iw4H6l07HGA',
    ],
  ])('%s', (raw, want) => expect(normalizeUrl(raw)).toBe(want));
});

describe('reading a listing', () => {
  const base = {
    url: 'https://www.linkedin.com/jobs/view/1/',
    title: 'Staff TPM',
    company: 'Acme',
  };
  it('splits the place from how you work there', () => {
    expect(listingToJob({ ...base, location: 'Mountain View, CA (Hybrid)' })).toMatchObject({
      location: 'Mountain View, CA',
      remoteType: 'Hybrid',
    });
    expect(listingToJob({ ...base, location: 'San Francisco, CA · On-site' })).toMatchObject({
      location: 'San Francisco, CA',
      remoteType: 'Onsite',
    });
    expect(listingToJob({ ...base, location: 'San Jose, CA (Remote)' })?.remoteType).toBe('Remote');
  });

  it('reads pay: ranges, "up to", hourly; a site’s own estimate is ignored', () => {
    expect(listingToJob({ ...base, pay: '$257K/yr - $445K/yr' })).toMatchObject({
      salaryMin: 257_000,
      salaryMax: 445_000,
      hourly: false,
    });
    expect(listingToJob({ ...base, pay: '$150K - $250K/yr' })).toMatchObject({
      salaryMin: 150_000,
      salaryMax: 250_000,
    });
    expect(listingToJob({ ...base, pay: 'Up to $250K/yr' })).toMatchObject({
      salaryMin: null,
      salaryMax: 250_000,
    });
    expect(listingToJob({ ...base, pay: '$35/hr - $38/hr' })).toMatchObject({ hourly: true });
    expect(listingToJob({ ...base, pay: '$87K - $140K (Glassdoor est.)' })).toMatchObject({
      salaryMin: null,
      salaryMax: null,
    });
    expect(listingToJob({ ...base, pay: '$257K - $445K (Employer provided)' })?.salaryMax).toBe(
      445_000,
    );
  });

  it('drops LinkedIn’s "with verification" from titles', () => {
    expect(listingToJob({ ...base, title: 'Staff TPM with verification' })?.title).toBe(
      'Staff TPM',
    );
  });
});

describe('results from the extension', () => {
  const post = (app: ReturnType<typeof buildApp>, id: number, body: object, token = TOKEN) =>
    app.inject({
      method: 'POST',
      url: `/api/crawl/searches/${id}/results`,
      headers: { 'x-jm-token': token },
      payload: body,
    });

  it('sorts the listings with the watchlist rules and adds the rest to the inbox', async () => {
    const f = fakeWeb();
    const app = buildApp(db, { extensionToken: TOKEN, fetchFn: f, crawl: { prescreen: null } });
    const s = addSearch(db, { url: LI_SEARCH });
    const r = await post(app, s.id, {
      listings: [
        {
          url: 'https://www.linkedin.com/jobs/view/111/?trk=x',
          title: 'Staff Technical Program Manager',
          company: 'LinkedIn',
          location: 'Mountain View, CA (Hybrid)',
        },
        {
          url: 'https://www.linkedin.com/jobs/view/222/',
          title: 'Program Manager, Cyber Fund Operations',
          company: 'Swoon',
          location: 'San Francisco, CA (Hybrid)',
          pay: '$35/hr - $38/hr',
        },
        {
          url: 'https://www.linkedin.com/jobs/view/333/',
          title: 'Senior Software Engineer',
          company: 'Acme',
          location: 'San Francisco, CA',
        },
      ],
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ seen: 3, matched: 2, added: 1, filtered: 1 });

    const inbox = listApplications(db).filter((a) => a.status === 'Screening');
    expect(inbox.map((a) => `${a.company} — ${a.title}`)).toEqual([
      'LinkedIn — Staff Technical Program Manager',
    ]);
    expect(inbox[0]!.foundBy).toBe(
      'search “LinkedIn: technical program manager in San Francisco Bay Area”',
    );
    // LinkedIn postings are read by the server, so the inbox card has the description.
    const detail = getApplicationDetail(db, inbox[0]!.id);
    expect(detail.job.url).toBe('https://www.linkedin.com/jobs/view/111/');
    expect(detail.job.descriptionText).toContain('lead programs across teams');
    expect(detail.activities.map((a) => a.summary)).toContain(
      'Found by your saved search “LinkedIn: technical program manager in San Francisco Bay Area”',
    );
    expect(listFiltered(db).map((l) => `${l.title}: ${l.reason}`)).toEqual([
      'Program Manager, Cyber Fund Operations: Paid by the hour',
    ]);
    expect(getSearch(db, s.id)).toMatchObject({
      lastCount: 3,
      lastMatched: 2,
      lastAdded: 1,
      lastError: null,
    });
    // The same page again: nothing new.
    const again = await post(app, s.id, {
      listings: [
        {
          url: 'https://www.linkedin.com/jobs/view/111/',
          title: 'Staff Technical Program Manager',
          company: 'LinkedIn',
        },
      ],
    });
    expect(again.json()).toMatchObject({ added: 0, filtered: 0 });
  });

  it('a LinkedIn card that arrived by its id alone is read by the server', async () => {
    const f = fakeWeb();
    const app = buildApp(db, { extensionToken: TOKEN, fetchFn: f, crawl: { prescreen: null } });
    const s = addSearch(db, { url: LI_SEARCH });
    const r = await post(app, s.id, {
      listings: [{ url: 'https://www.linkedin.com/jobs/view/444/', title: null }],
    });
    expect(r.json()).toMatchObject({ seen: 1, matched: 1, added: 1 });
    const added = listApplications(db).find(
      (a) => a.url === 'https://www.linkedin.com/jobs/view/444/',
    );
    expect(added).toMatchObject({ title: 'Staff TPM', hasDescription: 1 });
  });

  it('sites the server can’t read keep the listing’s fields and are not fetched', async () => {
    const f = fakeWeb();
    const app = buildApp(db, { extensionToken: TOKEN, fetchFn: f, crawl: { prescreen: null } });
    const s = addSearch(db, { url: ZIP_SEARCH });
    await post(app, s.id, {
      listings: [
        {
          url: `${ZIP_SEARCH}&lk=trPNRZulzs1iw4H6l07HGA`,
          title: 'Director, Technical Program Management',
          company: 'Samba',
          location: 'San Francisco, CA',
          pay: '$200K - $250K/yr',
        },
      ],
    });
    expect(f.calls).toEqual([]);
    const app1 = listApplications(db).find((a) => a.company === 'Samba')!;
    expect(app1).toMatchObject({
      title: 'Director, Technical Program Management',
      hasDescription: 0,
    });
    // The listing's pay and place travel with it.
    expect(getApplicationDetail(db, app1.id).job).toMatchObject({
      salaryMin: 200_000,
      salaryMax: 250_000,
    });
  });

  it('a robot check or signed-out page is recorded on the search, nothing else', async () => {
    const app = buildApp(db, { extensionToken: TOKEN, fetchFn: fakeWeb() });
    const s = addSearch(db, { url: 'https://www.indeed.com/jobs?q=tpm&l=Oakland' });
    const r = await post(app, s.id, { listings: [], problem: 'The site asked for a robot check.' });
    expect(r.statusCode).toBe(200);
    expect(getSearch(db, s.id).lastError).toBe('The site asked for a robot check.');
    expect(db.select().from(crawlLeads).all()).toEqual([]);
  });

  it('says how many matching jobs an earlier run had already decided', async () => {
    const app = buildApp(db, {
      extensionToken: TOKEN,
      fetchFn: fakeWeb(),
      crawl: { prescreen: null },
    });
    const s = addSearch(db, { url: LI_SEARCH });
    const listings = [
      {
        url: 'https://www.linkedin.com/jobs/view/111/',
        title: 'Staff Technical Program Manager',
        company: 'LinkedIn',
        location: 'Mountain View, CA (Hybrid)',
      },
      {
        url: 'https://www.linkedin.com/jobs/view/222/',
        title: 'Program Manager, Cyber Fund Operations',
        company: 'Swoon',
        location: 'San Francisco, CA (Hybrid)',
        pay: '$35/hr - $38/hr',
      },
    ];
    const first = await post(app, s.id, { listings });
    expect(first.json()).toMatchObject({ matched: 2, added: 1, filtered: 1, seenBefore: 0 });
    // The added one is skipped; the one the rules kept out is looked at again but not recounted.
    const again = await post(app, s.id, { listings });
    expect(again.json()).toMatchObject({ matched: 2, added: 0, filtered: 0, seenBefore: 2 });
  });

  it('only the extension may post results', async () => {
    const app = buildApp(db, { extensionToken: TOKEN, fetchFn: fakeWeb() });
    const s = addSearch(db, { url: LI_SEARCH });
    expect((await post(app, s.id, { listings: [] }, 'wrong')).statusCode).toBe(401);
  });

  it('forgetting a search keeps the jobs it found', async () => {
    const app = buildApp(db, {
      extensionToken: TOKEN,
      fetchFn: fakeWeb(),
      crawl: { prescreen: null },
    });
    const s = addSearch(db, { url: LI_SEARCH });
    await post(app, s.id, {
      listings: [
        { url: 'https://www.linkedin.com/jobs/view/9/', title: 'TPM Intern', company: 'Acme' },
      ],
    });
    removeSearch(db, s.id);
    expect(listFiltered(db)).toHaveLength(1);
  });
});

describe('when the searches are due', () => {
  it('follows the watchlist schedule, and a run marks them done', () => {
    expect(searchesDue(db)).toBe(false); // nothing saved
    addSearch(db, { url: LI_SEARCH });
    expect(searchesDue(db)).toBe(true); // when the app opens (default)
    markSearchRun(db);
    expect(searchesDue(db)).toBe(false);

    updateCrawlSettings(db, { intervalMinutes: 60 });
    const later = new Date(Date.now() + 61 * 60_000);
    expect(searchesDue(db, later)).toBe(true);

    updateCrawlSettings(db, { intervalMinutes: -1 });
    expect(searchesDue(db, later)).toBe(false);
  });
});

describe('the built-in job-site searches', () => {
  it('lists all four sites, searching your keywords and place, newest first', () => {
    const { keywords, location, sites } = jobSites(db);
    expect([keywords, location]).toEqual(['technical program manager', 'San Francisco Bay Area']);
    expect(sites.map((s) => [s.site, s.label, s.enabled, s.preset])).toEqual([
      ['linkedin', 'LinkedIn', true, true],
      ['indeed', 'Indeed', true, true],
      ['glassdoor', 'Glassdoor', true, true],
      ['ziprecruiter', 'ZipRecruiter', true, true],
      ['dice', 'Dice', true, true],
    ]);
    expect(sites.map((s) => s.url)).toEqual([
      'https://www.linkedin.com/jobs/search/?keywords=technical+program+manager&location=San+Francisco+Bay+Area&sortBy=DD&f_TPR=r604800',
      'https://www.indeed.com/jobs?q=technical+program+manager&l=San+Francisco+Bay+Area&sort=date&fromage=7',
      'https://www.glassdoor.com/Job/jobs.htm?sc.keyword=technical+program+manager&locKeyword=San+Francisco+Bay+Area&sortBy=date_desc',
      'https://www.ziprecruiter.com/jobs-search?search=technical+program+manager&location=San+Francisco+Bay+Area&days=7',
      'https://www.dice.com/jobs?q=technical+program+manager&location=San+Francisco+Bay+Area&radius=30&radiusUnit=mi&filters.postedDate=SEVEN',
    ]);
    // Asking again doesn't add more.
    expect(jobSites(db).sites).toHaveLength(5);
  });

  it('new keywords remake every site search; switches are kept', () => {
    const linkedin = jobSites(db).sites[0]!;
    updateSearch(db, linkedin.id, { enabled: false });
    const after = setJobSiteSearch(db, { keywords: 'staff tpm', location: 'Oakland, CA' });
    expect(after.sites[0]).toMatchObject({ enabled: false });
    expect(after.sites[0]!.url).toContain('keywords=staff+tpm&location=Oakland%2C+CA');
    expect(after.sites[3]!.url).toContain('search=staff+tpm&location=Oakland%2C+CA');
  });

  it('the extension may store Glassdoor’s own address for the place, on the same site only', () => {
    const glassdoor = jobSites(db).sites[2]!;
    const fixed =
      'https://www.glassdoor.com/Job/jobs.htm?sc.keyword=technical+program+manager&sortBy=date_desc&locT=C&locId=1147401';
    expect(updateSearch(db, glassdoor.id, { url: fixed }).url).toBe(fixed);
    expect(() => updateSearch(db, glassdoor.id, { url: LI_SEARCH })).toThrow(
      /not a Glassdoor search/,
    );
  });

  it('with the schedule on manual, nothing is ever due', () => {
    jobSites(db);
    updateCrawlSettings(db, { intervalMinutes: -1 });
    expect(searchesDue(db, new Date(Date.now() + 86_400_000))).toBe(false);
  });
});

describe('Dice', () => {
  const base = {
    url: 'https://www.dice.com/job-detail/1d0c780f-20e4-4689-8a71-74a8c1abaa53?searchlink=x',
    title: 'Senior Technical Program Manager - Credit & Lending',
    company: 'Mercury',
  };

  it('one address per job, whatever search found it', () => {
    expect(listingToJob(base)?.url).toBe(
      'https://www.dice.com/job-detail/1d0c780f-20e4-4689-8a71-74a8c1abaa53',
    );
  });

  it('reads Dice’s way of saying where and how', () => {
    expect(listingToJob({ ...base, location: 'Hybrid in Pleasanton, California' })).toMatchObject({
      location: 'Pleasanton, California',
      remoteType: 'Hybrid',
    });
    expect(listingToJob({ ...base, location: 'Remote or Reston, Virginia' })).toMatchObject({
      location: 'Remote | Reston, Virginia',
      remoteType: 'Remote',
    });
    expect(listingToJob({ ...base, location: 'Remote' })).toMatchObject({
      location: 'Remote',
      remoteType: 'Remote',
    });
    expect(listingToJob({ ...base, location: 'San Francisco, California' })?.location).toBe(
      'San Francisco, California',
    );
  });

  it('reads USD pay and the employment type', () => {
    expect(
      listingToJob({
        ...base,
        pay: 'USD 180,200.00 - 225,200.00 per year',
        employmentType: 'Full-time',
      }),
    ).toMatchObject({ salaryMin: 180_200, salaryMax: 225_200, employmentType: 'Full-time' });
    expect(listingToJob({ ...base, employmentType: 'Third Party, Contract' })?.employmentType).toBe(
      'Third Party, Contract',
    );
  });

  it('contracts are filtered; full-time jobs are read in full by the server', async () => {
    const LONG_JD =
      'You will lead programs across teams, plan the work and ship it on time. '.repeat(5);
    const calls: string[] = [];
    const f = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://www.dice.com/job-detail/1d0c780f-20e4-4689-8a71-74a8c1abaa53')
        return new Response(
          `<html><script type="application/ld+json">${JSON.stringify({
            '@type': 'JobPosting',
            title: base.title,
            description: `<p>${LONG_JD}</p>`,
            hiringOrganization: { name: 'Mercury' },
            jobLocation: { address: { addressLocality: 'San Francisco', addressRegion: 'CA' } },
          })}</script><body>x</body></html>`,
        );
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const app = buildApp(db, { extensionToken: TOKEN, fetchFn: f, crawl: { prescreen: null } });
    const dice = jobSites(db).sites.find((x) => x.site === 'dice')!;
    const r = await app.inject({
      method: 'POST',
      url: `/api/crawl/searches/${dice.id}/results`,
      headers: { 'x-jm-token': TOKEN },
      payload: {
        listings: [
          {
            ...base,
            location: 'San Francisco, California',
            employmentType: 'Full-time',
            pay: 'USD 180,200.00 - 225,200.00 per year',
          },
          {
            url: 'https://www.dice.com/job-detail/ba304221-3a34-410f-b206-d32aad646ed5',
            title: 'Technical Program Manager',
            company: 'Pyramid Consulting, Inc.',
            location: 'Remote',
            employmentType: 'Contract',
            pay: '80 - 85',
          },
        ],
      },
    });
    expect(r.json()).toMatchObject({ seen: 2, matched: 2, added: 1, filtered: 1 });
    const added = listApplications(db).find((a) => a.company === 'Mercury')!;
    expect(added).toMatchObject({ hasDescription: 1, foundBy: 'Dice search' });
    expect(listFiltered(db).map((l) => l.reason)).toEqual(['Not a permanent role (Contract)']);
  });
});
