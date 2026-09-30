import { beforeEach, describe, expect, it, vi } from 'vitest';

// A stand-in for Chrome: tabs open and load at once, the page reader returns canned results,
// and session storage records every progress report the side panel would see.
const reports = [];
const pages = {
  'https://www.linkedin.com/jobs/search/?keywords=tpm': {
    listings: [
      { url: 'https://www.linkedin.com/jobs/view/1/', title: 'Staff TPM', company: 'Acme' },
    ],
  },
  'https://www.indeed.com/jobs?q=tpm': { problem: 'The site asked for a robot check.' },
};
// Job postings the description pass opens: what the reader finds on each.
const postings = {
  'https://www.indeed.com/viewjob?jk=1': { descriptionText: 'A long description. '.repeat(20) },
  'https://www.indeed.com/viewjob?jk=2': { descriptionText: null, jsonLd: [] },
  'https://www.glassdoor.com/job-listing/x?jl=3': { problem: 'robot check' },
  'https://www.glassdoor.com/job-listing/y?jl=4': { descriptionText: 'Never read.'.repeat(30) },
};
let missing = [];
const local = {};
const captures = [];
const opened = [];
let keptAlive = 0;
let slowResults = false;
let nextTab = 1;
const tabUrls = {};
const listeners = new Set();
globalThis.chrome = {
  storage: {
    local: {
      get: async () => ({ token: 't', server: 'http://127.0.0.1:5174', ...local }),
      set: async (o) => Object.assign(local, o),
    },
    session: {
      set: async (o) => {
        for (const v of Object.values(o)) reports.push(structuredClone(v));
      },
    },
  },
  runtime: {
    sendNativeMessage: async () => null,
    getPlatformInfo: async () => {
      keptAlive++;
      return { os: 'win' };
    },
  },
  tabs: {
    query: async () => [{ id: 99 }],
    create: async ({ url, active }) => {
      const id = nextTab++;
      tabUrls[id] = url;
      opened.push({ url, active });
      setTimeout(() => listeners.forEach((l) => l(id, { status: 'complete' })), 0);
      return { id };
    },
    update: async () => ({}),
    remove: async () => {},
    onUpdated: {
      addListener: (l) => listeners.add(l),
      removeListener: (l) => listeners.delete(l),
    },
  },
  scripting: {
    executeScript: async ({ target }) => {
      const url = tabUrls[target.tabId];
      return [{ result: pages[url] ?? postings[url] }];
    },
  },
};

// Job Matrix's side: two saved searches, and what each results post found.
globalThis.fetch = vi.fn(async (url, init) => {
  const path = new URL(url).pathname;
  const json = (b) => new Response(JSON.stringify(b), { status: 200 });
  if (path === '/api/crawl/searches')
    return json([
      {
        id: 1,
        site: 'linkedin',
        label: 'LinkedIn',
        enabled: true,
        url: 'https://www.linkedin.com/jobs/search/?keywords=tpm',
      },
      {
        id: 2,
        site: 'indeed',
        label: 'Indeed',
        enabled: true,
        url: 'https://www.indeed.com/jobs?q=tpm',
      },
    ]);
  if (path === '/api/crawl/searches/started') return json({ ok: true });
  if (path === '/api/crawl/searches/missing-descriptions') return json(missing);
  if (path === '/api/screen/capture') {
    const body = JSON.parse(init.body);
    captures.push(body);
    return json({ existing: true, descriptionAdded: !!body.fields?.descriptionText });
  }
  // A results page with many matches: the server's pre-screen takes a minute.
  if (slowResults && path.endsWith('/results')) await new Promise((r) => setTimeout(r, 60_000));
  if (path === '/api/crawl/searches/1/results')
    return json({ seen: 1, matched: 1, added: 1, filtered: 0, screened: 0, waiting: 0 });
  if (path === '/api/crawl/searches/2/results')
    return json({ seen: 0, matched: 0, added: 0, filtered: 0, screened: 0, waiting: 0 });
  return new Response('{}', { status: 404 });
});

const { runSearches } = await import('./search.js');

