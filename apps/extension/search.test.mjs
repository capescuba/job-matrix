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
let nextTab = 1;
const tabUrls = {};
const listeners = new Set();
globalThis.chrome = {
  storage: {
    local: { get: async () => ({ token: 't', server: 'http://127.0.0.1:5174' }) },
    session: {
      set: async (o) => {
        for (const v of Object.values(o)) reports.push(structuredClone(v));
      },
    },
  },
  runtime: { sendNativeMessage: async () => null },
  tabs: {
    query: async () => [{ id: 99 }],
    create: async ({ url }) => {
      const id = nextTab++;
      tabUrls[id] = url;
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
    executeScript: async ({ target }) => [{ result: pages[tabUrls[target.tabId]] }],
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
  if (path === '/api/crawl/searches/1/results')
    return json({ seen: 1, matched: 1, added: 1, filtered: 0, screened: 0, waiting: 0 });
  if (path === '/api/crawl/searches/2/results')
    return json({ seen: 0, matched: 0, added: 0, filtered: 0, screened: 0, waiting: 0 });
  return new Response('{}', { status: 404 });
});

const { runSearches } = await import('./search.js');

beforeEach(() => {
  reports.length = 0;
});

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
