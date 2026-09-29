import { describe, expect, it } from 'vitest';
import { openDb } from '../db/client.ts';
import { pageContext } from './extension.ts';
import { embeddedJobId, fetchJobPosting } from './jobfetch.ts';
import { normalizeUrl } from './screening.ts';

const JID = '44ecb2e4-1ad5-4c2d-a4bb-6c401d1d9d37';
const PAGE = `https://www.emeraldai.co/careers?ashby_jid=${JID}`;

/** Fake web: a careers page embedding the Ashby board, and Ashby's public API. */
function fakeWeb(overrides: Record<string, { status?: number; body: string }> = {}) {
  const calls: string[] = [];
  const routes: Record<string, { status?: number; body: string }> = {
    'https://www.emeraldai.co/careers': {
      body: `<html><head><title>Careers | Emerald AI</title></head><body><div id="ashby_embed"></div>
        <script src="https://jobs.ashbyhq.com/emerald-ai/embed?version=2"></script></body></html>`,
    },
    'https://api.ashbyhq.com/posting-api/job-board/emerald-ai': {
      body: JSON.stringify({
        jobs: [
          {
            id: JID,
            title: 'Technical Program Manager',
            location: 'Bay Area',
            workplaceType: 'Hybrid',
            descriptionPlain:
              'Emerald AI makes data centers flexible grid assets. You will run programs. '.repeat(
                3,
              ),
            publishedAt: '2026-09-20T00:00:00Z',
          },
        ],
      }),
    },
    'https://www.acme.com/jobs': {
      body: `<script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>`,
    },
    'https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012': {
      body: JSON.stringify({
        title: 'Staff TPM',
        content: `&lt;p&gt;${'Lead programs across teams, plan and ship. '.repeat(8)}&lt;/p&gt;`,
        company_name: 'Acme',
      }),
    },
    ...overrides,
  };
  const fn = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const r = key ? routes[key]! : { status: 404, body: '' };
    return new Response(r.body, { status: r.status ?? 200 });
  }) as typeof fetch;
  return Object.assign(fn, { calls });
}

describe('careers pages that embed a job board', () => {
  it('recognises the job id in the address, and keeps only it', () => {
    expect(embeddedJobId(new URL(PAGE))).toEqual({ ats: 'ashby', id: JID });
    expect(embeddedJobId(new URL('https://www.acme.com/jobs?gh_jid=4012'))).toEqual({
      ats: 'greenhouse',
      id: '4012',
    });
    expect(embeddedJobId(new URL('https://www.acme.com/jobs'))).toBeNull();
    expect(normalizeUrl(`${PAGE}&utm_source=linkedin&lang=en`)).toBe(PAGE);
  });

  it('reads an Ashby job from the board named in the page (Emerald AI)', async () => {
    const f = fakeWeb();
    const job = await fetchJobPosting(PAGE, f);
    expect(job).toMatchObject({
      title: 'Technical Program Manager',
      location: 'Bay Area',
      remoteType: 'Hybrid',
      via: 'Ashby API (embedded on www.emeraldai.co)',
    });
    expect(job.descriptionText).toContain('flexible grid assets');
    expect(f.calls[1]).toBe(
      'https://api.ashbyhq.com/posting-api/job-board/emerald-ai?includeCompensation=true',
    );
  });

  it('reads a Greenhouse job the same way', async () => {
    const job = await fetchJobPosting('https://www.acme.com/jobs?gh_jid=4012', fakeWeb());
    expect(job).toMatchObject({
      title: 'Staff TPM',
      company: 'Acme',
      via: 'Greenhouse API (embedded on www.acme.com)',
    });
  });

  it('falls back to reading the page when the board can’t be found', async () => {
    const f = fakeWeb({
      'https://www.emeraldai.co/careers': {
        body: `<html><head><title>Careers</title></head><body><main>${'We are hiring a Technical Program Manager. You will lead programs; experience required. '.repeat(12)}</main></body></html>`,
      },
    });
    const job = await fetchJobPosting(PAGE, f);
    expect(job.via).not.toMatch(/API/);
  });

  it('the side panel shows the real job, not the careers shell', async () => {
    const db = openDb(':memory:');
    const ctx = await pageContext(
      db,
      { url: PAGE, pageTitle: 'Careers | Emerald AI' },
      { fetchFn: fakeWeb() },
    );
    expect(ctx.detected.title).toBe('Technical Program Manager');
    expect(ctx.detected.company).toBe('Emerald AI'); // from the page title
  });
});
