import { beforeEach, describe, expect, it } from 'vitest';
import type { MailMeta } from '@jm/mail';
import { openDb, type Db } from '../../db/client.ts';
import { createApplication } from '../applications.ts';
import {
  buildMatchContext,
  classify,
  companyFromSenderName,
  isCandidate,
  matchApplication,
  suggest,
  titleFrom,
} from './rules.ts';

const meta = (
  over: Omit<Partial<MailMeta>, 'from'> & { from?: Partial<MailMeta['from']> } = {},
): MailMeta => ({
  id: 'm1',
  subject: '',
  replyTo: [],
  receivedAt: '2026-09-23T15:00:00Z',
  preview: '',
  folderId: 'INBOX',
  webLink: null,
  conversationId: null,
  ...over,
  from: { name: null, address: 'no-reply@us.greenhouse-mail.io', ...over.from },
});

describe('classify (from real email wording)', () => {
  it('rejections', () => {
    const r = classify(
      'DoorDash Application Status',
      'Hi Dave,\nThank you for your interest in DoorDash. After careful consideration, we have decided to not move forward with your application at this time.',
    );
    expect(r.kind).toBe('rejection');
    expect(r.evidence).toBe(
      'After careful consideration, we have decided to not move forward with your application at this time.',
    );
    expect(
      classify(
        'Anthropic Follow-Up for TPM, Apps Platform',
        'After consideration, we have decided not to move forward with your application for the TPM role.',
      ).kind,
    ).toBe('rejection');
    expect(
      classify(
        'Update',
        'We will be moving forward with other candidates whose experience more closely matches.',
      ).kind,
    ).toBe('rejection');
    expect(
      classify('Your application', 'Unfortunately, we are unable to move your application forward.')
        .kind,
    ).toBe('rejection');
  });

  it('a condition is not a rejection ("If you are not selected…")', () => {
    const r = classify(
      'Thank you for your application to Figma',
      'Thanks for applying! Our team will review your application. If you are not selected for this position, keep an eye on our jobs page.',
    );
    expect(r.kind).toBe('confirmation');
  });

  it('receipts, including one that mentions the scheduling tool', () => {
    expect(
      classify('Thank you for applying to Anthropic', 'We have received your application.').kind,
    ).toBe('confirmation');
    expect(classify('Dave, your application was sent to LinkedIn', '').kind).toBe('confirmation');
    expect(
      classify(
        'Thank you for applying to Databricks!',
        'Thanks for applying. If your background is a match, a recruiter will reach out to schedule a call. Please allow emails from @databricks.com or @goodtime.io.',
      ).kind,
    ).toBe('confirmation');
  });

  it('interviews need a real invitation', () => {
    expect(
      classify('Next steps', 'Please share your availability for a 30 minute call next week.').kind,
    ).toBe('interview');
    expect(classify('Interview', 'Book a time here: https://calendly.com/jane/30min').kind).toBe(
      'interview',
    );
    expect(
      classify(
        'Thanks for applying',
        'We received your application. If your background matches, we would like to schedule a call.',
      ).kind,
    ).toBe('confirmation');
    expect(
      classify(
        'Thanks for applying',
        'We reviewed your application and would like to schedule a call with you.',
      ).kind,
    ).toBe('interview');
  });

  it('action needed, offers, viewed, and nothing', () => {
    expect(
      classify('Meta Recruiting Next Steps - Prescreen Form', 'Please complete the form below.')
        .kind,
    ).toBe('action');
    expect(classify('Additional Information Needed on your GitHub application', '').kind).toBe(
      'action',
    );
    expect(
      classify('Congratulations', 'We are pleased to extend an offer of employment.').kind,
    ).toBe('offer');
    expect(classify('Your application was viewed by Stripe', '').kind).toBe('viewed');
    expect(
      classify('Adobe, checking in and staying connected', 'Here is our latest news.').kind,
    ).toBe('unclear');
  });
});

