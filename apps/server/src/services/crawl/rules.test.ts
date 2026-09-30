import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLACES,
  DEFAULT_TITLE_EXCLUDE,
  DEFAULT_TITLE_INCLUDE,
  hasPhrase,
  prefilter,
  titleWatched,
  type Criteria,
  type Tracked,
} from './rules.ts';

const criteria: Criteria = {
  include: DEFAULT_TITLE_INCLUDE,
  exclude: DEFAULT_TITLE_EXCLUDE,
  places: DEFAULT_PLACES,
  minBase: 200_000,
};
const nothing: Tracked = { urls: new Map(), roles: [] };

const job = (over: Partial<Parameters<typeof prefilter>[0]> = {}) => ({
  url: 'https://job-boards.greenhouse.io/acme/jobs/1',
  company: 'Acme',
  title: 'Staff Technical Program Manager',
  location: 'San Francisco, CA',
  remoteType: null,
  salaryMin: null,
  salaryMax: null,
  hourly: false,
  employmentType: null,
  ...over,
});

describe('titles', () => {
  it.each([
    ['Sr. Technical Program Manager, Infra', true],
    ['Staff TPM - Payments', true],
    ['Principal Program Manager', true],
    ['Director, Technical Program Management', true],
    ['Software Engineer, Programs', false],
    ['Product Manager', false],
    ['Programmer', false],
  ])('%s → watched: %s', (title, watched) => {
    expect(titleWatched(title, DEFAULT_TITLE_INCLUDE)).toBe(watched);
  });

  it('matches whole words only', () => {
    expect(hasPhrase('Internal Tools Program Manager', 'intern')).toBe(false);
    expect(hasPhrase('Program Manager Intern', 'intern')).toBe(true);
    expect(hasPhrase('Dublin, CA', 'dublin, ca')).toBe(true);
    expect(hasPhrase('Dublin, Ireland', 'dublin, ca')).toBe(false);
  });
});

describe('prefilter', () => {
  it('passes a job nothing speaks against, including when pay and place are unknown', () => {
    expect(prefilter(job(), criteria, nothing)).toEqual({ verdict: 'pass' });
    expect(prefilter(job({ location: null }), criteria, nothing)).toEqual({ verdict: 'pass' });
  });

  it('filters an excluded title', () => {
    expect(prefilter(job({ title: 'Program Manager Intern' }), criteria, nothing)).toEqual({
      verdict: 'no-rules',
      reason: 'Title has “intern”',
    });
  });

  it('filters contracts and hourly pay', () => {
    expect(prefilter(job({ employmentType: 'Contract' }), criteria, nothing)).toMatchObject({
      verdict: 'no-rules',
      reason: 'Not a permanent role (Contract)',
    });
    expect(prefilter(job({ hourly: true }), criteria, nothing)).toMatchObject({
      reason: 'Paid by the hour',
    });
    expect(prefilter(job({ employmentType: 'FullTime' }), criteria, nothing).verdict).toBe('pass');
  });

  it('filters pay whose top is below the floor, and only then', () => {
    expect(
      prefilter(job({ salaryMin: 150_000, salaryMax: 180_000 }), criteria, nothing),
    ).toMatchObject({ verdict: 'no-rules', reason: 'Top of range $180,000 is below $200,000' });
    expect(
      prefilter(job({ salaryMin: 180_000, salaryMax: 240_000 }), criteria, nothing).verdict,
    ).toBe('pass');
    expect(
      prefilter(
        job({ salaryMin: 150_000, salaryMax: 180_000 }),
        { ...criteria, minBase: null },
        nothing,
      ).verdict,
    ).toBe('pass');
  });

  it('filters a place you cannot work from; remote and multi-site postings pass', () => {
    expect(prefilter(job({ location: 'London, UK' }), criteria, nothing)).toMatchObject({
      verdict: 'no-rules',
      reason: 'Not remote or near you: London, UK',
    });
    expect(
      prefilter(job({ location: 'New York, NY', remoteType: 'Remote' }), criteria, nothing).verdict,
    ).toBe('pass');
    expect(prefilter(job({ location: 'Remote - US' }), criteria, nothing).verdict).toBe('pass');
    expect(
      prefilter(job({ location: 'New York, NY | Sunnyvale, CA' }), criteria, nothing).verdict,
    ).toBe('pass');
    expect(
      prefilter(job({ location: 'London, UK' }), { ...criteria, places: [] }, nothing).verdict,
    ).toBe('pass');
  });

  it('spots a job you already track, by address or by company and title', () => {
    const tracked: Tracked = {
      urls: new Map([['https://job-boards.greenhouse.io/acme/jobs/1', 7]]),
      roles: [{ company: 'acme', title: 'Staff TPM', status: 'Passed', applicationId: 9 }],
    };
    expect(prefilter(job(), criteria, tracked)).toEqual({
      verdict: 'duplicate',
      reason: 'Already tracked',
      applicationId: 7,
    });
    expect(
      prefilter(
        job({ url: 'https://www.acme.com/careers?gh_jid=1', company: 'Acme, Inc.' }),
        criteria,
        tracked,
      ),
    ).toEqual({
      verdict: 'duplicate',
      reason: 'Same role as “Staff TPM”, which you already track (Passed)',
      applicationId: 9,
    });
    expect(
      prefilter(
        job({ url: 'https://x.example/2', title: 'Staff TPM, Payments Platform' }),
        criteria,
        tracked,
      ).verdict,
    ).toBe('pass');
    // A sibling role with one more word is a different job.
    expect(
      prefilter(
        job({ url: 'https://x.example/3', title: 'Staff TPM, Governance' }),
        criteria,
        tracked,
      ).verdict,
    ).toBe('pass');
  });
});
