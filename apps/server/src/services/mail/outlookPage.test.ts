import { beforeEach, describe, expect, it } from 'vitest';
import { GraphError, NeedsSignIn, type MailClient, type MailMeta } from '@jm/mail';
import { openDb, type Db } from '../../db/client.ts';
import { mailLeads } from '../../db/schema.ts';
import { getApplicationDetail } from '../applications.ts';
import { pageContext } from '../extension.ts';
import { syncLeads } from './leads.ts';
import { addEmailLead, emailContext, outlookMessageId } from './outlookPage.ts';

const ID = 'AQMkADAwATE0YTQwLTdl/ZmQtYTQ4Ny0wMAItMDAKAEYAAANm+wkw==';

describe('which email is open in Outlook on the web', () => {
  it('reads the id from the reading pane address or a deep link', () => {
    const enc = encodeURIComponent(ID);
    expect(outlookMessageId(`https://outlook.live.com/mail/0/inbox/id/${enc}`)).toBe(ID);
    expect(outlookMessageId(`https://outlook.live.com/mail/0/AQMkFolder%3D%3D/id/${enc}`)).toBe(ID);
    expect(outlookMessageId(`https://outlook.office.com/mail/id/${enc}?nlp=1`)).toBe(ID);
    expect(
      outlookMessageId(
        `https://outlook.live.com/owa/?ItemID=${enc}&exvsurl=1&viewmodel=ReadMessageItem`,
      ),
    ).toBe(ID);
    expect(
      outlookMessageId(`https://outlook.live.com/mail/deeplink/read/${enc}?ItemID=${enc}`),
    ).toBe(ID);
    expect(outlookMessageId(`https://outlook.live.com/mail/deeplink/read/${enc}`)).toBe(ID);
    expect(outlookMessageId('https://outlook.live.com/mail/0/inbox')).toBeNull();
    expect(outlookMessageId(`https://outlook.live.com/calendar/0/id/${enc}`)).toBeNull();
    expect(outlookMessageId(`https://example.com/mail/0/inbox/id/${enc}`)).toBeNull();
  });
});

const JD = `Hi Dave,\n\nTitle: Senior Technical Program Manager\nClient: Contoso\n\nLead cross-team programs for the platform org, own roadmaps and launches.`;

type Mail = MailMeta & { body: string };
const mail = (id: string, over: Partial<Mail> = {}): Mail => ({
  id,
  subject: 'Exciting opportunity',
  body: JD,
  from: { name: 'Jane Doe', address: 'jane@teksystems.com' },
  replyTo: [],
  receivedAt: '2026-10-10T15:00:00Z',
  preview: '',
  folderId: 'INBOX',
  webLink: `https://outlook.live.com/owa/?ItemID=${id}`,
  conversationId: null,
  internetMessageId: '<lead1@mail>',
  ...over,
});

/** A mailbox holding `messages` (by current id); `signedOut` makes every read fail. */
function fakeClient(messages: Mail[], { signedOut = false, folder = [] as Mail[] } = {}) {
  return {
    folderByName: async () => 'LEADS',
    async *messagesIn() {
      yield folder.map(({ body: _b, ...m }) => m);
    },
    status: async () => ({ account: 'me@hotmail.com' }),
    async messagesInConversation(conv: string) {
      if (signedOut) throw new NeedsSignIn('Not connected to Outlook yet.');
      return [...messages, ...folder]
        .filter((m) => m.conversationId === conv)
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
        .map(({ body: _b, ...m }) => m);
    },
    async message(id: string) {
      if (signedOut) throw new NeedsSignIn('Not connected to Outlook yet.');
      const m = [...messages, ...folder].find((x) => x.id === id);
      if (!m) throw new GraphError(404, 'Outlook error 404');
      return { ...m, bodyText: m.body };
    },
  } as unknown as MailClient;
}

const outlookUrl = (id: string) =>
  `https://outlook.live.com/mail/0/inbox/id/${encodeURIComponent(id)}`;

