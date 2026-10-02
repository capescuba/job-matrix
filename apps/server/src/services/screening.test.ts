import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { openDb, type Db } from '../db/client.ts';
import { createApplication } from './applications.ts';
import { unscoredApplicationIds } from './fit.ts';
import {
  captureJob,
  companyFromBoardUrl,
  findTrackedByUrl,
  normalizeUrl,
  parseApplicants,
  parsePageTitle,
} from './screening.ts';

const LONG = 'You will lead programs across teams. Responsibilities include planning. '.repeat(6);
const TOKEN = 't'.repeat(48);

/** Fake fetch: canned bodies by URL prefix, 404 otherwise (so tests never hit the network). */
function fakeFetch(routes: Record<string, { status?: number; body: string }> = {}) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const r = key ? routes[key] : { status: 404, body: '' };
    return new Response(r.body, { status: r.status ?? 200 });
  }) as typeof fetch;
}
const offline = fakeFetch(); // every server-side fetch fails, like a blocked site

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

const row = (id: number) =>
  db.$client
    .prepare(
      `SELECT a.status, a.applied_at AS appliedAt, j.title, c.name AS company, j.description_text AS d,
              j.description_source AS src, j.salary_min AS smin, j.salary_max AS smax,
              j.applicant_count AS applicants, j.linkedin_insights AS insights, j.url
       FROM applications a JOIN jobs j ON j.id = a.job_id JOIN companies c ON c.id = j.company_id
       WHERE a.id = ?`,
    )
    .get(id) as Record<string, unknown>;

describe('normalizeUrl', () => {
  it.each([
    [
      'https://www.linkedin.com/jobs/search/?currentJobId=4466802039&keywords=tpm',
      'https://www.linkedin.com/jobs/view/4466802039/',
    ],
    [
      'https://www.linkedin.com/jobs/view/senior-tpm-at-acme-4466802039/?trk=abc',
      'https://www.linkedin.com/jobs/view/4466802039/',
    ],
    [
      'https://job-boards.greenhouse.io/acme/jobs/123?gh_src=x&utm_source=li#apply',
      'https://job-boards.greenhouse.io/acme/jobs/123',
    ],
    ['https://jobs.lever.co/zoox/5c37/', 'https://jobs.lever.co/zoox/5c37'],
    [
      'https://jobs.lever.co/zoox/5c37/apply?lever-origin=applied',
      'https://jobs.lever.co/zoox/5c37',
    ],
    // Greenhouse: every form of one job is the same job.
    [
      'https://boards.greenhouse.io/embed/job_app?for=acme&token=99',
      'https://job-boards.greenhouse.io/acme/jobs/99',
    ],
    [
      'https://boards.greenhouse.io/Acme/jobs/99?t=abc',
      'https://job-boards.greenhouse.io/acme/jobs/99',
    ],
    [
      'https://www.acme.com/careers/job?gh_jid=99&utm_source=li&foo=bar',
      'https://www.acme.com/careers/job?gh_jid=99',
    ],
    // Oracle: the job page (with its search parameters) and the preview after applying.
    [
      'https://careers.oracle.com/en/sites/jobsearch/job/334011?keyword=Principal%20TPM&location=United%20States',
      'https://careers.oracle.com/en/sites/jobsearch/job/334011',
    ],
    [
      'https://careers.oracle.com/en/sites/jobsearch/my-profile/preview/334011',
      'https://careers.oracle.com/en/sites/jobsearch/job/334011',
    ],
    [
      'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/2001/?utm_medium=x',
      'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/2001',
    ],
    [
      'https://jobs.ashbyhq.com/openai/ad958934-fd89-4033-8b13-1a4871d8073c/application?utm_source=x',
      'https://jobs.ashbyhq.com/openai/ad958934-fd89-4033-8b13-1a4871d8073c',
    ],
    [
      'https://adobe.wd5.myworkdayjobs.com/external_experienced/job/San-Jose/Principal-TPM_R170800/apply/applyManually',
      'https://adobe.wd5.myworkdayjobs.com/external_experienced/job/San-Jose/Principal-TPM_R170800',
    ],
  ])('%s', (input, expected) => expect(normalizeUrl(input)).toBe(expected));
});

