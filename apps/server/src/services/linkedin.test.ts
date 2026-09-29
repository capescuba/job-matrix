import { beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { LLMProvider, StructuredRequest } from '@jm/ai';
import type { FitResult } from '@jm/shared';
import { buildApp } from '../app.ts';
import { openDb, type Db } from '../db/client.ts';
import { resumeVersions } from '../db/schema.ts';
import { createApplication } from './applications.ts';
import { buildCareerProfile } from './careerProfile.ts';
import { suggestAnswer } from './extension.ts';
import {
  FIT_PROMPT_VERSION,
  assessFit,
  fitBatchStatus,
  fitInputsFor,
  staleOpenApplicationIds,
  startFitBatch,
} from './fit.ts';
import { linkedinTextOf, profileUrl, saveLinkedIn } from './linkedin.ts';
import { getProfile, updateProfile } from './resume.ts';

const TOKEN = 't'.repeat(48);

const sampleFit: FitResult = {
  verdict: 'Good fit',
  summary: 'Solid match.',
  whyNotHigher: 'x',
  parts: {
    skills: { score: 8, why: 'x' },
    level: { score: 7, why: 'x' },
    logistics: { score: 9, why: 'x' },
    pay: { score: 6, why: 'x' },
    upside: { score: 7, why: 'x' },
  },
  criteria: [],
  strengths: [{ label: 'Ran big launches', point: 'Ran launches', evidence: 'Led 12-team launch' }],
  gaps: [],
  flags: { levelMismatch: null, outreach: { recommended: false, why: '' } },
  facts: {
    officeDaysPerWeek: 0,
    travelPercent: null,
    yearsRequired: 10,
    employmentType: 'Full-time',
  },
  interviewFocus: [],
  talkingPoints: ['a', 'b', 'c'],
};

/** A fake AI: records prompts; returns `data` (a function of the request, or a value). */
function fake(data: (req: StructuredRequest<z.ZodType>) => unknown) {
  const prompts: string[] = [];
  const models: (string | undefined)[] = [];
  const provider: LLMProvider = {
    name: 'fake',
    defaultModel: 'fake-model',
    complete: async () => '',
    async completeStructured<S extends z.ZodType>(req: StructuredRequest<S>) {
      prompts.push(`${req.system}\n${req.prompt}`);
      models.push(req.model);
      return {
        data: req.schema.parse(data(req as unknown as StructuredRequest<z.ZodType>)) as z.infer<S>,
        provider: 'fake',
        model: 'fake-model',
        usage: { inputTokens: 20_000, outputTokens: 5_000 },
      };
    },
  };
  return { provider, prompts, models };
}

const IMPORT = {
  url: 'https://www.linkedin.com/in/dave-b/details/experience/?x=1',
  headline: 'Dave B\nPrincipal TPM · AI platforms',
  sections: {
    about: 'I run large AI platform programs.',
    experience:
      'Workday\nPrincipal TPM\n2021 – Present\nLed the agentic AI platform across 14 teams; $30M budget.',
    projects: '',
    recommendations: '“Dave shipped what three others couldn’t.” — A. Manager',
  },
};

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
  db.insert(resumeVersions)
    .values({ label: 'main', rawText: 'Principal TPM, Workday.', isDefault: true })
    .run();
});

describe('LinkedIn import', () => {
  it('profile addresses', () => {
    expect(profileUrl('linkedin.com/in/dave-b/details/skills/')).toBe(
      'https://www.linkedin.com/in/dave-b/',
    );
    expect(profileUrl('https://www.linkedin.com/jobs/view/1')).toBeNull();
    expect(profileUrl('https://example.com/in/x')).toBeNull();
  });

  it('saves the sections under headings, skipping empty ones', () => {
    const s = saveLinkedIn(db, IMPORT);
    expect(s.url).toBe('https://www.linkedin.com/in/dave-b/');
    expect(s.sections.find((x) => x.key === 'experience')!.chars).toBeGreaterThan(40);
    expect(s.sections.find((x) => x.key === 'projects')!.chars).toBe(0);
    const text = getProfile(db).linkedinText!;
    expect(text).toMatch(
      /^Dave B\nPrincipal TPM · AI platforms\n\n## About\nI run large AI platform programs\./,
    );
    expect(text).toContain('## Experience\nWorkday');
    expect(text).toContain('## Recommendations received');
    expect(text).not.toContain('## Projects');
    expect(linkedinTextOf(null, { other: 'x' })).toBe('## other\nx');
  });

  it('routes: the import needs the extension token; the page sees a summary, not the text', async () => {
    const app = buildApp(db, { extensionToken: TOKEN });
    expect(
      (await app.inject({ method: 'POST', url: '/api/linkedin', payload: IMPORT })).statusCode,
    ).toBe(401);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/linkedin',
      headers: { 'x-jm-token': TOKEN },
      payload: IMPORT,
    });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/linkedin',
      headers: { 'x-jm-token': TOKEN },
      payload: { ...IMPORT, url: 'https://www.linkedin.com/jobs/view/1' },
    });
    expect(bad.statusCode).toBe(400);
    const prof = (await app.inject('/api/profile')).json();
    expect(prof.profile.linkedinText).toBeUndefined();
    expect(prof.linkedin.chars).toBeGreaterThan(100);
    expect((await app.inject('/api/linkedin/text')).json().text).toContain('## Experience');
    expect((await app.inject({ method: 'DELETE', url: '/api/linkedin' })).json().chars).toBe(0);
  });
});