describe('the side panel on an Outlook email', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('an email not added yet: what the job would be, from the email', async () => {
    const c = await emailContext(db, fakeClient([mail(ID)]), ID);
    expect(c).toMatchObject({
      messageId: ID,
      subject: 'Exciting opportunity',
      from: 'Jane Doe',
      applicationId: null,
      detected: { title: 'Senior Technical Program Manager', company: 'Contoso', postingUrl: null },
      error: null,
    });
  });

  it('Add to Screening: once, with your corrections; the page then shows its card', async () => {
    const client = fakeClient([mail(ID)]);
    const r = await addEmailLead(db, client, { messageId: ID, title: 'Sr TPM, Platform' });
    expect(r).toMatchObject({ existing: false, title: 'Sr TPM, Platform', company: 'Contoso' });
    const d = getApplicationDetail(db, r.applicationId);
    expect(d.application.status).toBe('Screening');
    expect(d.emailLink).toBe(`https://outlook.live.com/owa/?ItemID=${ID}`);
    expect(await addEmailLead(db, client, { messageId: ID })).toEqual({
      applicationId: r.applicationId,
      existing: true,
    });

    const ctx = await pageContext(
      db,
      { url: outlookUrl(ID), pageTitle: 'Mail - Dave - Outlook' },
      {
        mail: client,
      },
    );
    expect(ctx.email?.applicationId).toBe(r.applicationId);
    expect(ctx.tracked).toMatchObject({
      applicationId: r.applicationId,
      title: 'Sr TPM, Platform',
    });
    expect(ctx.company?.name).toBe('Contoso');
  });

  it('an email added from the folder and since moved: found by its Message-ID, link kept current', async () => {
    await syncLeads(db, fakeClient([], { folder: [mail('IN-LEADS')] }), 'Job leads', {
      screener: null,
    });
    const moved = fakeClient([mail('IN-ARCHIVE')]);
    const c = await emailContext(db, moved, 'IN-ARCHIVE');
    expect(c.applicationId).not.toBeNull();
    const lead = db.select().from(mailLeads).get()!;
    expect(lead).toMatchObject({
      messageId: 'IN-ARCHIVE',
      webLink: 'https://outlook.live.com/owa/?ItemID=IN-ARCHIVE',
    });
  });

  it("the reading pane's address names the conversation: the recruiter's email in it, not your reply", async () => {
    const conv = 'AQQkADAwATE0YTQwLTdl_conv==';
    const theirs = mail('THEIRS', { conversationId: conv, receivedAt: '2026-10-10T15:00:00Z' });
    const mine = mail('MINE', {
      conversationId: conv,
      receivedAt: '2026-10-11T09:00:00Z',
      from: { name: 'Dave', address: 'me@hotmail.com' },
      subject: 'RE: Exciting opportunity',
      body: 'Thanks, sounds interesting.',
      internetMessageId: '<mine@x>',
    });
    const client = fakeClient([theirs, mine]);
    const c = await emailContext(db, client, conv);
    expect(c).toMatchObject({
      messageId: 'THEIRS',
      applicationId: null,
      detected: { title: 'Senior Technical Program Manager' },
    });
    const r = await addEmailLead(db, client, { messageId: c.messageId });
    expect(db.select().from(mailLeads).get()?.conversationId).toBe(conv);
    // Known now, even without asking Outlook.
    const offline = await emailContext(db, fakeClient([], { signedOut: true }), conv);
    expect(offline.applicationId).toBe(r.applicationId);
    const ctx = await pageContext(
      db,
      { url: `https://outlook.live.com/mail/0/AQMkFolder/id/${encodeURIComponent(conv)}` },
      { mail: client },
    );
    expect(ctx.tracked?.applicationId).toBe(r.applicationId);
  });

  it('not connected to Outlook: a known email still shows its job; a new one says to connect', async () => {
    await syncLeads(db, fakeClient([], { folder: [mail(ID)] }), 'Job leads', { screener: null });
    const out = fakeClient([], { signedOut: true });
    const known = await emailContext(db, out, ID);
    expect(known.applicationId).not.toBeNull();
    expect(known.error).toMatch(/Connect Outlook/);
    const unknown = await emailContext(db, out, 'OTHER');
    expect(unknown).toMatchObject({ applicationId: null, error: expect.stringMatching(/Connect/) });
    await expect(addEmailLead(db, out, { messageId: 'OTHER' })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("an email whose posting you already track shows that job, and the page's own title is ignored", async () => {
    const link = 'https://job-boards.greenhouse.io/contoso/jobs/123';
    const first = fakeClient([], { folder: [mail('A', { body: `${JD}\n${link}` })] });
    await syncLeads(db, first, 'Job leads', {
      screener: null,
      fetchFn: (async () => new Response('', { status: 404 })) as typeof fetch,
    });
    const other = mail('B', {
      body: `Same role, another recruiter: ${link}`,
      internetMessageId: '<b@x>',
    });
    const ctx = await pageContext(
      db,
      { url: outlookUrl('B'), pageTitle: 'Mail - Dave Britton - Outlook' },
      { mail: fakeClient([other]) },
    );
    expect(ctx.email?.applicationId).toBeNull();
    expect(ctx.tracked?.title).toBe('Senior Technical Program Manager');
    const fresh = await pageContext(
      db,
      { url: outlookUrl('C'), pageTitle: 'Mail - Dave Britton - Outlook' },
      {
        mail: fakeClient([
          mail('C', { body: 'Hi, quick question', subject: 'Hello', internetMessageId: '<c@x>' }),
        ]),
      },
    );
    expect(fresh.tracked).toBeNull();
    expect(fresh.detected.company).not.toMatch(/outlook|dave/i);
  });
});
