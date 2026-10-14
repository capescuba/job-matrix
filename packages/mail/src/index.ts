/**
 * Read-only Outlook.com / Hotmail access through Microsoft Graph, for local apps.
 *
 * Shares its sign-in with the email-mcp server (github.com/capescuba/mcp): both keep it in
 * ~/.email-mcp (token.json + config.json with the Azure app ID), so one sign-in serves both.
 * The token file is written atomically and refreshed only when expired, so they can share it.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SCOPES = 'https://graph.microsoft.com/Mail.Read offline_access openid profile';
const REFRESH_SCOPES = 'https://graph.microsoft.com/Mail.Read offline_access';
const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const EARLY_MS = 5 * 60_000;

/** Metadata for listing and filtering; no bodies. */
const META_FIELDS =
  'id,subject,from,replyTo,receivedDateTime,bodyPreview,parentFolderId,webLink,conversationId,internetMessageId';

export class NeedsSignIn extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NeedsSignIn';
  }
}

export class GraphError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

export interface MailAddress {
  name: string | null;
  address: string | null;
}

export interface MailMeta {
  id: string;
  subject: string;
  from: MailAddress;
  replyTo: MailAddress[];
  receivedAt: string;
  preview: string;
  folderId: string | null;
  webLink: string | null;
  conversationId: string | null;
  /** The RFC Message-ID header: unlike `id`, it stays the same when the email moves folders. */
  internetMessageId?: string | null;
}

export interface MailMessage extends MailMeta {
  bodyText: string;
}

export interface SignInCode {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

export interface MailStatus {
  configured: boolean;
  signedIn: boolean;
  account: string | null;
  signingIn: SignInCode | null;
  lastError: string | null;
}

interface SavedToken {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  account?: string | null;
  expires_in?: number;
  saved_at?: number;
  expires_at?: number;
  [k: string]: unknown;
}

type GraphAddress = { emailAddress?: { name?: string; address?: string } } | null | undefined;
type GraphMessage = {
  id: string;
  subject?: string | null;
  from?: GraphAddress;
  replyTo?: GraphAddress[];
  receivedDateTime: string;
  bodyPreview?: string;
  parentFolderId?: string;
  webLink?: string;
  conversationId?: string;
  internetMessageId?: string;
  body?: { content?: string };
};

export function defaultMailDir() {
  return process.env.EMAIL_MCP_DIR || path.join(os.homedir(), '.email-mcp');
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, file);
}

/** The signed-in address, from the ID token Microsoft returns. */
export function accountFromIdToken(idToken: string | undefined): string | null {
  try {
    const payload = JSON.parse(Buffer.from(idToken!.split('.')[1]!, 'base64url').toString('utf8'));
    return payload.preferred_username || payload.email || payload.name || null;
  } catch {
    return null;
  }
}

const address = (a: GraphAddress): MailAddress => ({
  name: a?.emailAddress?.name?.trim() || null,
  address: a?.emailAddress?.address?.trim().toLowerCase() || null,
});

function toMeta(m: GraphMessage): MailMeta {
  return {
    id: m.id,
    subject: m.subject ?? '',
    from: address(m.from),
    replyTo: (m.replyTo ?? []).map(address),
    receivedAt: m.receivedDateTime,
    preview: m.bodyPreview ?? '',
    folderId: m.parentFolderId ?? null,
    webLink: m.webLink ?? null,
    conversationId: m.conversationId ?? null,
    internetMessageId: m.internetMessageId ?? null,
  };
}

export interface MailClientOptions {
  /** Folder holding token.json and config.json (default ~/.email-mcp). */
  dir?: string;
  /** Azure app ID; otherwise config.json's clientId. */
  clientId?: string | null;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Test hook: poll the sign-in this often instead of Microsoft's interval. */
  pollMs?: number;
}

export type MailClient = ReturnType<typeof createMailClient>;

