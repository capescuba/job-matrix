// Runs your saved job searches (LinkedIn, Indeed, Glassdoor, ZipRecruiter) in your signed-in
// Chrome: opens each results page in a tab, reads the listings, closes the tab and sends them to
// Job Matrix, which sorts them with your watchlist rules. Then it opens the postings the server
// can't read (Indeed, Glassdoor, …) for the inbox jobs that still lack a description, and sends
// each description back. Read-only: it scrolls and reads, and never clicks apply, signs in or
// answers a robot check.

import { api } from './api.js';

/**
 * Runs in the results tab (passed to chrome.scripting.executeScript, so it must be
 * self-contained). Returns { listings: [{ url, title, company, location, pay, snippet }] } or
 * { problem } when the page can't be read.
 */
export async function readSearchPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  const lines = (el) =>
    (el?.innerText || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  const host = location.hostname;

  // Give the page time to render its list.
  const ready = () =>
    document.querySelector(
      'li[data-occludable-job-id], a[data-jk], li[data-jobid], article[id^="job-card-"], [data-testid="job-card"]',
    );
  for (let i = 0; i < 40 && !ready(); i++) await sleep(250);

  const body = document.body?.innerText || '';
  if (
    /just a moment|attention required|access denied|security check/i.test(document.title) ||
    /verify you are (a )?human|additional verification required|unusual (activity|traffic)|complete the captcha/i.test(
      body.slice(0, 3000),
    )
  )
    return {
      problem:
        'The site asked for a robot check; open the search in Chrome yourself once, then try again.',
    };
  if (/\/(authwall|login|checkpoint|uas\/login)/.test(location.pathname))
    return { problem: 'Signed out: sign in to this site in Chrome, then try again.' };

  const out = [];
  const seen = new Set();
  const add = (l) => {
    if (!l.url || seen.has(l.url)) return;
    seen.add(l.url);
    out.push(l);
  };
  const payLine = (el) => lines(el).find((l) => /\$\s?\d/.test(l)) || null;

  if (host.endsWith('linkedin.com')) {
    // The list renders cards only near the viewport, and only while the tab is on screen. Bring
    // each into view to fill it in; one that stays empty is sent by its id alone, and Job Matrix
    // reads that posting itself.
    const visible = document.visibilityState === 'visible';
    for (const li of document.querySelectorAll('li[data-occludable-job-id]')) {
      if (visible) {
        li.scrollIntoView({ block: 'center' });
        for (let i = 0; i < 8 && !li.querySelector('a[href*="/jobs/view/"]'); i++) await sleep(150);
      }
      const id = li.getAttribute('data-occludable-job-id');
      const a = li.querySelector('a[href*="/jobs/view/"]');
      const title =
        text(a?.querySelector('strong')) || (a?.innerText || '').split('\n')[0]?.trim() || null;
      add({
        url: `https://www.linkedin.com/jobs/view/${id}/`,
        title,
        company: text(li.querySelector('.artdeco-entity-lockup__subtitle')) || null,
        location: text(li.querySelector('.artdeco-entity-lockup__caption')) || null,
        pay: payLine(li),
        snippet: null,
      });
    }
  } else if (/(^|\.)indeed\.com$/.test(host)) {
    for (const a of document.querySelectorAll('a[data-jk]')) {
      const card = a.closest('li') || a.closest('.job_seen_beacon') || a.parentElement;
      add({
        url: `https://${host}/viewjob?jk=${a.getAttribute('data-jk')}`,
        title: a.querySelector('span[title]')?.getAttribute('title') || text(a),
        company: text(card.querySelector('[data-testid="company-name"]')) || null,
        location: text(card.querySelector('[data-testid="text-location"]')) || null,
        pay: payLine(card),
        snippet:
          text(card.querySelector('[data-testid="jobsnippet_footer"], .job-snippet')) || null,
      });
    }
  } else if (/(^|\.)glassdoor\./.test(host)) {
    for (const li of document.querySelectorAll('li[data-jobid]')) {
      const a = li.querySelector('a[data-test="job-title"]');
      if (!a) continue;
      const u = new URL(a.href);
      const jl = u.searchParams.get('jl') || li.getAttribute('data-jobid');
      const ls = lines(li);
      const title = text(a);
      add({
        url: `${u.origin}${u.pathname}?jl=${jl}`,
        title,
        // The employer's name is the first line of the card (before the rating and title).
        company: ls.find((l) => l !== title && !/^\d(\.\d)?$/.test(l)) || null,
        location: text(li.querySelector('[data-test="emp-location"]')) || null,
        pay: text(li.querySelector('[data-test="detailSalary"]')) || null,
        snippet: ls.find((l) => l.length > 80) || null,
      });
    }
  } else if (/(^|\.)ziprecruiter\.com$/.test(host)) {
    // Scroll to load more cards.
    for (let i = 0; i < 4; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(700);
    }
    for (const card of document.querySelectorAll('article[id^="job-card-"]')) {
      const lk = card.id.replace(/^job-card-/, '');
      const title = text(card.querySelector('h2'));
      const ls = lines(card);
      const i = ls.indexOf(title);
      // The page repeats some cards as one run-together line; the laid-out copy has the parts.
      if (i < 0) continue;
      const u = new URL(location.href);
      u.searchParams.set('lk', lk);
      add({
        url: u.toString(),
        title,
        company: text(card.querySelector('a[href^="/co/"]')) || (i > 0 ? ls[i - 1] : null),
        location: i >= 0 ? ls[i + 1] || null : null,
        pay: payLine(card),
        snippet: null,
      });
    }
  } else if (/(^|\.)dice\.com$/.test(host)) {
    // Each card: title, company, "Hybrid in Pleasanton, California • Yesterday", type, pay.
    for (const card of document.querySelectorAll('[data-testid="job-card"]')) {
      const a = card.querySelector('a[href*="/job-detail/"]');
      if (!a) continue;
      const u = new URL(a.href);
      const ls = lines(card);
      const company = text(card.querySelector('[data-testid="job-card-company-name"]')) || ls[1];
      const title =
        a
          .getAttribute('aria-label')
          ?.replace(/^View Details for /, '')
          .replace(/\s*\([0-9a-f]{16,}\)$/, '') || ls[0];
      const at = ls.findIndex((l) => l.includes('•'));
      // Employment type and pay come after the place line (the title can say "contract" too).
      const rest = at >= 0 ? ls.slice(at + 1) : [];
      add({
        url: `${u.origin}${u.pathname}`,
        title,
        company: company || null,
        location: at >= 0 ? ls[at].split('•')[0].trim() : null,
        pay: rest.find((l) => /\$\s?\d|USD\s?\d|per (year|hour)|^\d+\s*-\s*\d+$/.test(l)) || null,
        employmentType:
          rest.find((l) => /full[- ]?time|part[- ]?time|contract|third party/i.test(l)) || null,
        snippet: null,
      });
    }
  } else {
    return { problem: `Not a supported search site (${host}).` };
  }
  if (!out.length)
    return {
      problem: 'No listings found on the page (the layout may have changed).',
      listings: [],
    };
  return { listings: out };
}

