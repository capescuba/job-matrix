import { describe, expect, it } from 'vitest';
import { openDb } from '../db/client.ts';
import { fetchJobPosting, joinPlaces, ldPlaces } from './jobfetch.ts';
import { captureJob } from './screening.ts';
import { listApplications } from './applications.ts';

const LONG = 'You will lead programs across teams, plan the work and ship it on time. '.repeat(5);

/** Canned replies by URL prefix, 404 otherwise. */
function web(routes: Record<string, unknown>) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response('', { status: 404 });
    const body = routes[key];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body));
  }) as typeof fetch;
}

describe('every place a posting names', () => {
  it('joins places once each, skipping blanks and placeholders', () => {
    expect(joinPlaces(['New York', ' San  Francisco ', 'new york', null, '', 'N/A'])).toBe(
      'New York | San Francisco',
    );
    expect(joinPlaces([null, undefined])).toBeNull();
  });

  it('Ashby: the primary location and the secondary ones (Valon)', async () => {
    const job = await fetchJobPosting(
      'https://jobs.ashbyhq.com/Valon/b7ea1044-07af-4b46-ae3d-c3fe7f9f76f5',
      web({
        'https://api.ashbyhq.com/posting-api/job-board/Valon': {
          jobs: [
            {
              id: 'b7ea1044-07af-4b46-ae3d-c3fe7f9f76f5',
              title: 'Technical Program Manager (Data)',
              location: 'New York',
              secondaryLocations: [{ location: 'San Francisco' }, { location: 'New York' }],
              workplaceType: 'OnSite',
              descriptionPlain: LONG,
            },
          ],
        },
      }),
    );
    expect(job).toMatchObject({ location: 'New York | San Francisco', remoteType: 'Onsite' });
  });

  it('Lever: every place in allLocations', async () => {
    const job = await fetchJobPosting(
      'https://jobs.lever.co/spotify/abc',
      web({
        'https://api.lever.co/v0/postings/spotify/abc': {
          text: 'Technical Program Manager',
          descriptionPlain: LONG,
          categories: {
            location: 'New York, NY',
            allLocations: ['New York, NY', 'Toronto', 'Boston, MA'],
          },
          workplaceType: 'remote',
        },
      }),
    );
    expect(job.location).toBe('New York, NY | Toronto | Boston, MA');
  });

  it('Workday: the location and the additional ones (a remote option included)', async () => {
    const job = await fetchJobPosting(
      'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Customer-TPM_JR2004517',
      web({
        'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/': {
          jobPostingInfo: {
            title: 'Customer Technical Program Manager',
            jobDescription: `<p>${LONG}</p>`,
            location: 'US, CA, Santa Clara',
            additionalLocations: ['US, Remote'],
          },
        },
      }),
    );
    expect(job.location).toBe('US, CA, Santa Clara | US, Remote');
  });

  it('page data: every jobLocation, not just the first', async () => {
    expect(
      ldPlaces([
        { address: { addressLocality: 'Austin', addressRegion: 'TX' } },
        { address: { addressLocality: 'Sunnyvale', addressRegion: 'CA' } },
      ]),
    ).toBe('Austin, TX | Sunnyvale, CA');
    const posting = {
      '@type': 'JobPosting',
      title: 'Staff TPM',
      description: `<p>${LONG}</p>`,
      jobLocation: [
        { address: { addressLocality: 'Austin', addressRegion: 'TX' } },
        { address: { addressLocality: 'Sunnyvale', addressRegion: 'CA' } },
      ],
    };
    const job = await fetchJobPosting(
      'https://careers.example.com/jobs/1',
      web({
        'https://careers.example.com/jobs/1': `<html><head><script type="application/ld+json">${JSON.stringify(posting)}</script></head><body>x</body></html>`,
      }),
    );
    expect(job.location).toBe('Austin, TX | Sunnyvale, CA');
  });

  it('a captured job keeps every place (so rules, pre-screen and fit see them all)', async () => {
    const db = openDb(':memory:');
    await captureJob(
      db,
      { url: 'https://jobs.ashbyhq.com/Valon/b7ea1044-07af-4b46-ae3d-c3fe7f9f76f5' },
      {
        fetchFn: web({
          'https://api.ashbyhq.com/posting-api/job-board/Valon': {
            jobs: [
              {
                id: 'b7ea1044-07af-4b46-ae3d-c3fe7f9f76f5',
                title: 'Technical Program Manager (Data)',
                location: 'New York',
                secondaryLocations: [{ location: 'San Francisco' }],
                descriptionPlain: LONG,
              },
            ],
          },
        }),
      },
    );
    expect(listApplications(db)[0]!.location).toBe('New York | San Francisco');
  });
});