describe('reading company and title', () => {
  it('sender names', () => {
    expect(companyFromSenderName('Box Recruiting')).toBe('Box');
    expect(companyFromSenderName('The Plaid Team')).toBe('Plaid');
    expect(companyFromSenderName('GitHub, Inc. @ icims')).toBe('GitHub, Inc.');
    expect(companyFromSenderName('do-not-reply adobe')).toBe('adobe');
    expect(companyFromSenderName('The Recruiting team at Meta')).toBe('Meta');
    expect(companyFromSenderName('Intuit Talent Acquisition')).toBe('Intuit');
    expect(companyFromSenderName('no-reply@us.greenhouse-mail.io')).toBeNull();
    expect(companyFromSenderName('LinkedIn')).toBeNull();
  });

  it('titles', () => {
    expect(
      titleFrom(
        'We’ve received your application for Staff Technical Program Manager at Affirm',
        '',
      ),
    ).toBe('Staff Technical Program Manager');
    expect(
      titleFrom(
        'Application Received! Thanks for applying to the Principal Technical Program Manager Role',
        '',
      ),
    ).toBe('Principal Technical Program Manager');
    expect(
      titleFrom(
        'DoorDash Application Status',
        'Thank you for taking the time to apply to the Senior Technical Program Manager, Platform Services position.',
      ),
    ).toBe('Senior Technical Program Manager, Platform Services');
    expect(
      titleFrom(
        'Anthropic Follow-Up for Technical Program Manager, Apps Platform | Dave Britton',
        '',
      ),
    ).toBe('Technical Program Manager, Apps Platform');
  });
});

