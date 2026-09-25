import { describe, expect, it } from 'vitest';
import {
  checkPosting,
  fetchJobPosting,
  htmlToText,
  parseSalaryRange,
  relativeToDate,
} from './jobfetch.ts';
import { describePosted } from '@jm/shared';

const LONG =
  'You will drive programs across teams. Responsibilities include planning and execution. '.repeat(
    5,
  );

/** Fake fetch that serves canned bodies by URL prefix. */
function fakeFetch(routes: Record<string, { status?: number; body: string }>) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const r = key ? routes[key] : { status: 404, body: '' };
    return new Response(r.body, { status: r.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}

describe('htmlToText', () => {
  it('keeps structure and decodes entities, including entity-escaped HTML', () => {
    const html =
      '&lt;h2&gt;About&lt;/h2&gt;&lt;p&gt;We&amp;rsquo;re hiring&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Lead programs&lt;/li&gt;&lt;li&gt;Ship&lt;/li&gt;&lt;/ul&gt;';
    expect(htmlToText(html)).toBe('About\nWe’re hiring\n\n- Lead programs\n- Ship');
  });
  it('drops scripts and styles', () => {
    expect(htmlToText('<p>Hi<script>alert(1)</script><style>p{}</style></p>')).toBe('Hi');
  });
});

describe('parseSalaryRange', () => {
  it.each([
    ['$190,900-$334,100 base', { min: 190900, max: 334100 }],
    ['$188K – $278K • Offers Equity', { min: 188000, max: 278000 }],
    ['$146,200.00 to $ 233,700.00', { min: 146200, max: 233700 }],
    ['$365,000—$435,000 USD', { min: 365000, max: 435000 }],
    // Meta's format: unit after each amount
    [
      'United States of America: $199,000/year to $272,000/year + bonus + equity',
      { min: 199000, max: 272000 },
    ],
    ['$150,000 per year - $180,000 per year', { min: 150000, max: 180000 }],
    ['$180,800 USD - $226,000 USD', { min: 180800, max: 226000 }],
    ['$210K/yr – $260K/yr', { min: 210000, max: 260000 }],
    // NVIDIA: currency after the amount, one range per level → widest span
    [
      'The base salary range is 168,000 USD - 258,750 USD for Level 4, and 200,000 USD - 322,000 USD for Level 5.',
      { min: 168000, max: 322000 },
    ],
    // Intuit: per-location ranges → widest span
    ['$238,000-$322,000 (MV) / $219,500-$297,000 (SD)', { min: 219500, max: 322000 }],
  ])('%s', (text, expected) => expect(parseSalaryRange(text)).toEqual(expected));
  it('ignores small numbers', () => expect(parseSalaryRange('$10-$20 per hour')).toBeNull());
  it('ignores budgets and other large figures', () =>
    expect(parseSalaryRange('Own a $10,000,000 - $25,000,000 program budget')).toBeNull());
  it('ignores hourly ranges', () =>
    expect(parseSalaryRange('$55.00/hour to $80.00/hour')).toBeNull());
});

describe('fetchJobPosting', () => {
  it('uses the Greenhouse API for EU and US boards', async () => {
    const { f, calls } = fakeFetch({
      'https://boards-api.greenhouse.io/v1/boards/acme/jobs/123': {
        body: JSON.stringify({
          title: 'TPM',
          content: `&lt;p&gt;${LONG} $200,000-$250,000&lt;/p&gt;`,
          location: { name: 'Remote US' },
        }),
      },
    });
    const job = await fetchJobPosting('https://job-boards.eu.greenhouse.io/acme/jobs/123', f);
    expect(calls[0]).toBe('https://boards-api.greenhouse.io/v1/boards/acme/jobs/123');
    expect(job).toMatchObject({
      title: 'TPM',
      remoteType: 'Remote',
      salaryMin: 200000,
      salaryMax: 250000,
      via: 'Greenhouse API',
    });
  });

  it('reads schema.org JobPosting from any page', async () => {
    const ld = {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'JobPosting',
          title: 'Staff TPM',
          description: `<p>${LONG}</p>`,
          jobLocation: { address: { addressLocality: 'Mountain View', addressRegion: 'CA' } },
        },
      ],
    };
    const { f } = fakeFetch({
      'https://careers.example.com/': {
        body: `<html><script type="application/ld+json">${JSON.stringify(ld)}</script></html>`,
      },
    });
    const job = await fetchJobPosting('https://careers.example.com/job/1', f);
    expect(job).toMatchObject({
      title: 'Staff TPM',
      location: 'Mountain View, CA',
      via: 'Page structured data',
    });
  });

  it('ignores placeholder address fields like "UNAVAILABLE"', async () => {
    const ld = {
      '@type': 'JobPosting',
      title: 'Staff TPM',
      description: `<p>${LONG}</p>`,
      jobLocation: { address: { addressLocality: 'UNAVAILABLE', addressRegion: 'UNAVAILABLE' } },
      jobLocationType: 'TELECOMMUTE',
    };
    const { f } = fakeFetch({
      'https://githubinc.jibeapply.com/': {
        body: `<html><script type="application/ld+json">${JSON.stringify(ld)}</script></html>`,
      },
    });
    const job = await fetchJobPosting('https://githubinc.jibeapply.com/jobs/5744', f);
    expect(job).toMatchObject({ location: null, remoteType: 'Remote' });
  });

  it('reads Walmart postings from the page data, using the primary location pay', async () => {
    const jobDetails = {
      title: 'Distinguished, Technical Program Manager',
      active: false,
      requisitionStatus: { id: 'OPEN' },
      jobPostingDescription: `<p>${LONG}</p>`,
      jobPostingStartDate: '2026-09-08T00:00:00.000+00:00',
      payFrequency: 'Annual',
      primaryLocation: { locationId: 'US-11656', city: 'SUNNYVALE', stateCode: 'CA' },
      additionalLocations: [{ locationId: 'US-30094', city: 'BENTONVILLE', stateCode: 'AR' }],
      payRange: [
        { location: 'Bentonville, Arkansas', code: 'US-30094', min: '130000.00', max: '260000.00' },
        { location: 'Sunnyvale, California', code: 'US-11656', min: '169000.00', max: '338000.00' },
      ],
    };
    const next = JSON.stringify({ props: { pageProps: { jobDetails } } });
    const { f } = fakeFetch({
      'https://careers.walmart.com/': {
        body: `<html><script id=__NEXT_DATA__ type="application/json">${next}</script></html>`,
      },
    });
    const job = await fetchJobPosting('https://careers.walmart.com/us/en/jobs/R-2592565', f);
    expect(job).toMatchObject({
      title: 'Distinguished, Technical Program Manager',
      company: 'Walmart',
      location: 'Sunnyvale, CA; Bentonville, AR',
      salaryMin: 169_000,
      salaryMax: 338_000,
      posted: { date: '2026-09-08', approx: false },
      closedHint: null,
      via: 'Walmart careers data',
    });
    expect(job.descriptionText).toContain('- Bentonville, Arkansas: $130,000 - $260,000');

    jobDetails.requisitionStatus.id = 'FILLED';
    const closed = fakeFetch({
      'https://careers.walmart.com/': {
        body: `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { jobDetails } } })}</script>`,
      },
    });
    expect(
      (await fetchJobPosting('https://careers.walmart.com/us/en/jobs/R-2592565', closed.f))
        .closedHint,
    ).toMatch(/FILLED/);
  });

  it('passes the page title along when it falls back to page text', async () => {
    const { f } = fakeFetch({
      'https://careers.example.com/': {
        body: `<html><head><meta property="og:title" content="Staff TPM - Example Careers"></head><body><main><p>${LONG}</p><p>${LONG}</p></main></body></html>`,
      },
    });
    const job = await fetchJobPosting('https://careers.example.com/jobs/1', f);
    expect(job).toMatchObject({ via: 'Page text', pageTitle: 'Staff TPM - Example Careers' });
  });

  it('falls back to the page when a specific API fails', async () => {
    const { f } = fakeFetch({
      'https://boards-api.greenhouse.io/': { status: 404, body: '' },
      'https://job-boards.greenhouse.io/acme/jobs/9': {
        body: `<main><h1>TPM</h1><p>${LONG}${LONG}</p></main>`,
      },
    });
    expect((await fetchJobPosting('https://job-boards.greenhouse.io/acme/jobs/9', f)).via).toBe(
      'Page text',
    );
  });

  it('explains blocked sites', async () => {
    const { f } = fakeFetch({ 'https://careers.blocked.com/': { status: 403, body: 'no' } });
    await expect(fetchJobPosting('https://careers.blocked.com/jobs/1', f)).rejects.toThrow(
      /blocks automated requests/,
    );
  });

  it('rejects pages without a description', async () => {
    const { f } = fakeFetch({
      'https://spa.example.com/': { body: '<html><body><div id="root"></div></body></html>' },
    });
    await expect(fetchJobPosting('https://spa.example.com/j', f)).rejects.toThrow(
      /Paste it instead/,
    );
  });
});

