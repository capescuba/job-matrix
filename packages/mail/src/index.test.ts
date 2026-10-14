import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NeedsSignIn, createMailClient } from './index.ts';

const idToken = (claims: object) =>
  ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'jm-mail-'));

type Handler = (url: URL, init?: RequestInit) => unknown;
function fakeFetch(handler: Handler) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const out = handler(url, init);
    const [status, body] = Array.isArray(out) ? out : [200, out];
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return Object.assign(fn, { calls });
}

async function signedIn(dir: string, extra: object = {}) {
  await fs.writeFile(
    path.join(dir, 'token.json'),
    JSON.stringify({
      access_token: 'at',
      refresh_token: 'rt',
      expires_at: Date.now() + 3_600_000,
      ...extra,
    }),
  );
}

describe('mail client sign-in', () => {
  it('says it is not connected without calling Microsoft', async () => {
    const fetchFn = fakeFetch(() => ({}));
    const c = createMailClient({ dir: await tmp(), clientId: 'app', fetchFn });
    await expect(c.accessToken()).rejects.toBeInstanceOf(NeedsSignIn);
    expect(fetchFn.calls).toHaveLength(0);
    expect(await c.status()).toMatchObject({ configured: true, signedIn: false });
  });

  it('reads the app ID from the shared config.json', async () => {
    const dir = await tmp();
    const c = createMailClient({ dir, fetchFn: fakeFetch(() => ({})) });
    expect((await c.status()).configured).toBe(false);
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ clientId: 'shared' }));
    expect((await c.status()).configured).toBe(true);
  });

  it('returns the code at once and saves the sign-in when it completes', async () => {
    const dir = await tmp();
    const tokens = [
      { error: 'authorization_pending' },
      {
        access_token: 'at1',
        refresh_token: 'rt1',
        expires_in: 3600,
        id_token: idToken({ preferred_username: 'me@hotmail.com' }),
      },
    ];
    const fetchFn = fakeFetch((u) =>
      u.pathname.endsWith('/devicecode')
        ? {
            user_code: 'CODE1',
            device_code: 'dc',
            verification_uri: 'https://microsoft.com/link',
            expires_in: 900,
          }
        : tokens.shift(),
    );
    const c = createMailClient({ dir, clientId: 'app', fetchFn, pollMs: 1 });
    const s = await c.startSignIn();
    expect(s.userCode).toBe('CODE1');
    expect((await c.status()).signingIn?.userCode).toBe('CODE1');
    await s.done;
    expect(await c.status()).toMatchObject({
      signedIn: true,
      account: 'me@hotmail.com',
      signingIn: null,
    });
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'token.json'), 'utf8'));
    expect(saved.refresh_token).toBe('rt1');
  });

  it('refreshes only an expired token, once, keeping the account', async () => {
    const dir = await tmp();
    await signedIn(dir, { expires_at: 0, account: 'me@hotmail.com' });
    const fetchFn = fakeFetch(() => ({
      access_token: 'new',
      refresh_token: 'rt2',
      expires_in: 3600,
    }));
    const c = createMailClient({ dir, clientId: 'app', fetchFn });
    expect(await Promise.all([c.accessToken(), c.accessToken()])).toEqual(['new', 'new']);
    expect(fetchFn.calls).toHaveLength(1);
    expect(await c.accessToken()).toBe('new');
    expect(fetchFn.calls).toHaveLength(1);
    expect((await c.status()).account).toBe('me@hotmail.com');
  });

  it('turns an expired refresh token into NeedsSignIn', async () => {
    const dir = await tmp();
    await signedIn(dir, { expires_at: 0 });
    const c = createMailClient({
      dir,
      clientId: 'app',
      fetchFn: fakeFetch(() => ({ error: 'invalid_grant', error_description: 'expired' })),
    });
    await expect(c.accessToken()).rejects.toBeInstanceOf(NeedsSignIn);
  });
});