/**
 * Runs in a job posting's tab (passed to chrome.scripting.executeScript, so it must be
 * self-contained). `saved` is the description selector from your template for this site, if
 * any. Returns { descriptionText, jsonLd, pageTitle } or { problem } when the page can't be read.
 */
export async function readPosting(saved) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (el) =>
    el ? (el.innerText || el.textContent || '').replace(/\s+\n/g, '\n').trim() : '';
  const SELECTORS = [
    saved,
    '#jobDescriptionText', // Indeed
    '[class*="JobDetails_jobDescription"]', // Glassdoor
    '[data-test="jobDescriptionContent"]',
    '.job_description', // ZipRecruiter
    '[class*="job_description"]',
    '#job-details', // LinkedIn
    '.jobs-description__content',
    '.description__text',
    '[data-testid="jobDescriptionHtml"]', // Dice
    '#jobDescription',
  ].filter(Boolean);
  const described = () => {
    for (const sel of SELECTORS) {
      try {
        const t = text(document.querySelector(sel));
        if (t.length >= 200) return t;
      } catch {
        // a saved selector that no longer parses
      }
    }
    return null;
  };
  const ld = () =>
    [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map((s) => s.textContent || '')
      .filter(Boolean)
      .slice(0, 20);
  const hasPosting = () => ld().some((b) => /"JobPosting"/.test(b));

  // Give the page time to render the description.
  for (let i = 0; i < 40 && !described() && !hasPosting(); i++) await sleep(250);

  const body = document.body?.innerText || '';
  if (
    /just a moment|attention required|access denied|security check/i.test(document.title) ||
    /verify you are (a )?human|additional verification required|unusual (activity|traffic)|complete the captcha/i.test(
      body.slice(0, 3000),
    )
  )
    return { problem: 'robot check' };
  if (/\/(authwall|login|checkpoint|uas\/login)/.test(location.pathname))
    return { problem: 'signed out' };
  return { descriptionText: described(), jsonLd: ld(), pageTitle: document.title };
}

function waitForLoad(tabId, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listen);
      resolve();
    };
    const listen = (id, info) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listen);
  });
}

/**
 * Runs in a Glassdoor tab: Glassdoor takes a place only by its own id, so look the typed place up
 * with Glassdoor's own place search. Returns { locT, locId, name } or null.
 */
