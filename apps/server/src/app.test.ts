import { beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { LLMProvider, StructuredRequest } from '@jm/ai';
import { estimateCostUsd, fitResultSchema, fitTotal, pricingFor, type FitResult } from '@jm/shared';
import { buildApp } from './app.ts';
import { subscribe, type RunEventEnvelope } from './services/aiEvents.ts';
import { openDb, type Db } from './db/client.ts';
import { resumeVersions } from './db/schema.ts';
import { planStatusChange } from './services/applications.ts';
import {
  assessFit,
  capUnpostedPay,
  computeGate,
  fitBatchStatus,
  payCheck,
  shortLabel,
  startFitBatch,
} from './services/fit.ts';
import { updateProfile } from './services/resume.ts';
import { weekStart } from './services/stats.ts';

// Parts 8/7/9/6/7 with weights .35/.2/.15/.15/.15 → total 7.5.
const sampleFit: FitResult = {
  verdict: 'Good fit',
  summary: 'Solid match.',
  whyNotHigher: 'Wants hands-on inference work.',
  parts: {
    skills: { score: 8, why: 'x' },
    level: { score: 7, why: 'x' },
    logistics: { score: 9, why: 'x' },
    pay: { score: 6, why: 'x' },
    upside: { score: 7, why: 'x' },
  },
  criteria: [
    { kind: 'must', criterion: 'Remote or hybrid ≤ 3 days/week', status: 'ok', note: 'Remote' },
    {
      kind: 'dealbreaker',
      criterion: 'Heavy travel (>25%)',
      status: 'unclear',
      note: 'Not stated',
    },
  ],
  strengths: [{ point: 'Ran launches', evidence: 'Led 12-team launch' }],
  gaps: [
    {
      gap: 'No hands-on model serving',
      theme: 'LLM inference experience',
      severity: 'Moderate',
      knownGap: true,
      mitigation: 'Frame data work',
    },
  ],
  flags: { levelMismatch: null, outreach: { recommended: true, why: 'Small team' } },
  facts: {
    officeDaysPerWeek: 0,
    travelPercent: null,
    yearsRequired: 10,
    employmentType: 'Full-time',
  },
  interviewFocus: ['Program risk'],
  talkingPoints: ['a', 'b', 'c'],
};

function fakeProvider() {
  let calls = 0;
  const provider: LLMProvider = {
    name: 'fake',
    defaultModel: 'fake-model',
    complete: async () => '',
    async completeStructured<S extends z.ZodType>(req: StructuredRequest<S>) {
      calls++;
      return {
        data: req.schema.parse(sampleFit) as z.infer<S>,
        provider: 'fake',
        model: 'fake-model',
      };
    },
  };
  return { provider, calls: () => calls };
}

let db: Db;
let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  db = openDb(':memory:');
  app = buildApp(db);
});

async function quickAdd(body: Record<string, unknown>) {
  const res = await app.inject({ method: 'POST', url: '/api/applications', payload: body });
  expect(res.statusCode).toBe(201);
  return res.json().id as number;
}

