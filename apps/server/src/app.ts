import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { asc, eq } from 'drizzle-orm';
import { ZodError, z } from 'zod';
import { EFFORTS, LLMError } from '@jm/ai';
import {
  STATUSES,
  activitySchema,
  applicationPatchSchema,
  captureSchema,
  contactSchema,
  jobPatchSchema,
  profilePatchSchema,
  quickAddSchema,
} from '@jm/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db/client.ts';
import { companies, contacts, resumeVersions } from './db/schema.ts';
import {
  NotFoundError,
  addActivity,
  createApplication,
  deleteActivity,
  deleteApplication,
  getApplicationDetail,
  listApplications,
  updateApplication,
  updateJob,
} from './services/applications.ts';
import { FitError, assessFit, fitBatchStatus, startFitBatch } from './services/fit.ts';
import {
  JobFetchError,
  applyFetchedJob,
  checkPostings,
  fetchJobPosting,
  fetchMissingDescriptions,
} from './services/jobfetch.ts';
import { addResume, getProfile, setDefaultResume, updateProfile } from './services/resume.ts';
import { getSettings, updateSettings } from './services/settings.ts';
import { analyzeApplication } from './services/analyze.ts';
import { ensureResearch, isStale, latestResearch } from './services/research.ts';
import { captureJob, findTrackedByUrl } from './services/screening.ts';
import { getStock } from './services/stock.ts';
import { getStats } from './services/stats.ts';
import {
  answerRequestSchema,
  deleteAnswer,
  deleteTemplate,
  getTemplate,
  listAnswers,
  pageContext,
  pageInputSchema,
  saveTemplate,
  similarAnswers,
  suggestAnswer,
  templateSchema,
} from './services/extension.ts';
import { EXTENSION_ORIGIN, extensionToken, tokenMatches } from './services/token.ts';
import { getCall, getUsageSummary } from './services/usage.ts';
import { replay, subscribe, type RunEventEnvelope } from './services/aiEvents.ts';

const idParam = z.object({ id: z.coerce.number().int() });