export async function findGlassdoorPlace(term) {
  try {
    const r = await fetch(
      `/autocomplete/location?locationTypeFilters=CITY,STATE,COUNTRY&caller=jobs&term=${encodeURIComponent(term)}`,
      { credentials: 'include' },
    );
    const [hit] = await r.json();
    return hit
      ? { locT: hit.locationType, locId: hit.locationId ?? hit.id, name: hit.label }
      : null;
  } catch {
    return null;
  }
}

/** A Glassdoor search saved with the place as text: the address with Glassdoor's id for it. */
async function glassdoorAddress(tabId, url) {
  const u = new URL(url);
  const term = u.searchParams.get('locKeyword');
  if (!term) return null;
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: findGlassdoorPlace,
    args: [term],
  });
  if (!result?.locId) return { problem: `Glassdoor doesn't know the place “${term}”.` };
  u.searchParams.delete('locKeyword');
  u.searchParams.set('locT', result.locT);
  u.searchParams.set('locId', String(result.locId));
  return { url: u.toString() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let running = null;

/** Where the side panel reads a run's progress (session storage: gone when Chrome closes). */
export const RUN_KEY = 'jmSearchRun';

/**
 * The run's progress, shared with the side panel: { running, total, index, current, results:
 * [{ label, read, matched, added, filtered, problem }], server: { matched, checking, added,
 * filtered } while Job Matrix sorts a site's listings, reading: { index, total } while
 * descriptions are read, descriptions: { added, tried, problem }, startedAt, finishedAt }.
 */
let progress = null;
async function report(patch) {
  progress = { ...progress, ...patch };
  await chrome.storage.session.set({ [RUN_KEY]: progress }).catch(() => {});
}
/** One site done: what it read and what became of it (or why it couldn't be read). */
const finished = (label, read, counts, problem) =>
  report({
    results: [
      ...(progress?.results ?? []),
      {
        label,
        read,
        matched: counts?.matched ?? 0,
        added: counts?.added ?? 0,
        filtered: counts?.filtered ?? 0,
        problem: problem ?? null,
      },
    ],
  });

/** Postings whose description couldn't be read, by address: how many runs have tried. */
const TRIES_KEY = 'jmDescriptionTries';
/** Runs to try a posting before leaving it to you (it may be closed, or laid out differently). */
const MAX_TRIES = 2;
const SITE_LABEL = {
  linkedin: 'LinkedIn',
  indeed: 'Indeed',
  glassdoor: 'Glassdoor',
  ziprecruiter: 'ZipRecruiter',
  dice: 'Dice',
};

/**
 * Opens each inbox job from a search site that has no description yet, in a background tab, one
 * at a time, reads the description and sends it to Job Matrix. A site that asks for a robot
 * check is left alone for the rest of the run. Returns { added, tried, problem }, or null when
 * there was nothing to read.
 */
async function readDescriptions() {
  const jobs = await api('/api/crawl/searches/missing-descriptions');
  const stored = (await chrome.storage.local.get(TRIES_KEY))?.[TRIES_KEY] ?? {};
  // Only the jobs still waiting are kept, so the record stays small.
  const tries = Object.fromEntries(
    jobs.map((j) => [j.url, stored[j.url] ?? 0]).filter(([, n]) => n),
  );
  const todo = jobs.filter((j) => (tries[j.url] ?? 0) < MAX_TRIES);
  if (!todo.length) return null;
  const blocked = new Map();
  const templates = {};
  let added = 0;
  for (const [i, j] of todo.entries()) {
    if (blocked.has(j.site)) continue;
    await report({ reading: { index: i + 1, total: todo.length } });
    let tab;
    try {
      const host = new URL(j.url).hostname.toLowerCase();
      templates[host] ??= await api(`/api/ext/templates/${encodeURIComponent(host)}`).catch(
        () => null,
      );
      const template = templates[host];
      tab = await chrome.tabs.create({ url: j.url, active: false });
      await waitForLoad(tab.id);
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: readPosting,
        args: [template?.selectors?.description ?? null],
      });
      if (result?.problem) {
        // The site's doing, not the posting's: tried again next run.
        blocked.set(j.site, result.problem);
        continue;
      }
      const r = await api('/api/screen/capture', {
        method: 'POST',
        body: {
          // The address Job Matrix has, so the capture finds the job however the site redirected.
          url: j.url,
          pageTitle: result?.pageTitle ?? null,
          jsonLd: result?.jsonLd ?? null,
          fields: result?.descriptionText ? { descriptionText: result.descriptionText } : null,
          templateName: template?.name ?? `Built-in ${SITE_LABEL[j.site] ?? j.site}`,
        },
      });
      if (r.descriptionAdded) {
        added++;
        delete tries[j.url];
      } else tries[j.url] = (tries[j.url] ?? 0) + 1;
    } catch {
      tries[j.url] = (tries[j.url] ?? 0) + 1;
    } finally {
      if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
    }
    // A pause between postings, like a person would take.
    await sleep(2000 + Math.random() * 2000);
  }
  await chrome.storage.local.set({ [TRIES_KEY]: tries }).catch(() => {});
  const problem = [...blocked]
    .map(([site, why]) => `${SITE_LABEL[site] ?? site}: ${why}`)
    .join('; ');
  return { added, tried: todo.length, problem: problem || null };
}