describe('findTrackedByUrl', () => {
  it('finds a job from another address for it (Oracle preview after applying)', () => {
    const id = createApplication(db, {
      company: 'Oracle',
      title: 'Senior Principal Technical Program Manager',
      status: 'Screening',
      url: 'https://careers.oracle.com/en/sites/jobsearch/job/334011?keyword=Principal%20Technical%20Program%20Manager&location=United%20States',
    });
    expect(
      findTrackedByUrl(
        db,
        'https://careers.oracle.com/en/sites/jobsearch/my-profile/preview/334011',
      ),
    ).toMatchObject({ applicationId: id, status: 'Screening' });
    expect(
      findTrackedByUrl(db, 'https://careers.oracle.com/en/sites/jobsearch/job/334012'),
    ).toBeNull();
  });
});

describe('title/company without AI', () => {
  it.each([
    ['(3) Senior TPM | Acme Robotics | LinkedIn', 'Senior TPM', 'Acme Robotics'],
    ['Acme hiring Staff TPM in San Francisco, CA | LinkedIn', 'Staff TPM', 'Acme'],
    ['Job Application for Principal TPM at Glean', 'Principal TPM', 'Glean'],
    ['Staff TPM at Box - Careers', 'Staff TPM', 'Box'],
    [
      'Distinguished, Technical Program Manager - Walmart Careers',
      'Distinguished, Technical Program Manager',
      'Walmart',
    ],
    [
      'Technical Program Management - Job ID: 10562876 | Amazon.jobs',
      'Technical Program Management',
      'Amazon',
    ],
    [
      'Sr. Staff Technical Program Manager, Core AI (Mountain View, CA | New York, NY) | LinkedIn | LinkedIn',
      'Sr. Staff Technical Program Manager, Core AI (Mountain View, CA | New York, NY)',
      null,
    ],
    ['Careers page', 'Careers page', null],
  ])('%s', (title, t, c) => expect(parsePageTitle(title)).toEqual({ title: t, company: c }));

  it('reads the company from ATS board slugs', () => {
    expect(companyFromBoardUrl('https://jobs.ashbyhq.com/hayden-ai/25b5')).toBe('Hayden Ai');
    expect(companyFromBoardUrl('https://job-boards.greenhouse.io/anthropic/jobs/1')).toBe(
      'Anthropic',
    );
    expect(companyFromBoardUrl('https://visa.wd5.myworkdayjobs.com/Visa/job/x')).toBe('Visa');
    expect(companyFromBoardUrl('https://careers.example.com/j/1')).toBeNull();
  });

  it('parses applicant counts', () => {
    expect(parseApplicants('Over 100 applicants')).toBe(100);
    expect(parseApplicants('1,204 applicants')).toBe(1204);
    expect(parseApplicants('Be an early applicant')).toBeNull();
  });
});