export function createMailClient(opts: MailClientOptions = {}) {
  const dir = opts.dir ?? defaultMailDir();
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  const tokenPath = path.join(dir, 'token.json');
  let signingIn: (SignInCode & { done: Promise<void> }) | null = null;
  let lastError: string | null = null;
  let refreshing: Promise<SavedToken> | null = null;
  const skipFolders = new Map<string, string>(); // Sent Items / Drafts / Outbox ids
  const namedFolders = new Map<string, string>(); // lower-case display name → id

  async function clientId(): Promise<string | null> {
    if (opts.clientId) return opts.clientId;
    return (await readJson<{ clientId?: string }>(path.join(dir, 'config.json')))?.clientId ?? null;
  }
  async function requireClientId() {
    const id = await clientId();
    if (!id)
      throw new NeedsSignIn(
        `No Azure app ID: save {"clientId": "…"} to ${path.join(dir, 'config.json')} (see email-mcp's README).`,
      );
    return id;
  }

  async function postForm(url: string, fields: Record<string, string>) {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });
    return (await res.json()) as Record<string, string | number | undefined> & {
      error?: string;
      error_description?: string;
    };
  }

  const expiresAt = (t: SavedToken) =>
    t.expires_at ?? (t.saved_at ?? 0) + (Number(t.expires_in) || 3600) * 1000;

  async function save(tokens: SavedToken, previous: SavedToken = {}) {
    const t = now();
    const saved: SavedToken = {
      ...tokens,
      refresh_token: tokens.refresh_token || previous.refresh_token,
      id_token: tokens.id_token || previous.id_token,
      account: accountFromIdToken(tokens.id_token) || previous.account || null,
      saved_at: t,
      expires_at: t + (Number(tokens.expires_in) || 3600) * 1000,
    };
    await writeJsonAtomic(tokenPath, saved);
    return saved;
  }

  async function refresh(tok: SavedToken) {
    const data = await postForm(`${AUTHORITY}/token`, {
      client_id: await requireClientId(),
      grant_type: 'refresh_token',
      refresh_token: tok.refresh_token!,
      scope: REFRESH_SCOPES,
    });
    if (data.error) {
      if (
        /invalid_grant|interaction_required|expired|revoked/i.test(
          `${data.error} ${data.error_description}`,
        )
      )
        throw new NeedsSignIn('The saved Outlook sign-in has expired. Connect again.');
      throw new Error(`Microsoft sign-in error: ${data.error}: ${data.error_description ?? ''}`);
    }
    return save(data as SavedToken, tok);
  }

  /** A valid access token; refreshes only when the saved one is (nearly) expired. */
  async function accessToken(): Promise<string> {
    const tok = await readJson<SavedToken>(tokenPath);
    if (!tok?.access_token && !tok?.refresh_token)
      throw new NeedsSignIn('Not connected to Outlook yet.');
    if (tok.access_token && now() < expiresAt(tok) - EARLY_MS) return tok.access_token;
    if (!tok.refresh_token) throw new NeedsSignIn('The saved Outlook sign-in has expired.');
    refreshing ??= refresh(tok).finally(() => {
      refreshing = null;
    });
    return (await refreshing).access_token!;
  }

  async function poll(deviceCode: string, intervalSec: number, deadline: number) {
    let wait = opts.pollMs ?? (intervalSec || 5) * 1000;
    const id = await requireClientId();
    while (now() < deadline) {
      await new Promise((r) => setTimeout(r, wait));
      const data = await postForm(`${AUTHORITY}/token`, {
        client_id: id,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
      });
      if (data.error === 'authorization_pending') continue;
      if (data.error === 'slow_down') {
        wait += 5000;
        continue;
      }
      if (data.error) throw new Error(`${data.error}: ${data.error_description ?? ''}`.trim());
      if (data.access_token) {
        await save(data as SavedToken, (await readJson<SavedToken>(tokenPath)) ?? {});
        return;
      }
    }
    throw new Error('The sign-in code expired before it was entered. Connect again.');
  }

  /** Starts a device-code sign-in; returns the code at once and finishes in the background. */
  async function startSignIn(): Promise<SignInCode & { done: Promise<void> }> {
    if (signingIn && now() < signingIn.expiresAt) return signingIn;
    const data = await postForm(`${AUTHORITY}/devicecode`, {
      client_id: await requireClientId(),
      scope: SCOPES,
    });
    if (data.error)
      throw new Error(`Microsoft sign-in error: ${data.error}: ${data.error_description ?? ''}`);
    const expires = now() + (Number(data.expires_in) || 900) * 1000;
    lastError = null;
    const done = poll(String(data.device_code), Number(data.interval), expires);
    signingIn = {
      userCode: String(data.user_code),
      verificationUri: String(data.verification_uri),
      expiresAt: expires,
      done,
    };
    done.then(
      () => {
        signingIn = null;
      },
      (e: Error) => {
        signingIn = null;
        lastError = e.message;
      },
    );
    return signingIn;
  }

  /** What's saved (no network). */
  async function status(): Promise<MailStatus> {
    const tok = await readJson<SavedToken>(tokenPath);
    const pending = signingIn && now() < signingIn.expiresAt ? signingIn : null;
    return {
      configured: Boolean(await clientId()),
      signedIn: Boolean(tok?.refresh_token || (tok?.access_token && now() < expiresAt(tok))),
      account: tok?.account || accountFromIdToken(tok?.id_token) || null,
      signingIn: pending
        ? {
            userCode: pending.userCode,
            verificationUri: pending.verificationUri,
            expiresAt: pending.expiresAt,
          }
        : null,
      lastError,
    };
  }

  async function get<T>(pathOrUrl: string, { text = false } = {}): Promise<T> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${await accessToken()}` };
    if (text) headers.Prefer = 'outlook.body-content-type="text"';
    const res = await fetchFn(url, { headers });
    if (!res.ok) {
      let detail = '';
      try {
        detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? '';
      } catch {
        // no JSON body
      }
      if (res.status === 401) throw new NeedsSignIn('Microsoft rejected the saved sign-in.');
      throw new GraphError(
        res.status,
        `Outlook error ${res.status}${detail ? `: ${detail}` : ''}`,
        Number(res.headers.get('retry-after')) || undefined,
      );
    }
    return (await res.json()) as T;
  }

  /** Sent Items, Drafts and Outbox: never about applications you received. */
  async function skippedFolderIds() {
    if (!skipFolders.size) {
      for (const name of ['sentitems', 'drafts', 'outbox']) {
        try {
          const f = await get<{ id: string }>(`/me/mailFolders/${name}?$select=id`);
          skipFolders.set(name, f.id);
        } catch (e) {
          if (e instanceof NeedsSignIn) throw e;
        }
      }
    }
    return new Set(skipFolders.values());
  }

  /**
   * Every message received on or after `sinceIso`, oldest first, in pages — from all folders
   * (Inbox, Junk, Deleted Items, your own folders) except Sent Items, Drafts and Outbox.
   * A date-filtered listing, not $search: Graph's all-mail search leaves out Junk and Deleted.
   */
  async function* messagesSince(sinceIso: string, pageSize = 100): AsyncGenerator<MailMeta[]> {
    const skip = await skippedFolderIds();
    const params = new URLSearchParams({
      $select: META_FIELDS,
      $filter: `receivedDateTime ge ${new Date(sinceIso).toISOString()}`,
      $orderby: 'receivedDateTime asc',
      $top: String(pageSize),
    });
    let url: string | undefined = `/me/messages?${params}`;
    while (url) {
      const page: { value: GraphMessage[]; '@odata.nextLink'?: string } = await get(url);
      yield page.value.filter((m) => !skip.has(m.parentFolderId ?? '')).map(toMeta);
      url = page['@odata.nextLink'];
    }
  }

  /**
   * A folder's id by its display name (any case): a top-level folder, else one inside the
   * Inbox. Null when there's no such folder.
   */
  async function folderByName(name: string): Promise<string | null> {
    const key = name.trim().toLowerCase();
    if (!key) return null;
    const cached = namedFolders.get(key);
    if (cached) return cached;
    const filter = `displayName eq '${name.trim().replace(/'/g, "''")}'`;
    for (const parent of ['/me/mailFolders', '/me/mailFolders/inbox/childFolders']) {
      const params = new URLSearchParams({ $filter: filter, $select: 'id,displayName' });
      const res = await get<{ value: { id: string }[] }>(`${parent}?${params}`);
      const id = res.value[0]?.id;
      if (id) {
        namedFolders.set(key, id);
        return id;
      }
    }
    return null;
  }

  /** Every message in one folder, newest first, in pages. */
  async function* messagesIn(folderId: string, pageSize = 50): AsyncGenerator<MailMeta[]> {
    const params = new URLSearchParams({
      $select: META_FIELDS,
      $orderby: 'receivedDateTime desc',
      $top: String(pageSize),
    });
    let url: string | undefined =
      `/me/mailFolders/${encodeURIComponent(folderId)}/messages?${params}`;
    while (url) {
      const page: { value: GraphMessage[]; '@odata.nextLink'?: string } = await get(url);
      yield page.value.map(toMeta);
      url = page['@odata.nextLink'];
    }
  }

  /** One message with its body as plain text. */
  async function message(id: string): Promise<MailMessage> {
    const m = await get<GraphMessage>(
      `/me/messages/${encodeURIComponent(id)}?$select=${META_FIELDS},body`,
      { text: true },
    );
    return { ...toMeta(m), bodyText: (m.body?.content ?? '').trim() };
  }

  return {
    accessToken,
    startSignIn,
    status,
    messagesSince,
    folderByName,
    messagesIn,
    message,
    tokenPath,
  };
}