describe('posting dates and status', () => {
  const now = new Date('2026-09-24T12:00:00Z');
  it('parses relative dates', () => {
    expect(relativeToDate('2 weeks ago', now)).toBe('2026-09-10');
    expect(relativeToDate('Posted 30+ Days Ago', now)).toBe('2026-08-25');
    expect(relativeToDate('Posted Today', now)).toBe('2026-09-24');
    expect(relativeToDate('soon', now)).toBeNull();
  });

  it('reports a 404 as closed and a closed-looking page as closed', async () => {
    const { f } = fakeFetch({
      'https://boards-api.greenhouse.io/': { status: 404, body: '' },
      'https://job-boards.greenhouse.io/': { status: 404, body: '' },
      'https://careers.example.com/': {
        body: `<main><h1>TPM</h1><p>This position has been filled. ${LONG}${LONG}</p></main>`,
      },
    });
    expect(
      (await checkPosting('https://job-boards.greenhouse.io/acme/jobs/1', f)).postingStatus,
    ).toBe('closed');
    const c = await checkPosting('https://careers.example.com/j/2', f);
    expect(c.postingStatus).toBe('closed');
    expect(c.postingNote).toMatch(/has been filled/);
  });

  it('keeps the posted date from structured data', async () => {
    const ld = {
      '@type': 'JobPosting',
      title: 'TPM',
      description: `<p>${LONG}</p>`,
      datePosted: '2026-07-01',
    };
    const { f } = fakeFetch({
      'https://careers.example.com/': {
        body: `<script type="application/ld+json">${JSON.stringify(ld)}</script>`,
      },
    });
    const r = await checkPosting('https://careers.example.com/j/3', f);
    expect(r).toMatchObject({
      postingStatus: 'open',
      posted: {
        date: '2026-07-01',
        source: 'Page structured data (schema.org datePosted)',
        approx: false,
      },
    });
  });

  it('leaves status unknown when the site blocks us', async () => {
    const { f } = fakeFetch({ 'https://careers.blocked.com/': { status: 403, body: '' } });
    expect((await checkPosting('https://careers.blocked.com/j', f)).postingStatus).toBeNull();
  });
});

