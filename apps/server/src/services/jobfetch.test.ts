import { describe, expect, it } from 'vitest';
import {
  checkPosting,
  fetchJobPosting,
  htmlToText,
  parseSalaryRange,
  relativeToDate,
} from './jobfetch.ts';

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
    expect(r).toMatchObject({ postingStatus: 'open', postedAt: '2026-07-01' });
  });

  it('leaves status unknown when the site blocks us', async () => {
    const { f } = fakeFetch({ 'https://careers.blocked.com/': { status: 403, body: '' } });
    expect((await checkPosting('https://careers.blocked.com/j', f)).postingStatus).toBeNull();
  });
});
