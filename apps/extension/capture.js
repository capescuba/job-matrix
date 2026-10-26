// Reading a tab and turning it into Job Matrix requests (used by the side panel and the menu).
import { api } from './api.js';
import { readPage } from './reader.js';

const hostOf = (url) => new URL(url).hostname.toLowerCase();

/** Reads the tab, applying this site's saved template if there is one. */
export async function readTab(tabId, url, onStatus) {
  const template = await api(`/api/ext/templates/${encodeURIComponent(hostOf(url))}`, { onStatus });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: readPage,
    args: [template?.selectors ?? null],
  });
  return { page: result, template };
}

/** Title/company/… from the template first, then the built-in site readers; blanks dropped. */
function fieldsOf(page) {
  const out = {};
  const { site, url, ...glassdoor } = page.siteFields ?? {};
  for (const src of [page.liFields, glassdoor, page.fields])
    for (const [k, v] of Object.entries(src ?? {})) if (v) out[k] = v;
  return out;
}

/** Which reader the fields came from, for "Description from …". */
const readerName = (page, template) =>
  template?.name ??
  (page.liFields
    ? 'LinkedIn (signed in)'
    : page.siteFields
      ? `Built-in ${page.siteFields.site}`
      : null);

/** Body for POST /api/ext/context. */
export function contextBody(page) {
  const f = fieldsOf(page);
  return {
    url: page.url,
    pageTitle: page.pageTitle,
    jsonLd: page.jsonLd,
    fields: f.title || f.company ? { title: f.title ?? null, company: f.company ?? null } : null,
    heading: page.heading ?? null,
  };
}

/** Body for POST /api/screen/capture; `overrides` are the title/company you corrected. */
export function captureBody(page, template, overrides = {}) {
  const f = {
    ...fieldsOf(page),
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v)),
  };
  const hasFields = Object.values(f).some(Boolean);
  return {
    url: page.url,
    pageTitle: page.pageTitle,
    selectionText: page.selectionText || null,
    pageText: page.pageText || null,
    jsonLd: page.jsonLd,
    fields: hasFields
      ? {
          title: f.title ?? null,
          company: f.company ?? null,
          location: f.location ?? null,
          salaryText: f.salaryText ?? null,
          descriptionText: f.descriptionText ?? null,
        }
      : null,
    heading: page.heading ?? null,
    templateName: readerName(page, template),
    linkedin: page.linkedin,
  };
}