describe('posted-date sources', () => {
  const gh = (extra: Record<string, unknown>) =>
    fakeFetch({
      'https://boards-api.greenhouse.io/': {
        body: JSON.stringify({ title: 'TPM', content: `<p>${LONG}</p>`, ...extra }),
      },
    }).f;

  it('cites Greenhouse first_published, and flags the updated_at fallback', async () => {
    const a = await fetchJobPosting(
      'https://job-boards.greenhouse.io/acme/jobs/1',
      gh({ first_published: '2026-04-01T10:00:00Z', updated_at: '2026-09-01T10:00:00Z' }),
    );
    expect(a.posted).toMatchObject({ date: '2026-04-01', source: 'Greenhouse first_published' });
    const b = await fetchJobPosting(
      'https://job-boards.greenhouse.io/acme/jobs/1',
      gh({ updated_at: '2026-09-01T10:00:00Z' }),
    );
    expect(b.posted?.source).toMatch(/updated_at \(first-published date not provided\)/);
  });

  it('cites Ashby publishedAt', async () => {
    const { f } = fakeFetch({
      'https://api.ashbyhq.com/': {
        body: JSON.stringify({
          jobs: [
            {
              id: 'abc',
              title: 'TPM',
              descriptionPlain: LONG,
              publishedAt: '2026-04-15T22:25:10.601+00:00',
            },
          ],
        }),
      },
    });
    const r = await fetchJobPosting('https://jobs.ashbyhq.com/acme/abc', f);
    expect(r.posted).toEqual({
      date: '2026-04-15',
      source: 'Ashby publishedAt',
      approx: false,
      raw: '2026-04-15T22:25:10.601+00:00',
    });
  });

  it('marks relative LinkedIn text as approximate and keeps the raw text', async () => {
    const html = `<h2 class="top-card-layout__title">TPM</h2>
      <span class="posted-time-ago__text topcard__flavor--metadata">
        2 weeks ago
      </span>
      <div class="show-more-less-html__markup">${LONG}</div>`;
    const { f } = fakeFetch({ 'https://www.linkedin.com/': { body: html } });
    const r = await fetchJobPosting('https://www.linkedin.com/jobs/view/123/', f);
    expect(r.posted).toMatchObject({ approx: true, raw: '2 weeks ago' });
    expect(r.posted?.source).toMatch(/^LinkedIn page text/);
  });
});

