/** Talking to the Job Matrix Chrome extension from this page (see its externally_connectable). */

/** The Chrome extension's fixed ID (its manifest key), which accepts messages from this app. */
export const EXTENSION_ID = 'keiamknmppkefljklkaceniaafephpcf';

type ChromeRuntime = {
  sendMessage: (id: string, msg: unknown, cb: (r: unknown) => void) => void;
  lastError?: { message?: string };
};
const runtime = () =>
  (window as unknown as { chrome?: { runtime?: ChromeRuntime } }).chrome?.runtime;

/** Asks the extension; null when it isn't installed (or is an older version without this). */
export function toExtension<T>(msg: unknown): Promise<T | null> {
  const rt = runtime();
  if (!rt?.sendMessage) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      rt.sendMessage(EXTENSION_ID, msg, (r) => resolve(rt.lastError ? null : ((r as T) ?? null)));
    } catch {
      resolve(null);
    }
  });
}

/** The extension's version, or null when it can't be reached. */
export async function extensionVersion(): Promise<string | null> {
  const r = await toExtension<{ ok: boolean; version?: string }>({ type: 'jm-ping' });
  return r?.ok ? (r.version ?? '0') : null;
}

const atLeast = (v: string, want: string) => {
  const a = v.split('.').map(Number);
  const b = want.split('.').map(Number);
  for (let i = 0; i < b.length; i++) if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i]!;
  return true;
};

/** Saved searches need extension 0.3 or later. */
export const SEARCHES_VERSION = '0.3.0';

/**
 * Asks the extension to run the saved searches in Chrome (all enabled ones, or just `ids`).
 * Resolves with why it couldn't, or null
 * when the run has started (it goes on in the background).
 */
export async function runSearchesInChrome(ids?: number[]): Promise<string | null> {
  const v = await extensionVersion();
  if (!v)
    return 'The Job Matrix Chrome extension isn’t reachable. Open this page in Chrome with the extension installed.';
  if (!atLeast(v, SEARCHES_VERSION))
    return `The Chrome extension is version ${v}; saved searches need ${SEARCHES_VERSION}. Reload it in chrome://extensions.`;
  const r = await toExtension<{ ok: boolean; started?: boolean }>({
    type: 'jm-run-searches',
    ...(ids && { ids }),
  });
  return r?.started ? null : 'The Chrome extension didn’t start the searches.';
}
