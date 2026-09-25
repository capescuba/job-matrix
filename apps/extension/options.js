import { DEFAULT_SERVER, api, normalizeServer, settings } from './api.js';

const $ = (id) => document.getElementById(id);
const s = await settings();
$('server').value = s.server === DEFAULT_SERVER ? '' : s.server;
$('token').value = s.token ?? '';

$('save').onclick = async () => {
  const server = normalizeServer($('server').value);
  if (!server) {
    $('msg').textContent =
      '✕ That isn’t a server address. Use e.g. http://127.0.0.1:5174 (leave it empty for your Job Matrix).';
    return;
  }
  await chrome.storage.local.set({ server, token: $('token').value.trim() || null });
  $('server').value = server === DEFAULT_SERVER ? '' : server;
  $('msg').textContent = 'Saved.';
};
$('test').onclick = async () => {
  $('msg').textContent = 'Checking…';
  try {
    const r = await api('/api/ext/hello', { onStatus: (t) => ($('msg').textContent = t) });
    const { server } = await settings();
    $('msg').textContent =
      r?.app === 'job-matrix'
        ? `✓ Connected to Job Matrix at ${server}.`
        : `✕ Something answered at ${server}, but it isn’t Job Matrix.`;
  } catch (e) {
    $('msg').textContent = `✕ ${e.message}`;
  }
};