describe('describePosted', () => {
  const now = new Date('2026-09-24T12:00:00Z');
  it('labels exact, approximate and at-least dates with a citation', () => {
    const exact = describePosted(
      {
        date: '2026-04-15',
        source: 'Ashby publishedAt',
        approx: false,
        raw: '2026-04-15T22:25:10Z',
      },
      now,
    );
    expect(exact.label).toBe('Posted 162d ago');
    expect(exact.title).toBe('Ashby publishedAt: "2026-04-15T22:25:10Z"');

    const approx = describePosted(
      { date: '2026-09-10', source: 'LinkedIn page text', approx: true, raw: '2 weeks ago' },
      now,
    );
    expect(approx.label).toBe('Posted ~14d ago');
    expect(approx.title).toBe(
      'LinkedIn page text: "2 weeks ago" → about Sep 10, 2026 (approximate)',
    );

    const floor = describePosted(
      {
        date: '2026-08-25',
        source: 'Workday "posted on" text',
        approx: true,
        raw: 'Posted 30+ Days Ago',
      },
      now,
    );
    expect(floor.label).toBe('Posted 30d+ ago');

    expect(
      describePosted({ date: '2026-09-01', source: null, approx: false, raw: null }, now).title,
    ).toMatch(/^Source not recorded/);
  });
});

