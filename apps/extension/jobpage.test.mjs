import { describe, expect, it } from 'vitest';
import { looksLikeJob } from './jobpage.js';

const page = (url, extra = {}) => ({ url, jsonLd: [], pageText: '', ...extra });

describe('is this page one job posting?', () => {
  it.each([
    [
      // Its own section names, no job data: the Apply button and the address say it.
      'Codos, a startup careers page',
      page('https://codos.ai/careers/founding-fde', {
        pageText:
          "Deployed Engineer\nWhat you'll work on here\nIdeal profile\nWhat you bring to the table",
        signals: { apply: true, jobLinks: 2 },
      }),
    ],
    [
      'amazon.jobs, signed in (the chat claims to be the main content)',
      page('https://www.amazon.jobs/en/jobs/10513114/principal-tpm', {
        signals: { apply: true, jobLinks: 6 },
      }),
    ],
    [
      'a posting that names no section but has the usual wording',
      page('https://acme.com/team/ops-lead', {
        pageText: 'About the role. You will run programs.',
      }),
    ],
    [
      'LinkedIn, read from the job panel',
      page('https://www.linkedin.com/jobs/search-results/?currentJobId=1', {
        liFields: { descriptionText: 'About the job…' },
        signals: { apply: true, jobLinks: 25 },
      }),
    ],
    [
      'a careers page showing one embedded Greenhouse job',
      page('https://careers.nebius.com/?gh_jid=4817210101', { signals: { jobLinks: 378 } }),
    ],
    [
      // The page is menus and 27 job links; the reader now reads the posting's iframe too.
      'iCIMS, the posting in an iframe from the same site',
      page(
        'https://careers-americas.icims.com/jobs/27573/principal-technical-program-manager/job',
        { jsonLd: ['{"@type":"JobPosting"}'], signals: { apply: true, jobLinks: 27 } },
      ),
    ],
    [
      'a page with schema.org job data',
      page('https://jobs.example.com/x', { jsonLd: ['{"@type":"JobPosting"}'] }),
    ],
  ])('yes: %s', (_, p) => expect(looksLikeJob(p)).toBe(true));

  it.each([
    ['a company home page', page('https://codos.ai/', { signals: { apply: false, jobLinks: 3 } })],
    [
      'a careers index',
      page('https://codos.ai/careers', {
        pageText: 'Open roles. You will love it here.',
        signals: { apply: false, jobLinks: 4 },
      }),
    ],
    ['an amazon.jobs search', page('https://www.amazon.jobs/en/search?base_query=tpm')],
    [
      'a list of jobs under another address',
      page('https://acme.com/team', {
        pageText: 'Responsibilities vary by role.',
        signals: { apply: false, jobLinks: 12 },
      }),
    ],
    ['an article', page('https://acme.com/blog/our-q3-launch', { pageText: 'We shipped it.' })],
  ])('no: %s', (_, p) => expect(looksLikeJob(p)).toBe(false));
});