describe('captureJob', () => {
  it('prefers your selection, lands in Screening with no applied date, and logs a note', async () => {
    const r = await captureJob(
      db,
      {
        url: 'https://careers.example.com/j/1?utm_source=x',
        pageTitle: 'Principal TPM | Example Co',
        selectionText: `Selected: ${LONG} Pay $210,000 - $260,000`,
        pageText: `Nav Nav Nav ${LONG}`,
      },
      { fetchFn: offline },
    );
    expect(r).toMatchObject({
      existing: false,
      status: 'Screening',
      company: 'Example Co',
      title: 'Principal TPM',
    });
    expect(row(r.applicationId)).toMatchObject({
      status: 'Screening',
      appliedAt: null,
      src: 'Your selection',
      smin: 210000,
      smax: 260000,
      url: 'https://careers.example.com/j/1',
    });
    expect(String(row(r.applicationId).d)).toMatch(/^Selected:/);
    const note = db.$client
      .prepare("SELECT summary FROM activities WHERE kind = 'Note'")
      .pluck()
      .get();
    expect(note).toMatch(/description from Your selection/);
  });

  it('uses template fields over the server fetch and page text', async () => {
    const r = await captureJob(
      db,
      {
        url: 'https://www.linkedin.com/jobs/search/?currentJobId=555',
        pageTitle: 'LinkedIn',
        templateName: 'LinkedIn (signed in)',
        fields: {
          title: 'Staff TPM',
          company: 'Figma',
          location: 'San Francisco, CA',
          salaryText: '$185K/yr - $317K/yr',
          descriptionText: LONG,
        },
        pageText: 'lots of chrome',
      },
      { fetchFn: offline },
    );
    expect(row(r.applicationId)).toMatchObject({
      title: 'Staff TPM',
      company: 'Figma',
      src: 'LinkedIn (signed in) template',
      smin: 185000,
      smax: 317000,
      url: 'https://www.linkedin.com/jobs/view/555/',
    });
  });

  it('falls back to the server fetch for ATS links (Screen a URL) with the company from the board', async () => {
    const f = fakeFetch({
      'https://api.ashbyhq.com/': {
        body: JSON.stringify({
          jobs: [
            {
              id: 'abc',
              title: 'Principal TPM',
              descriptionPlain: LONG,
              publishedAt: '2026-04-15T00:00:00Z',
              compensation: { compensationTierSummary: '$213K – $278K' },
            },
          ],
        }),
      },
    });
    const r = await captureJob(
      db,
      { url: 'https://jobs.ashbyhq.com/haydenai/abc' },
      { fetchFn: f },
    );
    expect(r).toMatchObject({ company: 'Haydenai', title: 'Principal TPM' });
    expect(row(r.applicationId)).toMatchObject({ src: 'Ashby API', smin: 213000, smax: 278000 });
  });

  it('reads company and title from JSON-LD', async () => {
    const ld = JSON.stringify({
      '@type': 'JobPosting',
      title: 'Lead TPM',
      hiringOrganization: { name: 'Visa' },
      description: `<p>${LONG}</p>`,
      datePosted: '2026-09-01',
    });
    const r = await captureJob(
      db,
      { url: 'https://careers.visa.com/j/9', jsonLd: [ld] },
      { fetchFn: offline },
    );
    expect(r).toMatchObject({ company: 'Visa', title: 'Lead TPM' });
    expect(row(r.applicationId).src).toBe('Page structured data');
  });

  it('recognises a posting you already track, even with a different tracking link', async () => {
    const first = await captureJob(
      db,
      { url: 'https://jobs.lever.co/zoox/5c37', pageText: LONG },
      { fetchFn: offline },
    );
    const again = await captureJob(
      db,
      { url: 'https://jobs.lever.co/zoox/5c37/?lever-source=LinkedIn', pageText: LONG },
      { fetchFn: offline },
    );
    expect(again).toMatchObject({
      existing: true,
      applicationId: first.applicationId,
      status: 'Screening',
    });
    expect(db.$client.prepare('SELECT count(*) FROM applications').pluck().get()).toBe(1);
  });

  it('fills in the description of a tracked job that has none, and only then', async () => {
    // A saved-search listing: added with no description, since the server can't read Indeed.
    const first = await captureJob(
      db,
      {
        url: 'https://www.indeed.com/viewjob?jk=abc123',
        fields: { title: 'Senior TPM', company: 'Acme' },
      },
      { skipFetch: true },
    );
    expect(row(first.applicationId).d).toBeNull();
    expect(db.$client.prepare('SELECT source FROM jobs').pluck().get()).toBe('Indeed');

    const filled = await captureJob(
      db,
      {
        url: 'https://www.indeed.com/viewjob?jk=abc123&from=serp',
        fields: { descriptionText: LONG },
        templateName: 'Built-in Indeed',
      },
      { fetchFn: offline },
    );
    expect(filled).toMatchObject({
      existing: true,
      applicationId: first.applicationId,
      descriptionAdded: true,
      descriptionSource: 'Built-in Indeed template',
    });
    expect(row(first.applicationId)).toMatchObject({
      d: LONG.trim(),
      src: 'Built-in Indeed template',
      title: 'Senior TPM',
      company: 'Acme',
    });

    // One it already has is left alone.
    const again = await captureJob(
      db,
      { url: 'https://www.indeed.com/viewjob?jk=abc123', pageText: `Other text. ${LONG}` },
      { fetchFn: offline },
    );
    expect(again.descriptionAdded).toBeUndefined();
    expect(row(first.applicationId).d).toBe(LONG.trim());
  });

  it('stores LinkedIn signed-in extras: applicants, insights, hiring team as contacts', async () => {
    const r = await captureJob(
      db,
      {
        url: 'https://www.linkedin.com/jobs/view/777/',
        fields: { title: 'TPM', company: 'Crux AI', descriptionText: LONG },
        linkedin: {
          applicantsText: 'Over 100 applicants',
          insights: ['3 connections work here', '12 school alumni work here'],
          hiringTeam: [
            {
              name: 'Jane Doe',
              title: 'Technical Recruiter',
              profileUrl: 'https://www.linkedin.com/in/jane',
            },
            { name: 'Sam Lee', title: 'Director of Engineering' },
          ],
        },
      },
      { fetchFn: offline },
    );
    expect(row(r.applicationId)).toMatchObject({ applicants: 100 });
    expect(JSON.parse(String(row(r.applicationId).insights))).toEqual([
      '3 connections work here',
      '12 school alumni work here',
    ]);
    const people = db.$client
      .prepare('SELECT name, relationship FROM contacts ORDER BY name')
      .all();
    expect(people).toEqual([
      { name: 'Jane Doe', relationship: 'Recruiter' },
      { name: 'Sam Lee', relationship: 'Hiring manager' },
    ]);
  });
});