describe('career profile', () => {
  it('is built from the resume and LinkedIn, recorded as "profile", and editable', async () => {
    saveLinkedIn(db, IMPORT);
    const { provider, prompts } = fake(() => ({
      profile: '## Summary\nPrincipal TPM.\n## Workday — Principal TPM (2021–)\n- 14 teams, $30M',
      conflicts: ['Resume says 2020, LinkedIn 2021'],
    }));
    const r = await buildCareerProfile(db, { provider });
    expect(prompts[0]).toContain('<resume>\nPrincipal TPM, Workday.');
    expect(prompts[0]).toContain('$30M budget');
    expect(r.careerProfile).toContain(
      '## Resume and LinkedIn disagree\n- Resume says 2020, LinkedIn 2021',
    );
    const usage = db.$client.prepare('SELECT feature FROM ai_usage').all() as { feature: string }[];
    expect(usage.map((u) => u.feature)).toEqual(['profile']);
    updateProfile(db, { careerProfile: 'Edited by me.' });
    expect(getProfile(db).careerProfile).toBe('Edited by me.');
  });
});

describe('using it', () => {
  const addJob = (status: 'Applied' | 'Rejected' = 'Applied') =>
    createApplication(db, {
      company: 'Acme',
      title: 'Principal TPM',
      status,
      descriptionText: 'Lead AI programs.',
    });

  it('fit scoring reads the career profile, and editing it makes scores stale', async () => {
    expect(FIT_PROMPT_VERSION).toBe('tpm-v5');
    const open = addJob();
    const closed = addJob('Rejected');
    const { provider, prompts } = fake(() => sampleFit);
    await assessFit(db, open, { provider });
    await assessFit(db, closed, { provider });
    expect(prompts[0]).not.toContain('<career_profile>');
    expect(staleOpenApplicationIds(db, 'fake-model', 'low')).toEqual([]);

    updateProfile(db, { careerProfile: 'Led 14 teams at Workday.' });
    const before = fitInputsFor(db, open, 'fake-model', 'low').inputHash;
    expect(staleOpenApplicationIds(db, 'fake-model', 'low')).toEqual([open]); // closed jobs are left alone
    await assessFit(db, open, { provider });
    expect(prompts[2]).toContain('<career_profile>\nLed 14 teams at Workday.\n</career_profile>');
    expect(prompts[2]).toContain('career profile');
    updateProfile(db, { careerProfile: 'Led 15 teams at Workday.' });
    expect(fitInputsFor(db, open, 'fake-model', 'low').inputHash).not.toBe(before);
  });

  it('re-scoring on request covers only stale open jobs, and really re-scores', async () => {
    const a = addJob();
    const { provider, prompts } = fake(() => sampleFit);
    await assessFit(db, a, { provider });
    updateProfile(db, { careerProfile: 'More detail.' });
    const s = startFitBatch(db, { stale: true, provider });
    expect(s.total).toBe(1);
    while (fitBatchStatus()?.running) await new Promise((r) => setTimeout(r, 5));
    expect(prompts).toHaveLength(2);
    expect(staleOpenApplicationIds(db, 'fake-model', 'low')).toEqual([]);
  });

  it('application answers get the LinkedIn text and the career profile', async () => {
    saveLinkedIn(db, IMPORT);
    updateProfile(db, { careerProfile: 'Career inventory.' });
    const id = addJob();
    const { provider, prompts } = fake(() => ({ answer: 'I led 14 teams.', basedOn: 'Workday' }));
    await suggestAnswer(db, { applicationId: id, question: 'Why us?' }, { provider });
    expect(prompts[0]).toContain('<applicant_linkedin>');
    expect(prompts[0]).toContain('$30M budget');
    expect(prompts[0]).toContain('<applicant_career_profile>\nCareer inventory.');
  });

  it('the career profile route reports cost and stale jobs', async () => {
    const app = buildApp(db);
    const r = (await app.inject('/api/career-profile')).json();
    expect(r).toMatchObject({
      careerProfile: null,
      hasResume: true,
      hasLinkedIn: false,
      staleJobs: 0,
    });
    expect(r.buildUsd).toBeGreaterThan(0);
  });
});