/**
 * Runs the enabled saved searches (or just `ids`), one at a time. The results tab is brought to
 * the front while it is read (sites only fill in their lists for a visible page), then closed,
 * and the tab you were on is brought back. Progress goes to the side panel. Returns
 * { ok, ran, errors }.
 */
export function runSearches(ids = null) {
  running ??= (async () => {
    const errors = [];
    let ran = 0;
    // Chrome stops an idle extension worker after 30 seconds, and waiting on a reply doesn't
    // count: the pre-screen of a busy results page takes minutes, which ended runs half-way
    // (no description pass, the panel stuck on "Searching"). An extension call every 20 seconds
    // keeps the worker up until the run is done.
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20_000);
    try {
      const searches = (await api('/api/crawl/searches')).filter((s) =>
        ids ? ids.includes(s.id) : s.enabled,
      );
      if (!searches.length) return { ok: true, ran: 0, errors };
      await api('/api/crawl/searches/started', { method: 'POST', body: {} });
      progress = null;
      await report({
        running: true,
        total: searches.length,
        index: 0,
        current: null,
        results: [],
        server: null,
        reading: null,
        descriptions: null,
        startedAt: Date.now(),
        finishedAt: null,
      });
      const [before] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      for (const [i, s] of searches.entries()) {
        let tab;
        await report({ index: i + 1, current: s.label });
        try {
          tab = await chrome.tabs.create({ url: s.url, active: true });
          await waitForLoad(tab.id);
          await sleep(2000);
          if (s.site === 'glassdoor') {
            const fixed = await glassdoorAddress(tab.id, s.url);
            if (fixed?.problem) {
              await api(`/api/crawl/searches/${s.id}/results`, {
                method: 'POST',
                body: { listings: [], problem: fixed.problem },
              });
              errors.push(`${s.label}: ${fixed.problem}`);
              await finished(s.label, 0, null, fixed.problem);
              continue;
            }
            if (fixed?.url) {
              // Remembered, so the lookup happens once.
              await api(`/api/crawl/searches/${s.id}`, {
                method: 'PATCH',
                body: { url: fixed.url },
              });
              const loaded = waitForLoad(tab.id);
              await chrome.tabs.update(tab.id, { url: fixed.url });
              await loaded;
              await sleep(2000);
            }
          }
          const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: readSearchPage,
          });
          // Job Matrix reads postings and pre-screens the matches before it answers, which can
          // take minutes: show how far it has got meanwhile.
          const following = setInterval(async () => {
            const st = await api('/api/crawl/status').catch(() => null);
            const at = st?.searching?.find((x) => x.searchId === s.id);
            if (at) await report({ server: at });
          }, 2000);
          const counts = await api(`/api/crawl/searches/${s.id}/results`, {
            method: 'POST',
            body: { listings: result?.listings ?? [], problem: result?.problem ?? null },
          }).finally(() => clearInterval(following));
          await report({ server: null });
          ran++;
          if (result?.problem) errors.push(`${s.label}: ${result.problem}`);
          await finished(s.label, result?.listings?.length ?? 0, counts, result?.problem);
        } catch (e) {
          errors.push(`${s.label}: ${e?.message || e}`);
          await finished(s.label, 0, null, e?.message || String(e));
        } finally {
          if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
          if (before?.id) await chrome.tabs.update(before.id, { active: true }).catch(() => {});
        }
        // A pause between sites, like a person would take.
        await sleep(2500);
      }
      await report({ current: 'job descriptions' });
      try {
        const descriptions = await readDescriptions();
        if (descriptions) await report({ descriptions });
      } catch (e) {
        errors.push(`Job descriptions: ${e?.message || e}`);
        await report({
          descriptions: { added: 0, tried: 0, problem: e?.message || String(e) },
        });
      } finally {
        await report({ reading: null });
      }
      return { ok: true, ran, errors };
    } catch (e) {
      if (progress) await report({ problem: e?.message || String(e) });
      return { ok: false, ran, errors: [...errors, e?.message || String(e)] };
    } finally {
      clearInterval(keepAlive);
      if (progress?.running)
        await report({ running: false, current: null, finishedAt: Date.now() });
      running = null;
    }
  })();
  return running;
}