describe('applications API', () => {
  it('creates, lists, patches status with an event, and deletes', async () => {
    const id = await quickAdd({
      company: 'Acme',
      title: 'Senior TPM',
      url: 'https://boards.greenhouse.io/acme/1',
    });
    await quickAdd({ company: 'acme', title: 'Staff TPM' });

    const list = (await app.inject('/api/applications')).json();
    expect(list).toHaveLength(2);
    expect(new Set(list.map((r: { companyId: number }) => r.companyId)).size).toBe(1); // company dedupe
    expect(list.find((r: { id: number }) => r.id === id).source).toBe('Greenhouse');

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/applications/${id}`,
      payload: { status: 'Applied' },
    });
    const detail = patched.json();
    expect(detail.application.status).toBe('Applied');
    expect(detail.application.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(detail.events.map((e: { toStatus: string }) => e.toStatus)).toEqual([
      'Saved',
      'Applied',
    ]);

    // Detail form sends appliedAt: null together with the status change
    const id2 = await quickAdd({ company: 'Beta', title: 'TPM' });
    const res2 = await app.inject({
      method: 'PATCH',
      url: `/api/applications/${id2}`,
      payload: { status: 'Applied', appliedAt: null },
    });
    expect(res2.json().application.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect(
      (await app.inject({ method: 'DELETE', url: `/api/applications/${id}` })).statusCode,
    ).toBe(204);
    expect((await app.inject(`/api/applications/${id}`)).statusCode).toBe(404);
  });

  it('fills salary from a pasted description when the fields are empty', async () => {
    const id = await quickAdd({ company: 'Meta', title: 'TPM' });
    const d = (await app.inject(`/api/applications/${id}`)).json();
    await app.inject({
      method: 'PATCH',
      url: `/api/jobs/${d.job.id}`,
      payload: { descriptionText: 'Pay: $199,000/year to $272,000/year + bonus' },
    });
    const job = (await app.inject(`/api/applications/${id}`)).json().job;
    expect([job.salaryMin, job.salaryMax]).toEqual([199000, 272000]);
  });

  it('rejects invalid input', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/applications',
      payload: { company: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('reports stats', async () => {
    const id = await quickAdd({
      company: 'Acme',
      title: 'TPM',
      status: 'Applied',
      appliedAt: '2026-09-01',
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/applications/${id}`,
      payload: { status: 'Recruiter Screen' },
    });
    const stats = (await app.inject('/api/stats')).json();
    expect(stats.applied).toBe(1);
    expect(stats.responseRate).toBe(1);
    expect(stats.perWeek).toHaveLength(12);
  });
});

describe('activities', () => {
  it('logs a dated series, can set status dated to the activity, and feeds stats', async () => {
    const id = await quickAdd({ company: 'Acme', title: 'TPM' });
    const post = (body: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/api/applications/${id}/activities`, payload: body });

    expect(
      (await post({ at: '2026-09-10', kind: 'Applied', setStatus: 'Applied' })).statusCode,
    ).toBe(201);
    await post({ at: '2026-09-14', kind: 'Follow-up', summary: 'Pinged recruiter' });
    await post({ at: '2026-09-17', kind: 'Response', summary: 'Declined', setStatus: 'Rejected' });

    const d = (await app.inject(`/api/applications/${id}`)).json();
    expect(d.application.appliedAt).toBe('2026-09-10');
    expect(d.application.status).toBe('Rejected');
    expect(d.activities.map((a: { kind: string }) => a.kind)).toEqual([
      'Applied',
      'Follow-up',
      'Response',
    ]);
    expect(d.events.find((e: { toStatus: string }) => e.toStatus === 'Rejected').at).toBe(
      '2026-09-17T12:00:00.000Z',
    );

    const row = (await app.inject('/api/applications')).json()[0];
    expect(row.lastActivityAt).toBe('2026-09-17');

    const stats = (await app.inject('/api/stats')).json();
    expect(stats.responseRate).toBe(1);
    expect(stats.avgDaysToFirstResponse).toBeCloseTo(7, 0);

    expect((await post({ at: 'soon', kind: 'Note' })).statusCode).toBe(400);
    const actId = d.activities[1].id;
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/activities/${actId}` })).statusCode,
    ).toBe(204);
  });
});

describe('status transitions', () => {
  const now = new Date('2026-09-24T12:00:00Z');
  it('stamps appliedAt when leaving Saved', () => {
    expect(planStatusChange({ status: 'Saved', appliedAt: null }, 'Applied', now)).toEqual({
      changed: true,
      appliedAt: '2026-09-24',
    });
  });
  it('keeps an existing appliedAt', () => {
    expect(
      planStatusChange({ status: 'Applied', appliedAt: '2026-09-01' }, 'Rejected', now).appliedAt,
    ).toBe('2026-09-01');
  });
  it('does not stamp for Withdrawn from Saved', () => {
    expect(
      planStatusChange({ status: 'Saved', appliedAt: null }, 'Withdrawn', now).appliedAt,
    ).toBeNull();
  });
  it('no-ops on same status', () => {
    expect(planStatusChange({ status: 'Applied', appliedAt: null }, 'Applied', now).changed).toBe(
      false,
    );
  });
});

