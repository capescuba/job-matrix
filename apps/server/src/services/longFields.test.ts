import { describe, expect, it } from 'vitest';
import { shortField } from '@jm/shared';
import { buildApp } from '../app.ts';
import { openDb } from '../db/client.ts';
import { createApplication } from './applications.ts';

const TOKEN = 't'.repeat(48);
const offline = (async () => new Response('', { status: 404 })) as typeof fetch;

// What a "Company" pick on a whole section of a careers page reads (Oracle, Sep 2026).
const bigBlock = `\n  Oracle  \n\nAbout Us\n${'As a world leader in cloud solutions, Oracle uses tomorrow’s technology. '.repeat(40)}`;

describe('long template fields', () => {
  it('shortField keeps the first line, tidied and clipped', () => {
    expect(shortField(bigBlock)).toBe('Oracle');
    expect(shortField('  Senior   TPM\nmore')).toBe('Senior TPM');
    expect(shortField('x'.repeat(500))).toHaveLength(200);
    expect(shortField('x'.repeat(500)).endsWith('…')).toBe(true);
    expect(shortField('\n \n')).toBeNull();
  });

  it('the side panel’s page check no longer fails on a big pick (was 400 "Invalid input")', async () => {
    const db = openDb(':memory:');
    createApplication(db, {
      company: 'Oracle',
      title: 'Principal TPM',
      status: 'Applied',
      appliedAt: '2026-09-20',
    });
    const app = buildApp(db, { extensionToken: TOKEN, fetchFn: offline });
    const res = await app.inject({
      method: 'POST',
      url: '/api/ext/context',
      headers: { 'x-jm-token': TOKEN },
      payload: {
        url: 'https://careers.oracle.com/en/sites/jobsearch/job/123',
        pageTitle: 'Principal TPM | Oracle Careers',
        fields: { title: `Principal TPM\n${'details '.repeat(200)}`, company: bigBlock },
        jsonLd: ['{}', 'x'.repeat(300_000)],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      detected: { title: 'Principal TPM', company: 'Oracle' },
      company: { name: 'Oracle' },
    });
  });

  it('capture keeps short fields to one line too', async () => {
    const db = openDb(':memory:');
    const app = buildApp(db, { extensionToken: TOKEN, fetchFn: offline });
    const res = await app.inject({
      method: 'POST',
      url: '/api/screen/capture',
      headers: { 'x-jm-token': TOKEN },
      payload: {
        url: 'https://careers.oracle.com/en/sites/jobsearch/job/456',
        fields: {
          title: 'Principal Technical Program Manager\nApply now',
          company: bigBlock,
          location: 'Austin, TX\nHybrid',
          descriptionText: 'Lead programs. '.repeat(50),
        },
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.json()).toMatchObject({
      title: 'Principal Technical Program Manager',
      company: 'Oracle',
    });
  });

  it('other bad input says which field', async () => {
    const app = buildApp(openDb(':memory:'), { extensionToken: TOKEN, fetchFn: offline });
    const res = await app.inject({
      method: 'POST',
      url: '/api/ext/context',
      headers: { 'x-jm-token': TOKEN },
      payload: { url: 'not a url' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^Invalid input \(url: /);
  });
});
