import { DEFAULT_SERVER, api, settings } from './api.js';

const $ = (id) => document.getElementById(id);
const s = await settings();
$('server').value = s.server === DEFAULT_SERVER ? '' : s.server;
$('token').value = s.token ?? '';

$('save').onclick = async () => {
  await chrome.storage.local.set({
    server: $('server').value.trim() || DEFAULT_SERVER,
    token: $('token').value.trim() || null,
  });
  $('msg').textContent = 'Saved.';
};
$('test').onclick = async () => {
  $('msg').textContent = 'Checking…';
  try {
    await api('/api/ext/hello', { onStatus: (t) => ($('msg').textContent = t) });
    $('msg').textContent = '✓ Connected to Job Matrix.';
  } catch (e) {
    $('msg').textContent = `✕ ${e.message}`;
  }
};
