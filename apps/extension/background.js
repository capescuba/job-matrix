// Opens the side panel from the toolbar icon, and adds "Add selection to Job Matrix" to the
// right-click menu.
import { api, openInApp } from './api.js';
import { captureBody, readTab } from './capture.js';
import { importLinkedIn } from './linkedin.js';
import { runSearches } from './search.js';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'jm-add-selection',
    title: 'Add selection to Job Matrix',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'jm-add-selection' || !tab?.id || !tab.url) return;
  try {
    const { page, template } = await readTab(tab.id, tab.url);
    // The menu has the selection even when the page has since lost it.
    page.selectionText = page.selectionText || info.selectionText || '';
    const r = await api('/api/screen/capture', {
      method: 'POST',
      body: captureBody(page, template),
    });
    await openInApp(
      r.existing ? `/applications/${r.applicationId}` : `/screening?focus=${r.applicationId}`,
    );
  } catch (e) {
    console.error('Job Matrix: could not add the selection', e);
  }
});

// ---------- LinkedIn profile import ----------
// Started from Job Matrix's Profile page (an external message from the app's own origin, see
// externally_connectable) or from the side panel on your own profile. One import at a time.
let importing = null;

async function runImport(url) {
  importing ??= (async () => {
    try {
      const read = await importLinkedIn(url);
      const summary = await api('/api/linkedin', { method: 'POST', body: read });
      return { ok: true, summary };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    } finally {
      importing = null;
    }
  })();
  return importing;
}

chrome.runtime.onMessageExternal.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'jm-ping') {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return false;
  }
  // Saved searches: started by the Job Matrix page (Check now, or when they are due). Answers at
  // once; the page follows progress through the server.
  if (msg?.type === 'jm-run-searches') {
    runSearches().then((r) => console.log('Job Matrix saved searches:', r));
    sendResponse({ ok: true, started: true });
    return false;
  }
  if (msg?.type !== 'jm-import-linkedin') return false;
  runImport(msg.url).then(sendResponse);
  return true; // answers later
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'jm-import-linkedin') return false;
  runImport(msg.url).then(sendResponse);
  return true;
});