describe('fit scoring', () => {
  it('validates the schema', () => {
    expect(fitResultSchema.safeParse(sampleFit).success).toBe(true);
    expect(fitResultSchema.safeParse({ ...sampleFit, verdict: 'Amazing' }).success).toBe(false);
  });

  it('requires a JD and resume, then caches by input', async () => {
    const { provider, calls } = fakeProvider();
    const id = await quickAdd({ company: 'Acme', title: 'TPM' });
    await expect(assessFit(db, id, { provider })).rejects.toThrow(/job description/);

    const detail = (await app.inject(`/api/applications/${id}`)).json();
    await app.inject({
      method: 'PATCH',
      url: `/api/jobs/${detail.job.id}`,
      payload: { descriptionText: 'Run programs.' },
    });
    await expect(assessFit(db, id, { provider })).rejects.toThrow(/resume/);

    db.insert(resumeVersions)
      .values({ label: 'main', rawText: 'Led 12-team launch', isDefault: true })
      .run();
    const first = await assessFit(db, id, { provider });
    expect(first.cached).toBe(false);
    expect(first.assessment.overallScore).toBe(7.5);
    expect(first.assessment.gate).toBe('check'); // travel unclear
    expect((await assessFit(db, id, { provider })).cached).toBe(true);
    expect(calls()).toBe(1);
    await assessFit(db, id, { provider, force: true });
    expect(calls()).toBe(2);

    const list = (await app.inject('/api/applications')).json();
    expect(list[0]).toMatchObject({
      fitScore: 7.5,
      fitVerdict: 'Good fit',
      fitGate: 'check',
      outreachRecommended: true,
      levelMismatch: null,
    });
    expect(list[0].fitGateReasons[0]).toMatchObject({ kind: 'dealbreaker', status: 'unclear' });
  });
});

describe('gates', () => {
  it('fails on pay below the floor, even when every criterion is ok', async () => {
    const { provider } = fakeProvider();
    updateProfile(db, { minBase: 200_000 });
    db.insert(resumeVersions).values({ label: 'main', rawText: 'x', isDefault: true }).run();
    const id = await quickAdd({ company: 'Acme', title: 'TPM', descriptionText: 'Run programs.' });
    const detail = (await app.inject(`/api/applications/${id}`)).json();
    await app.inject({
      method: 'PATCH',
      url: `/api/jobs/${detail.job.id}`,
      payload: { salaryMin: 150_000, salaryMax: 190_000 },
    });
    const { assessment } = await assessFit(db, id, { provider });
    expect(assessment.gate).toBe('fail');
    expect(assessment.overallScore).toBe(7.5); // the score is still shown underneath
    expect((assessment.gateReasons as { label: string }[])[0].label).toBe('Base');
  });

  it('payCheck flags unlisted ranges and passes when the top end clears the floor', () => {
    expect(payCheck(200_000, null, null)?.status).toBe('unclear');
    expect(payCheck(200_000, 180_000, 240_000)).toBeNull();
    expect(payCheck(null, 100_000, 120_000)).toBeNull();
  });

  it('computeGate: fails beat checks; pass when all ok', () => {
    const ok = {
      ...sampleFit,
      criteria: sampleFit.criteria.map((c) => ({ ...c, status: 'ok' as const })),
    };
    expect(computeGate(ok, null).gate).toBe('pass');
    const failing = {
      ...sampleFit,
      criteria: [
        ...sampleFit.criteria,
        {
          kind: 'dealbreaker' as const,
          criterion: 'Contract roles',
          status: 'fails' as const,
          note: '6-month contract',
        },
      ],
    };
    const g = computeGate(failing, null);
    expect(g.gate).toBe('fail');
    expect(g.reasons[0].label).toBe('Contract roles');
  });

  it('shortLabel trims criteria to a readable tag', () => {
    expect(shortLabel('Remote, or hybrid ≤ 3 days/week within ~60 min of home')).toBe(
      'Remote',
    );
    expect(shortLabel('Heavy travel (>25%)')).toBe('Heavy travel');
  });

  it('caps pay at 6 when no range is posted, and reads ranges from the job text', async () => {
    const rich = {
      ...sampleFit,
      parts: { ...sampleFit.parts, pay: { score: 9, why: 'Meta pays well.' } },
    };
    expect(capUnpostedPay(rich, false).parts.pay).toMatchObject({ score: 6 });
    expect(capUnpostedPay(rich, true).parts.pay.score).toBe(9);

    const provider: LLMProvider = {
      name: 'fake',
      defaultModel: 'fake-model',
      complete: async () => '',
      async completeStructured<S extends z.ZodType>(req: StructuredRequest<S>) {
        return {
          data: req.schema.parse(rich) as z.infer<S>,
          provider: 'fake',
          model: 'fake-model',
        };
      },
    };
    updateProfile(db, { minBase: 200_000 });
    db.insert(resumeVersions).values({ label: 'main', rawText: 'x', isDefault: true }).run();
    const none = await quickAdd({ company: 'A', title: 'TPM', descriptionText: 'Run programs.' });
    const inText = await quickAdd({
      company: 'B',
      title: 'TPM',
      descriptionText: 'Run programs. The base range is $150,000 - $180,000 per year.',
    });
    const a = (await assessFit(db, none, { provider })).assessment;
    expect((a.result as FitResult).parts.pay.score).toBe(6);
    expect(a.gate).toBe('check'); // Base: no range posted
    const b = (await assessFit(db, inText, { provider })).assessment;
    expect((b.result as FitResult).parts.pay.score).toBe(9); // a range exists, no cap
    expect(b.gate).toBe('fail'); // $180k top is under the $200k floor
  });

  it('fitTotal weights the parts', () => {
    expect(fitTotal(sampleFit.parts)).toBe(7.5);
  });
});