beforeEach(() => {
  reports.length = 0;
  captures.length = 0;
  opened.length = 0;
  missing = [];
  for (const k of Object.keys(local)) delete local[k];
});

/** Runs the searches with the pauses skipped. */
async function run() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearInterval'] });
  const running = runSearches();
  await vi.runAllTimersAsync();
  const r = await running;
  vi.useRealTimers();
  return r;
}

describe('saved-search progress for the side panel', () => {
  it('reports which site is being read, what each found, and when it is done', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const run = runSearches();
    await vi.runAllTimersAsync();
    const r = await run;
    vi.useRealTimers();

    expect(r).toMatchObject({ ok: true, ran: 2 });
    expect(reports[0]).toMatchObject({ running: true, total: 2, index: 0, results: [] });
    expect(reports.some((p) => p.running && p.current === 'LinkedIn' && p.index === 1)).toBe(true);
    expect(reports.some((p) => p.running && p.current === 'Indeed' && p.index === 2)).toBe(true);
    const last = reports.at(-1);
    expect(last).toMatchObject({ running: false, current: null });
    expect(last.finishedAt).toBeGreaterThan(0);
    expect(last.results).toEqual([
      { label: 'LinkedIn', read: 1, matched: 1, added: 1, filtered: 0, problem: null },
      {
        label: 'Indeed',
        read: 0,
        matched: 0,
        added: 0,
        filtered: 0,
        problem: 'The site asked for a robot check.',
      },
    ]);
  });
});

describe('reading the descriptions the server cannot', () => {
  const job = (id, url, site) => ({ applicationId: id, url, site, title: 'TPM', company: 'Acme' });

  it('opens each posting in a background tab and sends its description to the job', async () => {
    missing = [
      job(1, 'https://www.indeed.com/viewjob?jk=1', 'indeed'),
      job(2, 'https://www.indeed.com/viewjob?jk=2', 'indeed'),
      job(3, 'https://www.glassdoor.com/job-listing/x?jl=3', 'glassdoor'),
      job(4, 'https://www.glassdoor.com/job-listing/y?jl=4', 'glassdoor'),
    ];
    await run();

    const postingTabs = opened.filter((o) => !pages[o.url]);
    // Glassdoor asked for a robot check, so its second posting wasn't opened.
    expect(postingTabs.map((o) => o.url)).toEqual(missing.slice(0, 3).map((j) => j.url));
    expect(postingTabs.every((o) => o.active === false)).toBe(true);
    expect(captures).toEqual([
      expect.objectContaining({
        url: 'https://www.indeed.com/viewjob?jk=1',
        fields: { descriptionText: expect.stringContaining('A long description.') },
        templateName: 'Built-in Indeed',
      }),
      expect.objectContaining({ url: 'https://www.indeed.com/viewjob?jk=2', fields: null }),
    ]);
    expect(reports.some((p) => p.reading?.index === 2 && p.reading.total === 4)).toBe(true);
    expect(reports.at(-1)).toMatchObject({
      running: false,
      reading: null,
      descriptions: { added: 1, tried: 4, problem: 'Glassdoor: robot check' },
    });
    // The posting with nothing to read counts a try; the robot check doesn't.
    expect(local.jmDescriptionTries).toEqual({ 'https://www.indeed.com/viewjob?jk=2': 1 });
  });

  it('gives up on a posting after two runs that found nothing', async () => {
    missing = [job(2, 'https://www.indeed.com/viewjob?jk=2', 'indeed')];
    local.jmDescriptionTries = { 'https://www.indeed.com/viewjob?jk=2': 2, 'https://gone': 1 };
    await run();
    expect(captures).toEqual([]);
    expect(reports.at(-1).descriptions).toBeNull();
  });
});

describe('a long run', () => {
  it('keeps the extension worker awake while the server works, and stops after', async () => {
    slowResults = true;
    keptAlive = 0;
    await run();
    slowResults = false;
    // Two searches, a minute each: a call at least every 20 seconds.
    expect(keptAlive).toBeGreaterThanOrEqual(6);
    const after = keptAlive;
    vi.useFakeTimers({ toFake: ['setInterval'] });
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
    expect(keptAlive).toBe(after);
  });
});
