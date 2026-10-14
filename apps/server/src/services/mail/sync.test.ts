import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { LLMProvider, StructuredRequest } from '@jm/ai';
import type { MailClient, MailMeta } from '@jm/mail';
import { openDb, type Db } from '../../db/client.ts';
import { activities, aiUsage, applications, emailUpdates, statusEvents } from '../../db/schema.ts';
import { createApplication, getApplicationDetail } from '../applications.ts';
import {
  historyStart,
  mailState,
  scheduleMail,
  nextSyncAt,
  stopMailSchedule,
  syncMail,
  updateMailSettings,
} from './sync.ts';
import {
  applyUpdate,
  classifyWithAi,
  dismissUpdate,
  listUpdates,
  relabelUpdate,
  restoreUpdate,
  trackFromUpdate,
} from './updates.ts';

type Mail = MailMeta & { body: string };
const mail = (
  id: string,
  at: string,
  subject: string,
  body: string,
  from = 'no-reply@us.greenhouse-mail.io',
  name: string | null = null,
): Mail => ({
  id,
  subject,
  body,
  from: { name, address: from },
  replyTo: [],
  receivedAt: at,
  preview: body.slice(0, 100),
  folderId: 'INBOX',
  webLink: `https://outlook.live.com/owa/?ItemID=${id}`,
  conversationId: null,
  internetMessageId: null,
});

/** A fake mailbox: pages of 2, records which bodies were opened. */
function fakeMailbox(messages: Mail[]) {
  const opened: string[] = [];
  const sinceCalls: string[] = [];
  const client = {
    tokenPath: '',
    accessToken: async () => 't',
    startSignIn: async () => ({
      userCode: 'C',
      verificationUri: 'u',
      expiresAt: 0,
      done: Promise.resolve(),
    }),
    status: async () => ({
      configured: true,
      signedIn: true,
      account: 'me@hotmail.com',
      signingIn: null,
      lastError: null,
    }),
    async *messagesSince(since: string) {
      sinceCalls.push(since);
      const list = messages
        .filter((m) => m.receivedAt >= since)
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
      for (let i = 0; i < list.length; i += 2)
        yield list.slice(i, i + 2).map(({ body: _b, ...meta }) => meta);
    },
    folderByName: async () => null,
    async *messagesIn() {},
    async message(id: string) {
      opened.push(id);
      const m = messages.find((x) => x.id === id)!;
      return { ...m, bodyText: m.body };
    },
  } as unknown as MailClient;
  return { client, opened, sinceCalls };
}