describe('gap themes', () => {
  it('counts recurring themes across the latest assessment of each job', async () => {
    const { provider } = fakeProvider();
    db.insert(resumeVersions).values({ label: 'main', rawText: 'x', isDefault: true }).run();
    const a = await quickAdd({ company: 'Acme', title: 'TPM', descriptionText: 'A' });
    const b = await quickAdd({ company: 'Beta', title: 'TPM', descriptionText: 'B' });
    await assessFit(db, a, { provider });
    await assessFit(db, b, { provider });
    await assessFit(db, a, { provider, force: true }); // re-score: still counted once for Acme
    const stats = (await app.inject('/api/stats')).json();
    expect(stats.gapThemes[0]).toMatchObject({
      theme: 'LLM inference experience',
      count: 2,
      knownGap: true,
    });
    expect(stats.gapThemes[0].jobs).toHaveLength(2);
  });
});

describe('weekStart', () => {
  it('returns Monday', () => {
    expect(weekStart('2026-09-24')).toBe('2026-09-21'); // Thursday → Monday
    expect(weekStart('2026-09-21')).toBe('2026-09-21');
    expect(weekStart('2026-09-27')).toBe('2026-09-21'); // Sunday
  });
});

describe('AI usage', () => {
  it('logs each real call (not cache hits) with an estimated cost', async () => {
    const provider: LLMProvider = {
      name: 'anthropic',
      defaultModel: 'claude-sonnet-5',
      complete: async () => '',
      async completeStructured<S extends z.ZodType>(req: StructuredRequest<S>) {
        return {
          data: req.schema.parse(sampleFit) as z.infer<S>,
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          usage: {
            inputTokens: 10_000,
            outputTokens: 3_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        };
      },
    };
    const id = await quickAdd({ company: 'Acme', title: 'TPM', descriptionText: 'Run programs.' });
    db.insert(resumeVersions)
      .values({ label: 'main', rawText: 'Led launches', isDefault: true })
      .run();
    await assessFit(db, id, { provider });
    await assessFit(db, id, { provider }); // cache hit — no new call

    const u = (await app.inject('/api/usage')).json();
    expect(u.total.calls).toBe(1);
    // Sonnet 5: 10k in × $2/M + 3k out × $10/M = $0.05
    expect(u.total.costUsd).toBeCloseTo(0.05, 6);
    expect(u.byModel[0]).toMatchObject({
      model: 'claude-sonnet-5',
      label: 'Claude Sonnet 5',
      calls: 1,
    });
    expect(u.recent[0]).toMatchObject({ feature: 'fit', applicationId: id });
    expect(u.forecast).toMatchObject({ pending: 0, basis: 'estimate' });
  });
});

describe('pricing', () => {
  it('matches the longest model prefix', () => {
    expect(pricingFor('claude-opus-5-5')?.label).toBe('Claude Opus 5.5');
    expect(pricingFor('claude-opus-5')?.label).toBe('Claude Opus 5');
    expect(pricingFor('mystery-model')).toBeNull();
    expect(
      estimateCostUsd('claude-opus-5', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
      }),
    ).toBeCloseTo(5.5);
  });
});

