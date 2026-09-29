// Reads your own LinkedIn profile, page by page, in a tab of your signed-in Chrome, for Job
// Matrix's career profile. LinkedIn shows a full profile only to signed-in visitors, so this is
// done here rather than by the Job Matrix server. Read-only: it scrolls, opens "…see more", reads.

/** Details pages, read after the main profile page. A missing section redirects back. */
export const DETAIL_PAGES = [
  ['experience', 'details/experience/'],
  ['projects', 'details/projects/'],
  ['skills', 'details/skills/'],
  ['certifications', 'details/certifications/'],
  ['education', 'details/education/'],
  ['honors', 'details/honors/'],
  ['recommendations', 'details/recommendations/?detailScreenTabIndex=0'],
];

/** "linkedin.com/in/dave-b/details/…" → "https://www.linkedin.com/in/dave-b/", else null. */
export function profileBase(raw) {
  try {
    const s = String(raw ?? '').trim();
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    const slug = u.hostname.endsWith('linkedin.com')
      ? u.pathname.match(/^\/in\/([^/]+)/)?.[1]
      : null;
    return slug ? `https://www.linkedin.com/in/${slug}/` : null;
  } catch {
    return null;
  }
}

/**
 * Runs in the LinkedIn tab (passed to chrome.scripting.executeScript, so it must be
 * self-contained). Loads everything on the page, opens truncated text, and returns the main
 * content as text. `part`: 'top' = the main profile page (headline + About), else a details page.
 */
export async function readLinkedInPage(part) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const main = () => document.querySelector('main') || document.body;
  const signedOut = /\/(authwall|login|checkpoint|uas\/login)/.test(location.pathname);
  if (signedOut) return { url: location.href, signedOut: true };

  // Wait for the content to render.
  for (let i = 0; i < 40 && (main().innerText || '').trim().length < 200; i++) await sleep(250);
  // Scroll to the end so lazily loaded entries appear.
  let last = 0;
  for (let i = 0; i < 25; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(450);
    if (document.body.scrollHeight === last) break;
    last = document.body.scrollHeight;
  }
  // Paged lists ("Show more results") and truncated descriptions ("…see more").
  for (let i = 0; i < 10; i++) {
    const more = [...main().querySelectorAll('button')].find((b) =>
      /^\s*show more results\s*$/i.test(b.innerText || ''),
    );
    if (!more) break;
    more.click();
    await sleep(900);
  }
  for (const b of main().querySelectorAll('button, [role="button"]')) {
    if (/see more/i.test(b.innerText || '') && b.getAttribute('aria-expanded') !== 'true')
      b.click();
  }
  await sleep(600);
  window.scrollTo(0, 0);

  // LinkedIn repeats text for screen readers; hide those copies while reading.
  const style = document.createElement('style');
  style.textContent = '.visually-hidden,.a11y-text{display:none!important}';
  document.head.append(style);
  const read = (el) => (el?.innerText || '').trim();
  let headline = null;
  let text = '';
  try {
    if (part === 'top') {
      const top = main().querySelector('section');
      headline = read(top)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 4)
        .join('\n');
      const about = document.getElementById('about')?.closest('section');
      text = read(about);
    } else {
      text = read(main());
    }
  } finally {
    style.remove();
  }
  // Drop LinkedIn's buttons and furniture, and repeated lines.
  const junk =
    /^(show all.*|show more results|…?\s*see more|see less|show less|endorse|endorsed.*|follow|following|message|more|connect|edit|add.*section|private to you|show credential|show project|see credential|about|activity|\d+ endorsements?|people (also viewed|you may know)|you might like)$/i;
  const lines = [];
  for (const l of text.split('\n').map((x) => x.trim())) {
    if (!l || junk.test(l)) continue;
    if (lines[lines.length - 1] === l) continue;
    lines.push(l);
  }
  return { url: location.href, headline, text: lines.join('\n') };
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
 * Opens your profile in a new tab, reads the main page and each details page, closes the tab.
 * `onStep(text)` reports progress. Returns { url, headline, sections } for POST /api/linkedin.
 */
export async function importLinkedIn(rawUrl, onStep = () => {}) {
  const base = profileBase(rawUrl);
  if (!base) throw new Error('That is not a LinkedIn profile address (linkedin.com/in/…).');
  const tab = await chrome.tabs.create({ url: base, active: true });
  const run = async (part) => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readLinkedInPage,
      args: [part],
    });
    return result;
  };
  const go = async (url) => {
    const loaded = waitForLoad(tab.id);
    await chrome.tabs.update(tab.id, { url });
    await loaded;
    await new Promise((r) => setTimeout(r, 1500));
  };
  try {
    onStep('Reading your profile…');
    await waitForLoad(tab.id);
    await new Promise((r) => setTimeout(r, 1500));
    const top = await run('top');
    if (top?.signedOut) throw new Error('Sign in to LinkedIn in Chrome first, then import again.');
    const sections = { about: top?.text || null };
    for (const [key, path] of DETAIL_PAGES) {
      onStep(`Reading ${key}…`);
      await go(base + path);
      const got = await run('details');
      // LinkedIn sends you back to the profile when a section doesn't exist.
      if (!got || got.signedOut || !/\/details\//.test(got.url)) continue;
      sections[key] = got.text || null;
    }
    return { url: base, headline: top?.headline || null, sections };
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}
