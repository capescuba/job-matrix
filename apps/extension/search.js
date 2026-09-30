// Runs your saved job searches (LinkedIn, Indeed, Glassdoor, ZipRecruiter) in your signed-in
// Chrome: opens each results page in a tab, reads the listings, closes the tab and sends them to
// Job Matrix, which sorts them with your watchlist rules. Read-only: it scrolls and reads, and
// never clicks apply, signs in or answers a robot check.

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
      'li[data-occludable-job-id], a[data-jk], li[data-jobid], article[id^="job-card-"]',
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

/**
 * Runs the enabled saved searches (or just `ids`), one at a time. The results tab is brought to
 * the front while it is read (sites only fill in their lists for a visible page), then closed,
 * and the tab you were on is brought back. Returns { ok, ran, errors }.
 */
export function runSearches(ids = null) {
  running ??= (async () => {
    const errors = [];
    let ran = 0;
    try {
      const searches = (await api('/api/crawl/searches')).filter((s) =>
        ids ? ids.includes(s.id) : s.enabled,
      );
      if (!searches.length) return { ok: true, ran: 0, errors };
      await api('/api/crawl/searches/started', { method: 'POST', body: {} });
      const [before] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      for (const s of searches) {
        let tab;
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
          await api(`/api/crawl/searches/${s.id}/results`, {
            method: 'POST',
            body: { listings: result?.listings ?? [], problem: result?.problem ?? null },
          });
          ran++;
          if (result?.problem) errors.push(`${s.label}: ${result.problem}`);
        } catch (e) {
          errors.push(`${s.label}: ${e?.message || e}`);
        } finally {
          if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
          if (before?.id) await chrome.tabs.update(before.id, { active: true }).catch(() => {});
        }
        // A pause between sites, like a person would take.
        await sleep(2500);
      }
      return { ok: true, ran, errors };
    } catch (e) {
      return { ok: false, ran, errors: [...errors, e?.message || String(e)] };
    } finally {
      running = null;
    }
  })();
  return running;
}