describe('closed-posting detection ignores text the page never shows', () => {
  // Modelled on careers.docusign.com: a head script carries the site's error messages (and the
  // literal text "<body"), which used to leak into the page text and mark open jobs closed.
  const siteMessages = `<script>window.i18n = {"ERROR":{"NO_JOBS_404":"We’re sorry, but it looks like this job may be no longer available or does not exist."},"TPL":"<body class='x'>"};</script>`;

  it('does not flag a job closed because of hidden script strings', async () => {
    const html = `<html><head>${siteMessages}</head><body><main><h1>TPM</h1><p>${LONG}${LONG}</p></main></body></html>`;
    const { f } = fakeFetch({ 'https://careers.example.com/': { body: html } });
    expect((await checkPosting('https://careers.example.com/jobs/1', f)).postingStatus).toBe(
      'open',
    );
  });

  it('trusts a future validThrough in structured data', async () => {
    const ld = {
      '@type': 'JobPosting',
      title: 'Sr. TPM',
      description: `<p>${LONG}</p>`,
      datePosted: '2026-08-13T16:31:00+0000',
      validThrough: '2099-08-13T16:31:59.000Z',
    };
    const html = `<html><head>${siteMessages}<script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><p>${LONG}</p></body></html>`;
    const { f } = fakeFetch({ 'https://careers.example.com/': { body: html } });
    const r = await checkPosting('https://careers.example.com/jobs/2', f);
    expect(r).toMatchObject({ postingStatus: 'open', posted: { date: '2026-08-13' } });
  });

  it('still flags an expired validThrough, and visible closed text when there is no date', async () => {
    const ld = {
      '@type': 'JobPosting',
      title: 'TPM',
      description: `<p>${LONG}</p>`,
      validThrough: '2020-01-01',
    };
    const { f } = fakeFetch({
      'https://careers.example.com/a': {
        body: `<script type="application/ld+json">${JSON.stringify(ld)}</script>`,
      },
      'https://careers.example.com/b': {
        body: `<body><main><p>This position has been filled. ${LONG}${LONG}</p></main></body>`,
      },
    });
    expect((await checkPosting('https://careers.example.com/a', f)).postingNote).toMatch(
      /Listing expired 2020-01-01/,
    );
    expect((await checkPosting('https://careers.example.com/b', f)).postingStatus).toBe('closed');
  });
});

describe('company from the source', () => {
  it('reads Greenhouse company_name, LinkedIn org link and schema.org hiringOrganization', async () => {
    const gh = fakeFetch({
      'https://boards-api.greenhouse.io/': {
        body: JSON.stringify({
          title: 'TPM',
          company_name: 'Anthropic',
          content: `<p>${LONG}</p>`,
        }),
      },
    }).f;
    expect(
      (await fetchJobPosting('https://job-boards.greenhouse.io/anthropic/jobs/1', gh)).company,
    ).toBe('Anthropic');

    const li = fakeFetch({
      'https://www.linkedin.com/': {
        body: `<a class="topcard__org-name-link topcard__flavor--black-link" href="x">
          Figma
        </a><div class="show-more-less-html__markup">${LONG}</div>`,
      },
    }).f;
    expect((await fetchJobPosting('https://www.linkedin.com/jobs/view/1/', li)).company).toBe(
      'Figma',
    );

    const ld = {
      '@type': 'JobPosting',
      title: 'Sr. TPM',
      hiringOrganization: { '@type': 'Organization', name: 'Docusign' },
      description: `<p>${LONG}</p>`,
    };
    const page = fakeFetch({
      'https://careers.docusign.com/': {
        body: `<script type="application/ld+json">${JSON.stringify(ld)}</script>`,
      },
    }).f;
    expect(
      (await fetchJobPosting('https://careers.docusign.com/careers-home/jobs/30093', page)).company,
    ).toBe('Docusign');
  });
});

describe('placeholder salaries', () => {
  it('treats a schema.org salary of 0 as missing and reads the range from the description', async () => {
    const ld = {
      '@type': 'JobPosting',
      title: 'Sr. TPM',
      description: `<p>${LONG}</p><p>California: $146,400.00 - $235,375.00 base salary</p>`,
      baseSalary: {
        '@type': 'MonetaryAmount',
        value: { minValue: 0, maxValue: 0, unitText: 'YEAR' },
      },
    };
    const { f } = fakeFetch({
      'https://careers.docusign.com/': {
        body: `<script type="application/ld+json">${JSON.stringify(ld)}</script>`,
      },
    });
    const r = await fetchJobPosting('https://careers.docusign.com/careers-home/jobs/30093', f);
    expect([r.salaryMin, r.salaryMax]).toEqual([146400, 235375]);
  });
});
