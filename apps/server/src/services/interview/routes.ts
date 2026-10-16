import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { EngineError, LocalAudioEngine, type AudioEngine } from '@jm/audio-engine';
import type { LLMProvider } from '@jm/ai';
import { INTERVIEW_ROUNDS, pricingFor, type CompanyResearch } from '@jm/shared';
import type { Db } from '../../db/client.ts';
import { aiUsage, applications, companies, jobs } from '../../db/schema.ts';
import { INTERVIEWS_DIR, REPO_ROOT } from '../../paths.ts';
import { NotFoundError } from '../applications.ts';
import { logEvent } from '../log.ts';
import { latestResearch } from '../research.ts';
import { audioEngineInstall, getSettings } from '../settings.ts';
import { repricedAverage } from '../usage.ts';
import { DebriefNotReadyError, debriefSession } from './debrief.ts';
import { generatePrep } from './prep.ts';
import {
  activeSessionCount,
  existingSession,
  liveSession,
  releaseSession,
  type SessionEvent,
} from './session.ts';
import {
  createSession,
  deleteSession,
  getSession,
  getSessionRow,
  listSessions,
  sessionDir,
} from './store.ts';

const idParam = z.object({ id: z.coerce.number().int() });

export class ConflictError extends Error {}

export interface InterviewRouteOptions {
  /** Tests pass a fake; otherwise the local Python engine, created on first use. */
  audioEngine?: AudioEngine;
  provider?: () => LLMProvider;
  root?: string;
  rememberDevices?: (mic: string | null, output: string | null) => void;
}

/** Rough cost of one call of `feature` on `model`, from past calls when there are any. */
function estimate(db: Db, feature: string, model: string, fallbackUsd: number) {
  const rows = db.select().from(aiUsage).where(eq(aiUsage.feature, feature)).all();
  const fromHistory = rows.length ? repricedAverage(rows, feature, model) : null;
  const scale = (pricingFor(model)?.input ?? 2) / 2;
  return fromHistory ?? fallbackUsd * scale;
}