describe('background batch scoring', () => {
  it('scores all unscored jobs a few at a time and reports progress', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const provider: LLMProvider = {
      name: 'fake',
      defaultModel: 'fake-model',
      complete: async () => '',
      async completeStructured<S extends z.ZodType>(req: StructuredRequest<S>) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return {
          data: req.schema.parse(sampleFit) as z.infer<S>,
          provider: 'fake',
          model: 'fake-model',
        };
      },
    };
    db.insert(resumeVersions).values({ label: 'main', rawText: 'x', isDefault: true }).run();
    for (let i = 0; i < 9; i++)
      await quickAdd({ company: `Co${i}`, title: 'TPM', descriptionText: `JD ${i}` });
    await quickAdd({ company: 'NoJD', title: 'TPM' }); // not eligible

    const started = startFitBatch(db, { provider, concurrency: 4 });
    expect(started).toMatchObject({ running: true, total: 9, done: 0 });
    expect(startFitBatch(db, { provider })).toBe(started); // second click joins the running batch

    while (fitBatchStatus()?.running) await new Promise((r) => setTimeout(r, 10));
    expect(fitBatchStatus()).toMatchObject({
      running: false,
      total: 9,
      done: 9,
      scored: 9,
      failed: [],
    });
    expect(maxInFlight).toBe(4);
  });
});

describe('live activity & call traces', () => {
  it('emits steps, thinking and output, then stores the full trace', async () => {
    const provider: LLMProvider = {
      name: 'anthropic',
      defaultModel: 'claude-sonnet-5',
      complete: async () => '',
      async completeStructured<S extends z.ZodType>(req: StructuredRequest<S>) {
        req.onEvent?.({ type: 'request', model: 'claude-sonnet-5', effort: 'low' });
        req.onEvent?.({ type: 'thinking', text: 'Checking office days…' });
        req.onEvent?.({ type: 'output', text: '{"verdict":' });
        return {
          data: req.schema.parse(sampleFit) as z.infer<S>,
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          usage: { inputTokens: 1000, outputTokens: 500 },
          trace: {
            request: { model: 'claude-sonnet-5', system: req.system },
            responseText: JSON.stringify(sampleFit),
            thinking: 'Checking office days…',
            stopReason: 'end_turn',
            durationMs: 1234,
          },
        };
      },
    };
    db.insert(resumeVersions).values({ label: 'main', rawText: 'x', isDefault: true }).run();
    const id = await quickAdd({ company: 'Acme', title: 'TPM', descriptionText: 'Run programs.' });

    const seen: RunEventEnvelope[] = [];
    const unsubscribe = subscribe((e) => seen.push(e));
    const { assessment } = await assessFit(db, id, { provider });
    unsubscribe();

    const types = seen.map((e) => e.type);
    expect(types[0]).toBe('start');
    expect(types).toContain('thinking');
    expect(types).toContain('output');
    expect(types.at(-1)).toBe('done');
    const steps = seen.flatMap((e) => (e.type === 'step' ? [e.text] : []));
    expect(steps[0]).toMatch(/^Built the prompt/);
    expect(steps).toContain('Sent to Claude Sonnet 5');
    expect(steps).toContain('Thinking…');
    expect(steps).toContain('Writing the assessment…');
    expect(steps.at(-1)).toMatch(/^Total 7\.5 from the parts/);
    expect(new Set(seen.map((e) => e.runId)).size).toBe(1);

    const call = (await app.inject(`/api/ai/calls/${assessment.usageId}`)).json();
    expect(call).toMatchObject({
      durationMs: 1234,
      stopReason: 'end_turn',
      thinkingText: 'Checking office days…',
      requestJson: { model: 'claude-sonnet-5' },
    });
    expect(JSON.parse(call.responseText).verdict).toBe('Good fit');

    // Cache hit: a run that says so, no new call.
    const again: RunEventEnvelope[] = [];
    const un2 = subscribe((e) => again.push(e));
    await assessFit(db, id, { provider });
    un2();
    expect(again.at(-1)).toMatchObject({ type: 'done', usageId: assessment.usageId });
    expect((again.at(-1) as { text: string }).text).toMatch(/reused/);
  });
});
