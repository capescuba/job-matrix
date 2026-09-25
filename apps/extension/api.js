// Talking to the local Job Matrix server. The token comes from the native helper
// (scripts/native-host), which also starts Job Matrix when it isn't running.

const HOST = 'com.jobmatrix.host';
export const DEFAULT_SERVER = 'http://127.0.0.1:5174';

export async function settings() {
  const s = await chrome.storage.local.get(['server', 'token']);
  return { server: normalizeServer(s.server) ?? DEFAULT_SERVER, token: s.token || null };
}

/**
 * The server address as an origin ("http://127.0.0.1:5174"), or null if it isn't one — e.g.
 * "http://http://127.0.0.1:5174/", which browsers read as a server called "http".
 */
export function normalizeServer(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return DEFAULT_SERVER;
  let u;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || /^(https?|www)$/i.test(u.hostname)) return null;
  if (u.pathname.replace(/\/+$/, '') || u.search || u.hash || u.username) return null;
  return u.origin;
}

/** Chrome's reason the last helper call failed (e.g. "Specified native messaging host not found."). */
let helperError = null;

/** Asks the native helper; null (and helperError set) when Chrome can't reach it. */
async function helper(message) {
  try {
    const r = await chrome.runtime.sendNativeMessage(HOST, message);
    helperError = null;
    return r;
  } catch (e) {
    helperError = e?.message || String(e);
    console.warn('Job Matrix helper:', helperError);
    return null;
  }
}

const HELPER_FIX =
  'Run scripts\\install-extension.ps1 from a normal PowerShell window (not from inside the Claude app), then try again.';

export class ApiError extends Error {
  constructor(message, status, kind) {
    super(message);
    this.status = status;
    this.kind = kind; // 'offline' | 'token' | 'http'
  }
}

let starting = null;
/** Starts Job Matrix through the helper (once, however many callers are waiting). */
export function startApp(onStatus) {
  onStatus?.('Starting Job Matrix…');
  starting ??= helper({ type: 'start' }).finally(() => (starting = null));
  return starting;
}

async function ensureToken(force = false) {
  const s = await settings();
  if (s.token && !force) return s.token;
  const r = await helper({ type: 'token' });
  if (r?.ok && r.token) {
    await chrome.storage.local.set({ token: r.token });
    return r.token;
  }
  return s.token;
}

/**
 * JSON request to the server. If it isn't answering, starts it (via the helper) and retries once;
 * if the token is wrong, fetches it again once.
 */
export async function api(path, { method = 'GET', body, onStatus } = {}) {
  const attempt = async () => {
    const { server } = await settings();
    const token = await ensureToken();
    return fetch(server + path, {
      method,
      headers: {
        ...(token && { 'X-JM-Token': token }),
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
  let res;
  try {
    res = await attempt();
  } catch {
    const started = await startApp(onStatus);
    if (!started?.ok)
      throw new ApiError(
        started?.error ??
          (helperError
            ? `Can't reach Job Matrix, and the helper that starts it isn't available (Chrome says: ${helperError}). Start Job Matrix from its icon, or ${HELPER_FIX}`
            : "Can't reach Job Matrix. Start it from its icon."),
        0,
        'offline',
      );
    try {
      res = await attempt();
    } catch {
      throw new ApiError(
        "Job Matrix started but isn't answering yet. Try again in a moment.",
        0,
        'offline',
      );
    }
  }
  if (res.status === 401) {
    await ensureToken(true);
    res = await attempt();
    if (res.status === 401)
      throw new ApiError(
        helperError
          ? `Job Matrix needs the extension token, and Chrome couldn't get it from the helper (Chrome says: ${helperError}). ${HELPER_FIX} Or paste the token from data\\extension-token on the Options page.`
          : 'Job Matrix refused the extension token. Clear the token on the Options page so the helper sets it again.',
        401,
        'token',
      );
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || res.statusText, res.status, 'http');
  return data;
}

/** Brings your Job Matrix tab to the front at `path`, or opens one. */
export async function openInApp(path) {
  const { server } = await settings();
  const u = new URL(server);
  const alt =
    u.hostname === '127.0.0.1' ? 'localhost' : u.hostname === 'localhost' ? '127.0.0.1' : null;
  const patterns = [`${u.origin}/*`, ...(alt ? [`${u.protocol}//${alt}:${u.port}/*`] : [])];
  const [tab] = await chrome.tabs.query({ url: patterns });
  if (tab) {
    await chrome.tabs.update(tab.id, { url: new URL(path, tab.url).toString(), active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: server + path });
  }
}