describe('matching and suggestions', () => {
  let db: Db;
  let ids: Record<string, number>;
  beforeEach(() => {
    db = openDb(':memory:');
    const add = (company: string, title: string, status = 'Applied' as const, url?: string) =>
      createApplication(db, { company, title, status, url, appliedAt: '2026-09-20' });
    ids = {
      dd1: add('DoorDash', 'Senior Technical Program Manager, Platform Services'),
      dd2: add('DoorDash', 'Technical Program Manager, Ads'),
      box: add(
        'Box, Inc.',
        'Staff Technical Program Manager',
        'Applied',
        'https://careers.box.com/jobs/1',
      ),
      gh: add('GitHub', 'Staff Technical Program Manager'),
      oa1: add('OpenAI', 'TPM, Compute'),
      oa2: add('OpenAI', 'TPM, Safety'),
    };
  });

  it('by title among several jobs at one company', () => {
    const m = matchApplication(
      meta({ subject: 'DoorDash Application Status' }),
      'Thank you for applying to the Senior Technical Program Manager, Platform Services position.',
      buildMatchContext(db),
    );
    expect(m).toMatchObject({
      companyName: 'DoorDash',
      applicationId: ids.dd1,
      matchedBy: 'title',
    });
  });

  it('by the only job, a company-suffix-insensitive name, and a known domain', () => {
    const ctx = buildMatchContext(db);
    expect(
      matchApplication(meta({ subject: 'Thank you for applying to Box!' }), '', ctx),
    ).toMatchObject({
      applicationId: ids.box,
      matchedBy: 'only',
    });
    expect(
      matchApplication(
        meta({ subject: 'An update', from: { name: null, address: 'no-reply@box.com' } }),
        '',
        ctx,
      ).applicationId,
    ).toBe(ids.box);
    expect(
      matchApplication(
        meta({
          subject: 'Thank You For Your Application',
          from: { name: 'GitHub, Inc. @ icims', address: 'githubinc+autoreply@talent.icims.com' },
        }),
        '',
        ctx,
      ).applicationId,
    ).toBe(ids.gh);
  });

  it('several jobs and no title: the company, and you pick the job', () => {
    const m = matchApplication(
      meta({ subject: 'Thank you for applying to OpenAI' }),
      '',
      buildMatchContext(db),
    );
    expect(m).toMatchObject({ companyName: 'OpenAI', applicationId: null });
    expect(m.companyId).not.toBeNull();
  });

  it('an unknown company is left untracked', () => {
    const m = matchApplication(
      meta({ subject: 'Thanks for applying to SpaceXAI!' }),
      '',
      buildMatchContext(db),
    );
    expect(m).toMatchObject({ companyName: 'SpaceXAI', companyId: null, applicationId: null });
  });

  it('what counts as job mail', () => {
    const ctx = buildMatchContext(db);
    expect(isCandidate(meta({ subject: 'Thank you for applying to Anthropic' }), ctx)).toBe(true);
    expect(
      isCandidate(
        meta({
          subject: 'Thank you for applying to OpenAI',
          from: { name: 'OpenAI Hiring Team', address: 'no-reply@openai.com' },
        }),
        ctx,
      ),
    ).toBe(true);
    // Alerts and nudges are not.
    expect(
      isCandidate(
        meta({
          subject: 'Technical Program Manager at Google',
          from: { address: 'jobalerts-noreply@linkedin.com' },
        }),
        ctx,
      ),
    ).toBe(false);
    expect(
      isCandidate(
        meta({
          subject: "Dave, apply now to 'TPM at Stripe'",
          from: { address: 'jobs-noreply@linkedin.com' },
        }),
        ctx,
      ),
    ).toBe(false);
    expect(
      isCandidate(
        meta({
          subject: 'Dave, your application was sent to LinkedIn',
          from: { address: 'jobs-noreply@linkedin.com' },
        }),
        ctx,
      ),
    ).toBe(true);
    expect(
      isCandidate(
        meta({
          subject: 'Your September Dream Job is waiting',
          from: { address: 'notifications@us.greenhouse-jobs.com' },
        }),
        ctx,
      ),
    ).toBe(false);
    expect(
      isCandidate(
        meta({
          subject: 'Software Engineering Manager @ Function Health',
          from: { address: 'donotreply@match.indeed.com' },
        }),
        ctx,
      ),
    ).toBe(false);
    expect(
      isCandidate(
        meta({
          subject: 'Pre-Order the Latest Apple Products',
          from: { address: 'Costco@digital.costco.com' },
        }),
        ctx,
      ),
    ).toBe(false);
  });

  it('never moves a job backwards or reopens a closed one', () => {
    expect(suggest({ status: 'Screening', appliedAt: null }, 'confirmation')).toMatchObject({
      status: 'Applied',
      noop: false,
    });
    expect(suggest({ status: 'Applied', appliedAt: '2026-09-20' }, 'confirmation')).toMatchObject({
      status: null,
      noop: true,
    });
    expect(suggest({ status: 'Applied', appliedAt: null }, 'confirmation')).toMatchObject({
      status: null,
      noop: false,
    });
    expect(suggest({ status: 'Applied', appliedAt: 'x' }, 'rejection').status).toBe('Rejected');
    expect(suggest({ status: 'Rejected', appliedAt: 'x' }, 'rejection').noop).toBe(true);
    expect(suggest({ status: 'Passed', appliedAt: null }, 'rejection').status).toBeNull();
    expect(suggest({ status: 'Applied', appliedAt: 'x' }, 'interview')).toMatchObject({
      status: 'Recruiter Screen',
      activityKind: 'Interview',
    });
    expect(suggest({ status: 'Interview Loop', appliedAt: 'x' }, 'interview').status).toBeNull();
    expect(suggest({ status: 'Ghosted', appliedAt: 'x' }, 'interview').status).toBe(
      'Recruiter Screen',
    );
    expect(suggest({ status: 'Rejected', appliedAt: 'x' }, 'interview').status).toBeNull();
    expect(suggest({ status: 'Applied', appliedAt: 'x' }, 'action').nextAction).toMatch(
      /form or assessment/,
    );
  });
});
