// Opens the side panel from the toolbar icon, and adds "Add selection to Job Matrix" to the
// right-click menu.
import { api, openInApp } from './api.js';
import { captureBody, readTab } from './capture.js';

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
