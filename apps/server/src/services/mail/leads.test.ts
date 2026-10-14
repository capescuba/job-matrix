import { beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { RateLimitError, type LLMProvider, type StructuredRequest } from '@jm/ai';
import type { MailClient, MailMeta } from '@jm/mail';
import { openDb, type Db } from '../../db/client.ts';
import { contacts, mailLeads, prescreens } from '../../db/schema.ts';
import { getApplicationDetail, listApplications } from '../applications.ts';
import { leadBody, leadFields, postingLink, syncLeads } from './leads.ts';
import { mailState, syncMail, updateMailSettings } from './sync.ts';

const meta = (over: Partial<MailMeta> & { id: string }): MailMeta => ({
  subject: '',
  from: { name: 'Jane Doe', address: 'jane@teksystems.com' },
  replyTo: [],
  receivedAt: '2026-10-10T15:00:00Z',
  preview: '',
  folderId: 'LEADS',
  webLink: `https://outlook.live.com/owa/?ItemID=${over.id}`,
  conversationId: null,
  internetMessageId: `<${over.id}@mail>`,
  ...over,
});

const JD = `Hi Dave,

I came across your profile and wanted to share a role.

Title: Senior Technical Program Manager
Client: Contoso
Location: Remote (US)

Responsibilities: lead cross-team programs for the platform org, own roadmaps and launches.

Thanks,
Jane`;

describe('reading a recruiter email', () => {
  it('stops at the quoted thread and the legal footer', () => {
    const body = `Role details here.\n\nThanks\n\nFrom: Dave Britton\nSent: Monday\nSubject: hi\nold text`;
    expect(leadBody(body)).toBe('Role details here.\n\nThanks');
    const footer = `a\nb\nc\nd\ne\nf\ng\nThis email is confidential and intended only for the recipient.\nlegal`;
    expect(leadBody(footer)).toBe('a\nb\nc\nd\ne\nf\ng');
    expect(leadBody('Short\n-----Original Message-----\nold')).toBe('Short');
  });

  it('takes labelled title and client lines first', () => {
    const f = leadFields(meta({ id: 'a', subject: 'Exciting opportunity - remote' }), JD);
    expect(f).toMatchObject({
      title: 'Senior Technical Program Manager',
      company: 'Contoso',
      recruiter: { name: 'Jane Doe', address: 'jane@teksystems.com' },
      postingUrl: null,
    });
  });

  it('falls back to the subject, then the agency domain; a vague client is not a name', () => {
    const f = leadFields(
      meta({ id: 'a', subject: 'RE: Urgent: Forward Deployed Engineer - Remote | 12 months' }),
      'Client: Fortune 500 company\nWe have an opening for an FDE.',
    );
    expect(f.title).toBe('Forward Deployed Engineer');
    expect(f.company).toBe('Teksystems');
  });

  it('reads "Role at Company" subjects, and never names the company after the recruiter', () => {
    expect(
      leadFields(
        meta({
          id: 'a',
          subject: 'Staff TPM role at Fabrikam',
          from: { name: 'Sam Lee', address: 'sam.lee@gmail.com' },
        }),
        'Would love to chat.',
      ),
    ).toMatchObject({ title: 'Staff TPM', company: 'Fabrikam' });
    expect(
      leadFields(
        meta({
          id: 'b',
          subject: 'Program Manager',
          from: { name: 'Sam Lee via LinkedIn', address: 'inmail-hit-reply@linkedin.com' },
        }),
        'Interested?',
      ),
    ).toMatchObject({ company: 'Unknown', recruiter: { name: 'Sam Lee' } });
  });

  it('finds a posting link, unwrapping Safe Links and skipping signature links', () => {
    expect(
      postingLink(
        'See https://www.teksystems.com/careers and apply <https://job-boards.greenhouse.io/contoso/jobs/123>.',
      ),
    ).toBe('https://job-boards.greenhouse.io/contoso/jobs/123');
    const wrapped = `https://nam12.safelinks.protection.outlook.com/?url=${encodeURIComponent('https://www.linkedin.com/comm/jobs/view/4012345/?trk=x')}&data=1`;
    expect(postingLink(`Apply: ${wrapped}`)).toBe(
      'https://www.linkedin.com/jobs/view/4012345/?trk=x',
    );
    expect(postingLink('Visit https://contoso.com/about')).toBeNull();
  });
});

type Mail = MailMeta & { body: string };

/** A fake mailbox with one "Job leads" folder. */
function fakeMailbox(folder: Mail[], { folderName = 'Job leads' } = {}) {
  const client = {
    tokenPath: '',
    status: async () => ({
      configured: true,
      signedIn: true,
      account: 'me',
      signingIn: null,
      lastError: null,
    }),
    async *messagesSince() {},
    folderByName: async (name: string) =>
      name.toLowerCase() === folderName.toLowerCase() ? 'LEADS' : null,
    async *messagesIn() {
      yield folder.map(({ body: _b, ...m }) => m);
    },
    async message(id: string) {
      const m = folder.find((x) => x.id === id)!;
      return { ...m, bodyText: m.body };
    },
  } as unknown as MailClient;
  return client;
}

function fakeScreener(answer: () => unknown) {
  const titles: string[] = [];
  const provider: LLMProvider = {
    name: 'Fake',
    defaultModel: 'fake-small',
    complete: async () => '',
    async completeStructured<S extends z.ZodType>(req: StructuredRequest<S>) {
      titles.push(req.prompt.match(/^Title: (.+)$/m)![1]!);
      const a = answer();
      if (a instanceof Error) throw a;
      return {
        data: req.schema.parse(a) as z.infer<S>,
        provider: 'Fake',
        model: 'fake-small',
        usage: { inputTokens: 900, outputTokens: 40 },
      };
    },
  };
  return { screener: { provider, model: 'fake-small' }, titles };
}

const noFetch = (async () => new Response('', { status: 404 })) as typeof fetch;
const noSleep = async () => {};

describe('the job-leads folder', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('adds each email once as a Screening job, pre-screened, with the recruiter and a timeline note', async () => {
    const box = [
      { ...meta({ id: 'm1', subject: 'Exciting opportunity' }), body: JD },
      {
        ...meta({ id: 'm2', subject: 'Forward Deployed Engineer - Remote' }),
        body: 'We have an FDE opening on the applied AI team, customer facing, Python heavy.',
      },
    ];
    const { screener, titles } = fakeScreener(() => ({
      verdict: 'yes',
      reason: 'TPM role, remote',
      dealBreaker: null,
      score: 8,
    }));
    const r = await syncLeads(db, fakeMailbox(box), 'Job leads', {
      screener,
      fetchFn: noFetch,
      sleep: noSleep,
    });
    expect(r).toEqual({ folderFound: true, added: 2, screened: 2 });
    expect(titles.sort()).toEqual([
      'Forward Deployed Engineer',
      'Senior Technical Program Manager',
    ]);

    const apps = listApplications(db).filter((a) => a.status === 'Screening');
    expect(apps.map((a) => [a.company, a.title]).sort()).toEqual([
      ['Contoso', 'Senior Technical Program Manager'],
      ['Teksystems', 'Forward Deployed Engineer'],
    ]);
    const tpm = apps.find((a) => a.company === 'Contoso')!;
    const detail = getApplicationDetail(db, tpm.id);
    expect(detail.job.source).toBe('Recruiter');
    expect(detail.job.descriptionSource).toBe('Recruiter email');
    expect(detail.job.descriptionText).toContain('lead cross-team programs');
    expect(detail.activities.map((a) => a.summary).join('\n')).toMatch(
      /From a recruiter email: “Exciting opportunity” — Jane Doe <jane@teksystems.com> · https:\/\/outlook/,
    );
    expect(db.select().from(prescreens).all()).toHaveLength(2);
    expect(
      db
        .select()
        .from(contacts)
        .all()
        .map((c) => c.name),
    ).toEqual(['Jane Doe', 'Jane Doe']);

    // Same emails again, now with new Graph ids (moved out and back): nothing new.
    const moved = box.map((m) => ({
      ...m,
      id: `${m.id}-moved`,
      webLink: `https://outlook.live.com/owa/?ItemID=${m.id}-moved`,
    }));
    const again = await syncLeads(db, fakeMailbox(moved), 'Job leads', {
      screener,
      sleep: noSleep,
    });
    expect(again).toEqual({ folderFound: true, added: 0, screened: 0 });
    expect(db.select().from(mailLeads).all()).toHaveLength(2);
    // …and the Screening card / job page link to the email where it is now.
    const row = listApplications(db).find((a) => a.id === tpm.id)!;
    expect(row.emailLink).toBe('https://outlook.live.com/owa/?ItemID=m1-moved');
    expect(getApplicationDetail(db, tpm.id).emailLink).toBe(row.emailLink);
  });

  it('a linked posting goes through capture, so the same job from two recruiters is one job', async () => {
    const link = 'https://job-boards.greenhouse.io/contoso/jobs/123';
    const box = [
      { ...meta({ id: 'm1', subject: 'Senior TPM' }), body: `${JD}\n\nApply here: ${link}` },
      {
        ...meta({ id: 'm2', subject: 'TPM role', from: { name: 'Al', address: 'al@agency.io' } }),
        body: `Another recruiter with the same role, a long enough description. ${link}`,
      },
    ];
    const r = await syncLeads(db, fakeMailbox(box), 'Job leads', {
      screener: null,
      fetchFn: noFetch,
    });
    expect(r.added).toBe(2);
    const leads = db.select().from(mailLeads).all();
    expect(leads.map((l) => l.existing)).toEqual([false, true]);
    expect(leads[0]!.applicationId).toBe(leads[1]!.applicationId);
    const detail = getApplicationDetail(db, leads[0]!.applicationId!);
    expect(detail.job.url).toBe(link);
    // The posting couldn't be read: the email names the role and supplies the description.
    expect(detail.job.title).toBe('Senior Technical Program Manager');
    expect(detail.job.descriptionSource).toBe('Recruiter email');
    expect(detail.activities.map((a) => a.summary).join('\n')).toContain(
      'A recruiter also sent this job',
    );
  });

  it('no pre-screen model, or a rate limit, leaves the job in Screening without a verdict', async () => {
    const box = [
      { ...meta({ id: 'm1', subject: 'TPM' }), body: JD },
      { ...meta({ id: 'm2', subject: 'FDE' }), body: JD.replace('Contoso', 'Fabrikam') },
    ];
    const { screener, titles } = fakeScreener(() => new RateLimitError('slow down', null));
    const r = await syncLeads(db, fakeMailbox(box), 'Job leads', { screener, sleep: noSleep });
    expect(r).toEqual({ folderFound: true, added: 2, screened: 0 });
    expect(titles).toHaveLength(1); // stopped after the first "later"
    expect(db.select().from(prescreens).all()).toHaveLength(0);
    expect(
      db
        .select()
        .from(mailLeads)
        .all()
        .filter((l) => l.error),
    ).toHaveLength(1);
  });

  it('a missing folder is not an error', async () => {
    expect(await syncLeads(db, fakeMailbox([]), 'Recruiters', { screener: null })).toEqual({
      folderFound: false,
      added: 0,
      screened: 0,
    });
  });

  it('runs as part of a mail check, and the folder can be renamed or turned off', async () => {
    const box = [{ ...meta({ id: 'm1', subject: 'TPM' }), body: JD }];
    expect(mailState(db).leadsFolder).toBe('Job leads');
    const r = await syncMail(db, fakeMailbox(box), { leads: { screener: null } });
    expect(r.leadsAdded).toBe(1);
    expect(mailState(db)).toMatchObject({ leadsFolderFound: true, leadsAdded: 1 });

    updateMailSettings(db, { leadsFolder: 'Recruiters' });
    expect(mailState(db)).toMatchObject({ leadsFolder: 'Recruiters', leadsFolderFound: null });
    await syncMail(db, fakeMailbox(box), { leads: { screener: null } });
    expect(mailState(db)).toMatchObject({ leadsFolderFound: false, leadsAdded: 0 });

    updateMailSettings(db, { leadsFolder: '  ' });
    expect(mailState(db).leadsFolder).toBeNull();
    expect((await syncMail(db, fakeMailbox(box))).leadsAdded).toBe(0);
  });
});