describe('mail client reading', () => {
  const msg = (id: string, folder: string, at: string) => ({
    id,
    subject: `s-${id}`,
    from: { emailAddress: { name: 'Box Recruiting', address: 'Jobs@Box.com' } },
    receivedDateTime: at,
    parentFolderId: folder,
    bodyPreview: 'p',
  });

  it('lists every folder since a date, oldest first, paging, without Sent/Drafts/Outbox', async () => {
    const dir = await tmp();
    await signedIn(dir);
    const pages = [
      {
        value: [
          msg('a', 'INBOX', '2026-09-01T00:00:00Z'),
          msg('s', 'SENT', '2026-09-02T00:00:00Z'),
        ],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=2',
      },
      { value: [msg('j', 'JUNK', '2026-09-03T00:00:00Z')] },
    ];
    const fetchFn = fakeFetch((u) => {
      const f = u.pathname.match(/mailFolders\/(\w+)$/)?.[1];
      if (f) return { id: { sentitems: 'SENT', drafts: 'DRAFTS', outbox: 'OUTBOX' }[f] };
      return pages.shift();
    });
    const c = createMailClient({ dir, clientId: 'app', fetchFn });
    const got = [];
    for await (const page of c.messagesSince('2026-09-01')) got.push(...page);
    expect(got.map((m) => m.id)).toEqual(['a', 'j']);
    expect(got[0]!.from).toEqual({ name: 'Box Recruiting', address: 'jobs@box.com' });
    const list = fetchFn.calls.find((c) => c.url.pathname === '/v1.0/me/messages')!.url;
    expect(list.searchParams.get('$filter')).toBe('receivedDateTime ge 2026-09-01T00:00:00.000Z');
    expect(list.searchParams.get('$orderby')).toBe('receivedDateTime asc');
    expect(list.searchParams.get('$search')).toBeNull();
  });

  it('reads a body as plain text', async () => {
    const dir = await tmp();
    await signedIn(dir);
    const fetchFn = fakeFetch(() => ({
      ...msg('m1', 'INBOX', '2026-09-01T00:00:00Z'),
      body: { content: ' Hello \n' },
    }));
    const c = createMailClient({ dir, clientId: 'app', fetchFn });
    expect((await c.message('m1')).bodyText).toBe('Hello');
    expect((fetchFn.calls[0]!.init!.headers as Record<string, string>).Prefer).toBe(
      'outlook.body-content-type="text"',
    );
  });

  it('finds a folder by name at the top level, else inside the Inbox, and remembers it', async () => {
    const dir = await tmp();
    await signedIn(dir);
    const fetchFn = fakeFetch((u) =>
      u.pathname.endsWith('/inbox/childFolders') && u.searchParams.get('$filter')?.includes('Job')
        ? { value: [{ id: 'LEADS' }] }
        : { value: [] },
    );
    const c = createMailClient({ dir, clientId: 'app', fetchFn });
    expect(await c.folderByName('Job leads')).toBe('LEADS');
    expect(await c.folderByName('job LEADS')).toBe('LEADS');
    expect(fetchFn.calls).toHaveLength(2);
    expect(fetchFn.calls[0]!.url.searchParams.get('$filter')).toBe("displayName eq 'Job leads'");
    expect(await c.folderByName("Bob's")).toBeNull();
    expect(fetchFn.calls[2]!.url.searchParams.get('$filter')).toBe("displayName eq 'Bob''s'");
  });

  it("lists one folder's messages, newest first, paging, with the Message-ID header", async () => {
    const dir = await tmp();
    await signedIn(dir);
    const pages = [
      {
        value: [{ ...msg('b', 'LEADS', '2026-09-02T00:00:00Z'), internetMessageId: '<b@x>' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/LEADS/messages?$skip=1',
      },
      { value: [msg('a', 'LEADS', '2026-09-01T00:00:00Z')] },
    ];
    const fetchFn = fakeFetch(() => pages.shift());
    const c = createMailClient({ dir, clientId: 'app', fetchFn });
    const got = [];
    for await (const page of c.messagesIn('LEADS')) got.push(...page);
    expect(got.map((m) => [m.id, m.internetMessageId])).toEqual([
      ['b', '<b@x>'],
      ['a', null],
    ]);
    const first = fetchFn.calls[0]!.url;
    expect(first.pathname).toBe('/v1.0/me/mailFolders/LEADS/messages');
    expect(first.searchParams.get('$orderby')).toBe('receivedDateTime desc');
    expect(first.searchParams.get('$select')).toContain('internetMessageId');
  });

  it("lists a conversation's messages, newest first", async () => {
    const dir = await tmp();
    await signedIn(dir);
    const fetchFn = fakeFetch(() => ({
      value: [
        msg('old', 'INBOX', '2026-09-01T00:00:00Z'),
        msg('new', 'SENT', '2026-09-02T00:00:00Z'),
      ],
    }));
    const c = createMailClient({ dir, clientId: 'app', fetchFn });
    expect((await c.messagesInConversation("AQQk'x")).map((m) => m.id)).toEqual(['new', 'old']);
    expect(fetchFn.calls[0]!.url.searchParams.get('$filter')).toBe("conversationId eq 'AQQk''x'");
  });

  it('a 401 from Graph means signing in again', async () => {
    const dir = await tmp();
    await signedIn(dir);
    const c = createMailClient({ dir, clientId: 'app', fetchFn: fakeFetch(() => [401, {}]) });
    await expect(c.message('x')).rejects.toBeInstanceOf(NeedsSignIn);
  });
});
