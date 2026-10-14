import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { MailClient, MailMeta } from '@jm/mail';
import { buildApp } from '../app.ts';
import { openDb, type Db } from '../db/client.ts';
import { applications, jobs } from '../db/schema.ts';
import { AliasError, addAlias, listAliases } from './aliases.ts';
import { createApplication } from './applications.ts';
import { pageContext } from './extension.ts';
import { buildMatchContext, matchApplication } from './mail/rules.ts';
import { syncMail } from './mail/sync.ts';
import { applyUpdate, listUpdates, relabelUpdate } from './mail/updates.ts';

const spacexai = (
  id: string,
  title = 'Technical Program Manager, Field',
): MailMeta & { body: string } => ({
  id,
  subject: 'Thanks for applying to SpaceXAI!',
  body: `Hi Dave, Thank you for applying for the ${title} role at SpaceXAI! We will review your application.`,
  from: { name: 'x.ai Hiring Team', address: 'no-reply@ashbyhq.com' },
  replyTo: [],
  receivedAt: `2026-09-2${id.length}T10:00:00Z`,
  preview: '',
  folderId: 'INBOX',
  webLink: null,
  conversationId: null,
});

function mailbox(messages: (MailMeta & { body: string })[]) {
  return {
    status: async () => ({ signedIn: true }),
    async *messagesSince() {
      yield messages.map(({ body: _b, ...m }) => m);
    },
    folderByName: async () => null,
    message: async (id: string) => {
      const m = messages.find((x) => x.id === id)!;
      return { ...m, bodyText: m.body };
    },
  } as unknown as MailClient;
}

const companyIdOf = (db: Db, appId: number) =>
  db
    .select({ c: jobs.companyId })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(eq(applications.id, appId))
    .get()!.c;

describe('company aliases', () => {
  let db: Db;
  let cursor: number;
  let cursorCo: number;
  beforeEach(() => {
    db = openDb(':memory:');
    cursor = createApplication(db, {
      company: 'Cursor',
      title: 'Technical Program Manager, Field',
      status: 'Applied',
      appliedAt: '2026-09-20',
    });
    createApplication(db, {
      company: 'Anthropic',
      title: 'Technical Program Manager, API Platform',
      status: 'Applied',
      appliedAt: '2026-09-15',
    });
    cursorCo = companyIdOf(db, cursor);
  });

  it('rules: own name is a no-op, another tracked company’s name is refused, an alias can move', () => {
    expect(addAlias(db, cursorCo, 'Cursor, Inc.')).toBeNull();
    expect(() => addAlias(db, cursorCo, 'Anthropic')).toThrow(AliasError);
    addAlias(db, cursorCo, 'SpaceXAI');
    expect(listAliases(db, cursorCo).map((a) => a.alias)).toEqual(['SpaceXAI']);
    const other = companyIdOf(
      db,
      createApplication(db, { company: 'Anysphere', title: 'x', status: 'Saved' }),
    );
    addAlias(db, other, 'spacexai');
    expect(listAliases(db, cursorCo)).toEqual([]);
    expect(listAliases(db, other).map((a) => a.alias)).toEqual(['spacexai']);
  });

  it('with no alias, the same job title at one tracked job is a possible match', () => {
    const m = spacexai('a');
    const r = matchApplication(m, m.body, buildMatchContext(db));
    expect(r).toMatchObject({
      companyName: 'SpaceXAI',
      companyId: cursorCo,
      applicationId: cursor,
      matchedBy: 'title-only',
    });
    // A different role at the unknown company stays untracked.
    const n = spacexai('b', 'Staff Software Engineer');
    expect(matchApplication(n, n.body, buildMatchContext(db))).toMatchObject({
      companyId: null,
      applicationId: null,
    });
  });

  it('with an alias, it matches by name', () => {
    addAlias(db, cursorCo, 'SpaceXAI');
    const m = spacexai('a');
    expect(matchApplication(m, m.body, buildMatchContext(db))).toMatchObject({
      companyName: 'Cursor',
      applicationId: cursor,
      matchedBy: 'title',
    });
  });

  it('applying a title-only match can remember the name, and other waiting emails re-match', async () => {
    await syncMail(db, mailbox([spacexai('a'), spacexai('bb', 'Senior Program Manager')]));
    const [a, b] = ['a', 'bb'].map((id) =>
      listUpdates(db, 'pending').find((u) => u.messageId === id)!,
    );
    expect(a).toMatchObject({ matchedBy: 'title-only', applicationId: cursor });
    expect(b).toMatchObject({ companyId: null, applicationId: null });
    applyUpdate(db, a!.id, { rememberAlias: 'SpaceXAI' });
    expect(listAliases(db, cursorCo).map((x) => x.alias)).toEqual(['SpaceXAI']);
    // The other SpaceXAI email now belongs to Cursor (its only job there). It's a receipt for a
    // job already marked Applied, so there's nothing to change: it moves to Done.
    expect(listUpdates(db, 'done').find((u) => u.messageId === 'bb')).toMatchObject({
      companyId: cursorCo,
      applicationId: cursor,
      state: 'noop',
    });
  });

  it('“It’s from a company I track” on an untracked email', async () => {
    await syncMail(db, mailbox([spacexai('bb', 'Senior Program Manager')]));
    const u = listUpdates(db, 'pending')[0]!;
    const r = relabelUpdate(db, u.id, { companyId: cursorCo, rememberAlias: true });
    expect(r).toMatchObject({ companyId: cursorCo, applicationId: cursor, matchedBy: 'only' });
    expect(listAliases(db, cursorCo).map((x) => x.alias)).toEqual(['SpaceXAI']);
  });

  it('the Chrome extension recognises the alias on a job page', async () => {
    addAlias(db, cursorCo, 'SpaceXAI');
    const ctx = await pageContext(
      db,
      {
        url: 'https://jobs.ashbyhq.com/spacexai/123',
        pageTitle: 'Staff Engineer @ SpaceXAI',
        fields: { company: 'SpaceXAI' },
      },
      { fetchFn: (async () => new Response('', { status: 404 })) as typeof fetch },
    );
    expect(ctx.company?.name).toBe('Cursor');
  });

  it('routes: list, add, refuse a clash, remove', async () => {
    const app = buildApp(db, { mail: mailbox([]) });
    const add = await app.inject({
      method: 'POST',
      url: `/api/companies/${cursorCo}/aliases`,
      payload: { alias: 'SpaceXAI' },
    });
    expect(add.statusCode).toBe(201);
    const [row] = add.json();
    expect(row.alias).toBe('SpaceXAI');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/companies/${cursorCo}/aliases`,
          payload: { alias: 'Anthropic' },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/aliases/${row.id}` })).statusCode).toBe(
      204,
    );
    expect(
      (await app.inject({ method: 'GET', url: `/api/companies/${cursorCo}/aliases` })).json(),
    ).toEqual([]);
  });
});