export function buildApp(
  db: Db,
  opts: { logger?: boolean; extensionToken?: string; fetchFn?: typeof fetch } = {},
) {
  const token = () => opts.extensionToken ?? extensionToken();
  /** Extension routes: the shared token must be in X-JM-Token (blocks other web pages). */
  const requireToken = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!tokenMatches(req.headers['x-jm-token'], token()))
      return reply.status(401).send({ error: 'Missing or wrong extension token' });
  };

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024 });
  app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError)
      return reply.status(400).send({ error: 'Invalid input', issues: err.issues });
    if (err instanceof NotFoundError) return reply.status(404).send({ error: err.message });
    if (err instanceof FitError || err instanceof LLMError || err instanceof JobFetchError)
      return reply.status(422).send({ error: err.message });
    app.log.error(err);
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: (err as Error).message });
  });

  // ----- applications -----
  app.get('/api/applications', () => listApplications(db));
  app.post('/api/applications', (req, reply) => {
    const id = createApplication(db, quickAddSchema.parse(req.body));
    return reply.status(201).send({ id });
  });
  app.get('/api/applications/:id', (req) => getApplicationDetail(db, idParam.parse(req.params).id));
  app.patch('/api/applications/:id', (req) => {
    const { id } = idParam.parse(req.params);
    updateApplication(db, id, applicationPatchSchema.parse(req.body));
    return getApplicationDetail(db, id);
  });
  app.delete('/api/applications/:id', (req, reply) => {
    deleteApplication(db, idParam.parse(req.params).id);
    return reply.status(204).send();
  });

  // ----- activities (follow-ups, responses, interviews…) -----
  app.post('/api/applications/:id/activities', (req, reply) => {
    const { id } = idParam.parse(req.params);
    const row = addActivity(db, id, activitySchema.parse(req.body));
    return reply.status(201).send(row);
  });
  app.delete('/api/activities/:id', (req, reply) => {
    deleteActivity(db, idParam.parse(req.params).id);
    return reply.status(204).send();
  });

  // ----- fit scoring -----
  app.post('/api/applications/:id/fit', async (req) => {
    const { id } = idParam.parse(req.params);
    const { force } = z
      .object({
        force: z
          .string()
          .optional()
          .transform((v) => v === '1' || v === 'true'),
      })
      .parse(req.query);
    return assessFit(db, id, { force });
  });
  // Starts (or reports) a background batch; the UI polls GET for progress.
  app.post('/api/fit/batch', (req) => {
    const { status, research } = z
      .object({
        status: z.enum(STATUSES).optional(),
        research: z
          .string()
          .optional()
          .transform((v) => v === '1' || v === 'true'),
      })
      .parse(req.query);
    return startFitBatch(db, {
      status,
      ...(research && { task: (id: number) => analyzeApplication(db, id) }),
    });
  });
  // Screening's Score: fit + company research (if not fresh), in parallel.
  app.post('/api/applications/:id/analyze', async (req) => {
    const { id } = idParam.parse(req.params);
    const { force } = z
      .object({
        force: z
          .string()
          .optional()
          .transform((v) => v === '1' || v === 'true'),
      })
      .parse(req.query);
    return analyzeApplication(db, id, { force });
  });

  // ----- company research & stock -----
  app.get('/api/companies/:id/research', (req) => {
    const r = latestResearch(db, idParam.parse(req.params).id);
    return r && { ...r, stale: isStale(r) };
  });
  app.post('/api/companies/:id/research', async (req) => {
    const { id } = idParam.parse(req.params);
    const { research } = await ensureResearch(db, id, { force: true });
    return research;
  });
  app.get('/api/companies/:id/stock', async (req) => {
    const r = latestResearch(db, idParam.parse(req.params).id);
    return r?.ticker ? await getStock(r.ticker, opts.fetchFn) : null;
  });
  app.get('/api/fit/batch', () => fitBatchStatus());

  // ----- screening capture -----
  // From the Chrome extension: the page as you see it (selection, template fields, page text).
  app.post('/api/screen/capture', { preHandler: requireToken }, async (req, reply) => {
    const r = await captureJob(db, captureSchema.parse(req.body), { fetchFn: opts.fetchFn });
    return reply.status(r.existing ? 200 : 201).send(r);
  });
  // From the Screening page's "Screen a URL" box: server-side fetch only.
  app.post('/api/screen/url', async (req, reply) => {
    const { url } = z.object({ url: z.string().trim().url() }).parse(req.body);
    const r = await captureJob(db, { url }, { fetchFn: opts.fetchFn });
    return reply.status(r.existing ? 200 : 201).send(r);
  });
  // Is this posting already tracked? (the extension popup asks before capturing)
  app.get('/api/screen/lookup', { preHandler: requireToken }, (req) => {
    const { url } = z.object({ url: z.string().url() }).parse(req.query);
    return { tracked: findTrackedByUrl(db, url) };
  });

  // ----- Chrome extension (side panel) -----
  const hostParam = z.object({ host: z.string().trim().min(1).max(253) });
  app.get('/api/ext/hello', { preHandler: requireToken }, () => ({ ok: true, app: 'job-matrix' }));
  app.post('/api/ext/context', { preHandler: requireToken }, (req) =>
    pageContext(db, pageInputSchema.parse(req.body), { fetchFn: opts.fetchFn }),
  );
  app.get('/api/ext/templates/:host', { preHandler: requireToken }, (req) =>
    getTemplate(db, hostParam.parse(req.params).host),
  );
  app.put('/api/ext/templates/:host', { preHandler: requireToken }, (req) =>
    saveTemplate(db, hostParam.parse(req.params).host, templateSchema.parse(req.body)),
  );
  app.delete('/api/ext/templates/:host', { preHandler: requireToken }, (req, reply) => {
    deleteTemplate(db, hostParam.parse(req.params).host);
    return reply.status(204).send();
  });
  app.post('/api/ext/answer', { preHandler: requireToken }, (req) =>
    suggestAnswer(db, answerRequestSchema.parse(req.body)),
  );
  app.get('/api/ext/answers', { preHandler: requireToken }, (req) =>
    similarAnswers(db, z.object({ q: z.string().max(2000) }).parse(req.query).q),
  );
  // Saved answers on the job page.
  app.get('/api/applications/:id/answers', (req) => listAnswers(db, idParam.parse(req.params).id));
  app.delete('/api/answers/:id', (req, reply) => {
    deleteAnswer(db, idParam.parse(req.params).id);
    return reply.status(204).send();
  });

  // ----- job description import -----
  app.post('/api/fetch-job', async (req) => {
    const { url } = z.object({ url: z.string().min(1) }).parse(req.body);
    return fetchJobPosting(url);
  });
  app.post('/api/jobs/:id/fetch-description', async (req) => {
    const { id } = idParam.parse(req.params);
    const { url } = z.object({ url: z.string().min(1) }).parse(req.body);
    const fetched = await fetchJobPosting(url);
    applyFetchedJob(db, id, fetched);
    return fetched;
  });
  app.post('/api/jobs/fetch-missing', () => fetchMissingDescriptions(db));
  app.post('/api/jobs/check-postings', () => checkPostings(db));

  // ----- jobs & companies -----
  app.patch('/api/jobs/:id', (req) => {
    updateJob(db, idParam.parse(req.params).id, jobPatchSchema.parse(req.body));
    return { ok: true };
  });
  app.get('/api/companies', () => db.select().from(companies).orderBy(asc(companies.name)).all());
  app.patch('/api/companies/:id', (req) => {
    const patch = z
      .object({
        name: z.string().min(1).optional(),
        website: z.string().nullable().optional(),
        linkedinUrl: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      })
      .parse(req.body);
    db.update(companies)
      .set(patch)
      .where(eq(companies.id, idParam.parse(req.params).id))
      .run();
    return { ok: true };
  });

  // ----- contacts -----
  app.post('/api/contacts', (req, reply) => {
    const row = db.insert(contacts).values(contactSchema.parse(req.body)).returning().get();
    return reply.status(201).send(row);
  });
  app.patch('/api/contacts/:id', (req) => {
    const patch = contactSchema.partial().parse(req.body);
    return db
      .update(contacts)
      .set(patch)
      .where(eq(contacts.id, idParam.parse(req.params).id))
      .returning()
      .get();
  });
  app.delete('/api/contacts/:id', (req, reply) => {
    db.delete(contacts)
      .where(eq(contacts.id, idParam.parse(req.params).id))
      .run();
    return reply.status(204).send();
  });

  // ----- profile & resumes -----
  app.get('/api/profile', () => ({
    profile: getProfile(db),
    resumes: db
      .select({
        id: resumeVersions.id,
        label: resumeVersions.label,
        isDefault: resumeVersions.isDefault,
        createdAt: resumeVersions.createdAt,
        chars: resumeVersions.rawText,
      })
      .from(resumeVersions)
      .orderBy(asc(resumeVersions.id))
      .all()
      .map((r) => ({ ...r, chars: r.chars.length })),
    aiConfigured: getSettings().aiConfigured,
  }));
  app.patch('/api/profile', (req) => {
    updateProfile(db, profilePatchSchema.parse(req.body));
    return getProfile(db);
  });
  app.get('/api/resumes/:id', (req) => {
    const row = db
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.id, idParam.parse(req.params).id))
      .get();
    if (!row) throw new NotFoundError('Resume not found');
    return row;
  });
  app.post('/api/resumes', async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.status(400).send({ error: 'No file uploaded' });
    const labelField = file.fields.label as { value?: string } | undefined;
    const label = labelField?.value?.trim() || file.filename;
    const row = await addResume(db, label, file.filename, await file.toBuffer());
    return reply.status(201).send({ id: row.id, label: row.label, chars: row.rawText.length });
  });
  app.post('/api/resumes/:id/default', (req) => {
    setDefaultResume(db, idParam.parse(req.params).id);
    return { ok: true };
  });
  app.delete('/api/resumes/:id', (req, reply) => {
    db.delete(resumeVersions)
      .where(eq(resumeVersions.id, idParam.parse(req.params).id))
      .run();
    return reply.status(204).send();
  });

  // ----- AI usage & live activity -----
  app.get('/api/usage', () => getUsageSummary(db));
  app.get('/api/ai/calls/:id', (req) => {
    const call = getCall(db, idParam.parse(req.params).id);
    if (!call) throw new NotFoundError('Call not found');
    return call;
  });
  /**
   * Server-Sent Events: live steps, thinking and output from AI calls. Replays recent runs first
   * so a page opened mid-call catches up. ?applicationId= limits it to one job.
   */
  app.get('/api/ai/events', (req, reply) => {
    const { applicationId } = z
      .object({ applicationId: z.coerce.number().int().optional() })
      .parse(req.query);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // The extension's side panel shows live progress too; no other site may read it.
      ...(req.headers.origin === EXTENSION_ORIGIN && {
        'Access-Control-Allow-Origin': EXTENSION_ORIGIN,
      }),
    });
    const send = (e: RunEventEnvelope) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    for (const e of replay(applicationId)) send(e);
    const unsubscribe = subscribe((e) => {
      if (applicationId == null || e.type !== 'start' || e.applicationId === applicationId) send(e);
    });
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  // ----- settings & health -----
  app.get('/api/health', () => ({ ok: true }));
  app.get('/api/settings', () => getSettings());
  app.put('/api/settings', (req) => {
    const body = z
      .object({
        anthropicApiKey: z.string().max(500).nullable().optional(),
        aiModel: z.string().max(100).nullable().optional(),
        aiResearchModel: z.string().max(100).nullable().optional(),
        aiEffort: z.enum(EFFORTS).nullable().optional(),
      })
      .parse(req.body);
    return updateSettings({
      ...(body.anthropicApiKey !== undefined && { ANTHROPIC_API_KEY: body.anthropicApiKey }),
      ...(body.aiModel !== undefined && { AI_MODEL: body.aiModel }),
      ...(body.aiResearchModel !== undefined && { AI_RESEARCH_MODEL: body.aiResearchModel }),
      ...(body.aiEffort !== undefined && { AI_EFFORT: body.aiEffort }),
    });
  });

  // ----- dashboard -----
  app.get('/api/stats', () => getStats(db));

  return app;
}