describe('checking the mailbox', () => {
  let db: Db;
  let dd: number;
  let box: number;
  beforeEach(() => {
    db = openDb(':memory:');
    dd = createApplication(db, {
      company: 'DoorDash',
      title: 'Senior TPM, Platform Services',
      status: 'Applied',
      appliedAt: '2026-09-21',
    });
    box = createApplication(db, { company: 'Box', title: 'Staff TPM', status: 'Screening' });
    db.update(applications).set({ createdAt: '2026-09-15T12:00:00.000Z' }).run();
  });

  const inbox = () => [
    mail(
      'noise',
      '2026-09-02T10:00:00Z',
      'Pre-Order the Latest Apple Products',
      'Buy now',
      'Costco@digital.costco.com',
    ),
    mail(
      'alert',
      '2026-09-16T10:00:00Z',
      'TPM at Google',
      'New jobs',
      'jobalerts-noreply@linkedin.com',
    ),
    mail(
      'dd-receipt',
      '2026-09-21T10:00:00Z',
      'Thank you for applying to DoorDash',
      'We have received your application.',
      'hello@doordash.com',
    ),
    mail(
      'box-receipt',
      '2026-09-23T10:00:00Z',
      'Thank you for applying to Box!',
      'We have received your application.',
      'no-reply@box.com',
    ),
    mail(
      'dd-reject',
      '2026-09-25T19:15:00Z',
      'DoorDash Application Status',
      'After careful consideration, we have decided to not move forward with your application at this time.',
    ),
    mail(
      'unknown',
      '2026-09-24T10:00:00Z',
      'Thanks for applying to SpaceXAI!',
      'We have received your application for Technical Program Manager, Field.',
      'no-reply@ashbyhq.com',
      'x.ai Hiring Team',
    ),
  ];

  it('starts two weeks before the first application, opens only job mail, and queues what it means', async () => {
    expect(historyStart(db)).toBe('2026-09-01T12:00:00.000Z');
    const { client, opened, sinceCalls } = fakeMailbox(inbox());
    const r = await syncMail(db, client);
    expect(sinceCalls).toEqual(['2026-09-01T12:00:00.000Z']);
    expect(r).toEqual({ scanned: 6, found: 4, leadsAdded: 0 });
    expect(opened.sort()).toEqual(['box-receipt', 'dd-receipt', 'dd-reject', 'unknown']);

    const pending = listUpdates(db, 'pending');
    const byMsg = Object.fromEntries(pending.map((u) => [u.messageId, u]));
    expect(byMsg['dd-reject']).toMatchObject({
      kind: 'rejection',
      applicationId: dd,
      suggestedStatus: 'Rejected',
    });
    expect(byMsg['dd-reject']!.application).toMatchObject({
      status: 'Applied',
      company: 'DoorDash',
    });
    expect(byMsg['box-receipt']).toMatchObject({
      kind: 'confirmation',
      applicationId: box,
      suggestedStatus: 'Applied',
    });
    expect(byMsg['unknown']).toMatchObject({
      companyName: 'SpaceXAI',
      applicationId: null,
      jobTitle: 'Technical Program Manager, Field',
    });
    // A receipt for a job already marked Applied (with its date) needs nothing.
    expect(listUpdates(db, 'done').map((u) => [u.messageId, u.state])).toEqual([
      ['dd-receipt', 'noop'],
    ]);

    const s = mailState(db);
    expect(s).toMatchObject({
      watermark: '2026-09-25T19:15:00Z',
      scanned: 6,
      found: 4,
      lastError: null,
    });
  });

  it('the next check starts where the last one stopped and never repeats an email', async () => {
    const box = inbox();
    const mb = fakeMailbox(box);
    await syncMail(db, mb.client);
    box.push(
      mail(
        'new',
        '2026-09-26T09:00:00Z',
        'Thank you for applying to Box!',
        'We have received your application.',
        'no-reply@box.com',
      ),
    );
    mb.opened.length = 0;
    const r = await syncMail(db, mb.client);
    expect(mb.sinceCalls[1]).toBe('2026-09-25T19:15:00Z');
    expect(r.found).toBe(1);
    expect(mb.opened).toEqual(['new']);
    // A re-scan reads history again but opens nothing it already has.
    mb.opened.length = 0;
    await syncMail(db, mb.client, { rescan: true });
    expect(mb.sinceCalls[2]).toBe('2026-09-01T12:00:00.000Z');
    expect(mb.opened).toEqual([]);
  });

  it('a failed check is recorded and the progress kept', async () => {
    const client = {
      ...fakeMailbox(inbox()).client,
      async *messagesSince() {
        yield [];
        throw new Error('Outlook error 503');
      },
    } as unknown as MailClient;
    await expect(syncMail(db, client)).rejects.toThrow('503');
    expect(mailState(db).lastError).toBe('Outlook error 503');
  });

  it('checks are manual unless you choose a schedule', () => {
    const { client } = fakeMailbox([]);
    expect(mailState(db).intervalMinutes).toBe(-1);
    scheduleMail(db, client, { startup: true });
    expect(nextSyncAt()).toBeNull();
    updateMailSettings(db, { intervalMinutes: 0 });
    scheduleMail(db, client, { startup: true });
    expect(nextSyncAt()).not.toBeNull();
    scheduleMail(db, client); // "when the app opens": nothing after start-up
    expect(nextSyncAt()).toBeNull();
    updateMailSettings(db, { intervalMinutes: 30 });
    const before = Date.now();
    scheduleMail(db, client);
    expect(Date.parse(nextSyncAt()!) - before).toBeGreaterThanOrEqual(30 * 60_000 - 50);
    updateMailSettings(db, { enabled: false });
    scheduleMail(db, client);
    expect(nextSyncAt()).toBeNull();
    stopMailSchedule();
  });
});