export function registerInterviewRoutes(app: FastifyInstance, db: Db, opts: InterviewRouteOptions) {
  const root = opts.root ?? INTERVIEWS_DIR;
  let created: LocalAudioEngine | null = null;
  const engine = (): AudioEngine => {
    if (opts.audioEngine) return opts.audioEngine;
    if (!created) {
      const install = audioEngineInstall();
      if (!install.installed)
        throw new EngineError(
          'The audio engine is not installed yet. Run scripts\\install-audio-engine.ps1 once, then try again.',
        );
      created = new LocalAudioEngine({
        pythonExe: install.python,
        enginePy: path.join(REPO_ROOT, 'apps', 'audio-engine', 'engine.py'),
        model: getSettings().transcriberModel,
        onLog: (line, stream) =>
          logEvent('audio-engine', line.slice(0, 500), {}, stream === 'err' ? 'warn' : 'info'),
      });
    }
    return created;
  };
  const deps = () => ({
    db,
    engine: engine(),
    provider: opts.provider,
    root,
    rememberDevices: opts.rememberDevices,
  });

  app.addHook('onClose', async () => {
    await created?.shutdown();
  });

  const fail = (e: unknown) => {
    if (e instanceof EngineError) return { status: 503, error: e.message };
    if (e instanceof DebriefNotReadyError || e instanceof ConflictError)
      return { status: 409, error: e.message };
    return null;
  };

  app.get('/api/applications/:id/interviews', (req) =>
    listSessions(db, idParam.parse(req.params).id, root),
  );

  app.post('/api/applications/:id/interviews', (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        round: z.enum(INTERVIEW_ROUNDS),
        recordAudio: z.boolean().default(true),
        micDevice: z.string().max(300).nullable().optional(),
        outputDevice: z.string().max(300).nullable().optional(),
      })
      .parse(req.body);
    const s = getSettings();
    const row = createSession(db, id, {
      round: body.round,
      coachModel: s.coachModel,
      recordAudio: body.recordAudio,
      micDevice: body.micDevice ?? s.micDevice,
      outputDevice: body.outputDevice ?? s.outputDevice,
    });
    return reply.status(201).send(row);
  });

  app.get('/api/interviews/:id', (req) => {
    const { id } = idParam.parse(req.params);
    const session = getSession(db, id);
    const head = db
      .select({ title: jobs.title, company: companies.name, companyId: companies.id })
      .from(applications)
      .innerJoin(jobs, eq(jobs.id, applications.jobId))
      .innerJoin(companies, eq(companies.id, jobs.companyId))
      .where(eq(applications.id, session.applicationId))
      .get();
    if (!head) throw new NotFoundError(`Application ${session.applicationId} not found`);
    const brief = latestResearch(db, head.companyId)?.result as CompanyResearch | undefined;
    const settings = getSettings();
    return {
      ...session,
      company: head.company,
      title: head.title,
      questionsToAsk: brief?.questionsToAsk ?? [],
      live: existingSession(id)?.live ?? false,
      estimates: {
        prepUsd: estimate(db, 'prep', session.coachModel, 0.03),
        debriefUsd: estimate(db, 'debrief', settings.model, 0.06),
        debriefModel: pricingFor(settings.model)?.label ?? settings.model,
      },
    };
  });

  app.put('/api/interviews/:id/asked', (req) => {
    const { id } = idParam.parse(req.params);
    const { questions } = z
      .object({ questions: z.array(z.string().max(1000)).max(50) })
      .parse(req.body);
    const live = existingSession(id);
    if (live) live.asked(questions);
    else {
      getSessionRow(db, id);
      liveSession(deps(), id).asked(questions);
      releaseSession(id);
    }
    return { ok: true };
  });

  app.delete('/api/interviews/:id', (req, reply) => {
    const { id } = idParam.parse(req.params);
    if (existingSession(id)?.busy)
      return reply.status(409).send({ error: 'Stop the call before deleting it.' });
    deleteSession(db, id, root);
    releaseSession(id);
    return reply.status(204).send();
  });

  app.post('/api/interviews/:id/prep', async (req) => {
    const { id } = idParam.parse(req.params);
    return generatePrep(db, id, { provider: opts.provider?.() });
  });

  app.post('/api/interviews/:id/debrief', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    try {
      return await debriefSession(db, id, { provider: opts.provider?.() });
    } catch (e) {
      const f = fail(e);
      if (f) return reply.status(f.status).send({ error: f.error });
      throw e;
    }
  });

  app.get('/api/interview/engine', () => {
    const install = audioEngineInstall();
    const status = opts.audioEngine
      ? opts.audioEngine.status()
      : (created?.status() ?? { phase: 'stopped' as const });
    return { installed: Boolean(opts.audioEngine) || install.installed, status };
  });

  app.get('/api/interview/devices', async (_req, reply) => {
    try {
      return await engine().listDevices();
    } catch (e) {
      const f = fail(e);
      if (f) return reply.status(f.status).send({ error: f.error });
      throw e;
    }
  });

  app.post('/api/interviews/:id/start', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    getSessionRow(db, id);
    try {
      if (activeSessionCount() > 0 && !existingSession(id)?.busy)
        throw new ConflictError('Another call is already being recorded. Stop it first.');
      const s = liveSession(deps(), id);
      await s.start();
      return s.snapshot();
    } catch (e) {
      releaseSession(id);
      const f = fail(e);
      if (f) return reply.status(f.status).send({ error: f.error });
      if (e instanceof Error && /already/.test(e.message))
        return reply.status(409).send({ error: e.message });
      throw e;
    }
  });

  app.post('/api/interviews/:id/stop', async (req) => {
    const { id } = idParam.parse(req.params);
    const s = existingSession(id);
    const res = s ? await s.stop() : { durationMs: 0 };
    return res;
  });

  app.post('/api/interviews/:id/nudge', (req) => {
    const { id } = idParam.parse(req.params);
    existingSession(id)?.nudge();
    return { ok: true };
  });

  /** Live transcript, coach cards and engine status for one call, as Server-Sent Events. */
  app.get('/api/interviews/:id/events', (req, reply) => {
    const { id } = idParam.parse(req.params);
    getSessionRow(db, id);
    let s;
    try {
      s = liveSession(deps(), id);
    } catch (e) {
      const f = fail(e);
      if (f) return reply.status(f.status).send({ error: f.error });
      throw e;
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const unsubscribe = s.subscribe((e: SessionEvent) =>
      res.write(`data: ${JSON.stringify(e)}\n\n`),
    );
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
      releaseSession(id);
    });
  });

  /** The recording, with HTTP Range support so the player can seek. */
  app.get('/api/interviews/:id/audio', (req, reply) => {
    const { id } = idParam.parse(req.params);
    const row = getSessionRow(db, id);
    const name = row.audioFile;
    if (!name || name !== path.basename(name))
      return reply.status(404).send({ error: 'No recording' });
    const file = path.join(sessionDir(id, root), name);
    if (!fs.existsSync(file)) return reply.status(404).send({ error: 'No recording' });
    const size = fs.statSync(file).size;
    const type = name.endsWith('.ogg') ? 'audio/ogg' : 'audio/wav';
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    reply.header('Accept-Ranges', 'bytes').header('Content-Type', type);
    if (!range) return reply.header('Content-Length', size).send(fs.createReadStream(file));
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end) return reply.status(416).header('Content-Range', `bytes */${size}`).send();
    return reply
      .status(206)
      .header('Content-Range', `bytes ${start}-${end}/${size}`)
      .header('Content-Length', end - start + 1)
      .send(fs.createReadStream(file, { start, end }));
  });
}