describe('screening routes & inbox behaviour', () => {
  it('requires the extension token for captures and lookups', async () => {
    const app = buildApp(db, { extensionToken: TOKEN, fetchFn: offline });
    const payload = { url: 'https://careers.example.com/j/2', pageText: LONG };
    expect(
      (await app.inject({ method: 'POST', url: '/api/screen/capture', payload })).statusCode,
    ).toBe(401);
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/screen/capture',
      payload,
      headers: { 'x-jm-token': 'x'.repeat(48) },
    });
    expect(wrong.statusCode).toBe(401);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/screen/capture',
      payload,
      headers: { 'x-jm-token': TOKEN },
    });
    expect(ok.statusCode).toBe(201);
    const lookup = await app.inject({
      url: `/api/screen/lookup?url=${encodeURIComponent('https://careers.example.com/j/2?utm_source=li')}`,
      headers: { 'x-jm-token': TOKEN },
    });
    expect(lookup.json().tracked).toMatchObject({
      applicationId: ok.json().applicationId,
      status: 'Screening',
    });
  });

  it('lists inbox jobs from search sites that still need a description', async () => {
    const app = buildApp(db, { extensionToken: TOKEN, fetchFn: offline });
    const add = (url: string, extra: Record<string, unknown> = {}) =>
      createApplication(db, { company: 'Acme', title: url, url, status: 'Screening', ...extra });
    const indeed = add('https://www.indeed.com/viewjob?jk=1');
    add('https://www.glassdoor.com/job-listing/x?jl=2', { descriptionText: LONG });
    add('https://jobs.lever.co/acme/3'); // the server reads this one itself
    add('https://www.indeed.com/viewjob?jk=4', { status: 'Applied' });
    const zip = add('https://www.ziprecruiter.com/jobs-search?lk=5');

    const url = '/api/crawl/searches/missing-descriptions';
    expect((await app.inject({ url })).statusCode).toBe(401);
    const r = await app.inject({ url, headers: { 'x-jm-token': TOKEN } });
    expect(r.json()).toEqual([
      expect.objectContaining({ applicationId: zip, site: 'ziprecruiter' }),
      expect.objectContaining({
        applicationId: indeed,
        site: 'indeed',
        url: 'https://www.indeed.com/viewjob?jk=1',
      }),
    ]);
  });

  it('keeps Screening and Passed out of pipeline stats; Pass logs the reason', async () => {
    const app = buildApp(db, { extensionToken: TOKEN, fetchFn: offline });
    const a = (
      await app.inject({
        method: 'POST',
        url: '/api/screen/url',
        payload: { url: 'https://careers.example.com/j/3' },
      })
    ).json();
    const b = (
      await app.inject({
        method: 'POST',
        url: '/api/screen/url',
        payload: { url: 'https://careers.example.com/j/4' },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/api/applications/${b.applicationId}/activities`,
      payload: {
        // Today: "passed this week" counts the last 7 days.
        at: new Date().toISOString().slice(0, 10),
        kind: 'Note',
        summary: 'Passed: 5 days onsite',
        setStatus: 'Passed',
      },
    });
    const stats = (await app.inject('/api/stats')).json();
    expect(stats).toMatchObject({
      total: 0,
      applied: 0,
      active: 0,
      screening: 1,
      passedThisWeek: 1,
    });
    expect(row(b.applicationId)).toMatchObject({ status: 'Passed', appliedAt: null });

    // Add to pipeline → Saved, still not applied.
    await app.inject({
      method: 'PATCH',
      url: `/api/applications/${a.applicationId}`,
      payload: { status: 'Saved' },
    });
    expect(row(a.applicationId)).toMatchObject({ status: 'Saved', appliedAt: null });
  });

  it('Screen a URL uses the page title when the page has no job data', async () => {
    const page = `<html><head><title>Principal TPM - Acme Careers</title></head><body><main>
      <h1>Principal TPM</h1><p>${LONG}</p><p>${LONG}</p><p>Qualifications: 10 years.</p>
    </main></body></html>`;
    const app = buildApp(db, {
      extensionToken: TOKEN,
      fetchFn: fakeFetch({ 'https://careers.acme.com/': { body: page } }),
    });
    const r = (
      await app.inject({
        method: 'POST',
        url: '/api/screen/url',
        payload: { url: 'https://careers.acme.com/jobs/77' },
      })
    ).json();
    expect(r).toMatchObject({ title: 'Principal TPM', company: 'Acme' });
  });

  it('fixes an Unknown company by moving the job to a named company', async () => {
    const app = buildApp(db, { extensionToken: TOKEN, fetchFn: offline });
    const a = (
      await app.inject({
        method: 'POST',
        url: '/api/screen/url',
        // An address that names no company (careers.example.com would now give "Example").
        payload: { url: 'https://www.jobs.com/j/5' },
      })
    ).json();
    expect(a.company).toBe('Unknown');
    const jobId = (await app.inject(`/api/applications/${a.applicationId}`)).json().job.id;
    await app.inject({
      method: 'PATCH',
      url: `/api/jobs/${jobId}`,
      payload: { companyName: 'Meta' },
    });
    expect(row(a.applicationId).company).toBe('Meta');
  });

  it('batch scoring can be limited to the Screening inbox', async () => {
    await captureJob(
      db,
      { url: 'https://careers.example.com/j/6', pageText: LONG },
      { fetchFn: offline },
    );
    db.$client.prepare("UPDATE applications SET status = 'Saved'").run();
    const s = await captureJob(
      db,
      { url: 'https://careers.example.com/j/7', pageText: LONG },
      { fetchFn: offline },
    );
    expect(unscoredApplicationIds(db, 'Screening')).toEqual([s.applicationId]);
    expect(unscoredApplicationIds(db)).toHaveLength(2);
  });
});

describe('Screen a URL uses the company the page names', () => {
  it('fills the company from the fetched page instead of "Unknown"', async () => {
    const ld = {
      '@type': 'JobPosting',
      title: 'Sr. Technical Program Manager',
      hiringOrganization: { name: 'Docusign' },
      description: `<p>${LONG}</p>`,
    };
    const f = fakeFetch({
      'https://careers.docusign.com/': {
        body: `<script type="application/ld+json">${JSON.stringify(ld)}</script>`,
      },
    });
    const r = await captureJob(
      db,
      { url: 'https://careers.docusign.com/careers-home/jobs/30093' },
      { fetchFn: f },
    );
    expect(r).toMatchObject({ company: 'Docusign', title: 'Sr. Technical Program Manager' });
  });
});