describe('the review queue', () => {
  let db: Db;
  let dd: number;
  let client: MailClient;
  const pendingFor = (msg: string) => listUpdates(db, 'pending').find((u) => u.messageId === msg)!;

  beforeEach(async () => {
    db = openDb(':memory:');
    dd = createApplication(db, {
      company: 'DoorDash',
      title: 'Senior TPM, Platform Services',
      status: 'Applied',
      appliedAt: '2026-09-21',
    });
    createApplication(db, {
      company: 'OpenAI',
      title: 'TPM, Compute',
      status: 'Applied',
      appliedAt: '2026-09-16',
    });
    createApplication(db, {
      company: 'OpenAI',
      title: 'TPM, Safety',
      status: 'Applied',
      appliedAt: '2026-09-16',
    });
    client = fakeMailbox([
      mail(
        'dd-reject',
        '2026-09-25T19:15:00Z',
        'DoorDash Application Status',
        'After careful consideration, we have decided to not move forward with your application at this time.',
      ),
      mail(
        'oa',
        '2026-09-16T10:00:00Z',
        'Thank you for applying to OpenAI',
        'We have received your application.',
        'no-reply@openai.com',
        'OpenAI Hiring Team',
      ),
      mail(
        'x',
        '2026-09-24T10:00:00Z',
        'Thanks for applying to SpaceXAI!',
        'We have received your application for Technical Program Manager, Field.',
        'no-reply@ashbyhq.com',
        'x.ai Hiring Team',
      ),
      mail(
        'adobe',
        '2026-09-25T10:00:00Z',
        'DoorDash: checking in',
        'An update on your application: the team is still reviewing.',
        'news@doordash.com',
      ),
    ]).client;
    await syncMail(db, client);
  });

  it('apply: logs the email on the timeline, dated to the email, and changes the status', () => {
    const u = pendingFor('dd-reject');
    applyUpdate(db, u.id);
    const detail = getApplicationDetail(db, dd);
    expect(detail.application.status).toBe('Rejected');
    const act = db.select().from(activities).where(eq(activities.applicationId, dd)).all().at(-1)!;
    expect(act).toMatchObject({ at: '2026-09-25', kind: 'Response' });
    expect(act.summary).toContain('DoorDash Application Status');
    expect(act.summary).toContain('decided to not move forward');
    const ev = db
      .select()
      .from(statusEvents)
      .where(eq(statusEvents.applicationId, dd))
      .all()
      .at(-1)!;
    expect(ev).toMatchObject({ toStatus: 'Rejected', at: '2026-09-25T12:00:00.000Z' });
    expect(listUpdates(db, 'done').find((x) => x.id === u.id)).toMatchObject({
      state: 'applied',
      activityId: act.id,
    });
    expect(() => applyUpdate(db, u.id)).toThrow(/already applied/);
  });

  it('apply with your own choice of status, or just log it', () => {
    const u = pendingFor('dd-reject');
    applyUpdate(db, u.id, { status: null });
    expect(getApplicationDetail(db, dd).application.status).toBe('Applied');
  });

  it('pick the job for a company with several, then apply', () => {
    const u = pendingFor('oa');
    expect(u.applicationId).toBeNull();
    expect(u.companyApplications.map((a) => a.title).sort()).toEqual([
      'TPM, Compute',
      'TPM, Safety',
    ]);
    expect(() => applyUpdate(db, u.id)).toThrow(/Pick the job/);
    const target = u.companyApplications[0]!.id;
    const r = relabelUpdate(db, u.id, { applicationId: target });
    expect(r).toMatchObject({ applicationId: target, matchedBy: 'you' });
    applyUpdate(db, u.id);
    expect(
      db.select().from(activities).where(eq(activities.applicationId, target)).all(),
    ).toHaveLength(1);
  });

  it('add an untracked job from its email', () => {
    const u = pendingFor('x');
    const r = trackFromUpdate(db, u.id, {
      company: 'xAI',
      title: 'Technical Program Manager, Field',
    });
    const app = getApplicationDetail(db, r.applicationId!);
    expect(app.application).toMatchObject({ status: 'Applied', appliedAt: '2026-09-24' });
    expect(app.company.name).toBe('xAI');
  });

  it('dismiss and bring back; label an unclear one yourself', () => {
    const u = pendingFor('adobe');
    expect(u.kind).toBe('unclear');
    dismissUpdate(db, u.id);
    expect(listUpdates(db, 'pending').some((x) => x.id === u.id)).toBe(false);
    restoreUpdate(db, u.id);
    const r = relabelUpdate(db, u.id, { kind: 'rejection' });
    expect(r).toMatchObject({ kind: 'rejection', suggestedStatus: 'Rejected', applicationId: dd });
  });

  it('Ask AI: one call on the email model, recorded under Email updates', async () => {
    const u = pendingFor('adobe');
    const seen: StructuredRequest<never>[] = [];
    const provider = {
      name: 'fake',
      complete: async () => '',
      completeStructured: async (req: StructuredRequest<never>) => {
        seen.push(req);
        return {
          data: {
            kind: 'interview',
            company: 'DoorDash',
            title: null,
            applicationId: dd,
            evidence: 'Can you share your availability?',
            nextAction: 'Send times for Tuesday',
          },
          provider: 'fake',
          model: 'claude-haiku-4-5',
          usage: { inputTokens: 3000, outputTokens: 300 },
        };
      },
    } as unknown as LLMProvider;
    const r = await classifyWithAi(db, client, u.id, { provider });
    expect(seen[0]!.model).toBe('claude-haiku-4-5');
    expect(seen[0]!.prompt).toContain('DoorDash: checking in');
    expect(seen[0]!.prompt).toMatch(
      new RegExp(`${dd} \\| DoorDash \\| Senior TPM, Platform Services \\| Applied`),
    );
    expect(r).toMatchObject({
      kind: 'interview',
      classifiedBy: 'ai',
      matchedBy: 'ai',
      applicationId: dd,
      suggestedStatus: 'Recruiter Screen',
      suggestedNextAction: 'Send times for Tuesday',
    });
    const usage = db.select().from(aiUsage).all();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ feature: 'email', applicationId: dd });
    expect(r.usageId).toBe(usage[0]!.id);
  });

  it('emails stay when their job is deleted (unlinked)', () => {
    db.delete(applications).where(eq(applications.id, dd)).run();
    expect(
      db
        .select()
        .from(emailUpdates)
        .all()
        .find((u) => u.messageId === 'dd-reject')!.applicationId,
    ).toBeNull();
  });
});
