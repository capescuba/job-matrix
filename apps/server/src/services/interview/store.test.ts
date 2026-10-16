import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../db/client.ts';
import { createApplication } from '../applications.ts';
import {
  appendSegment,
  createSession,
  deleteSession,
  endSession,
  getSession,
  listSessions,
  saveHint,
  setAsked,
  startSession,
  unfinishedSessions,
} from './store.ts';

let db: Db;
let applicationId: number;
let root: string;

beforeEach(() => {
  db = openDb(':memory:');
  applicationId = createApplication(db, { company: 'Acme', title: 'TPM' });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-interviews-'));
});

const hint = {
  question: 'Tell me about a hard launch',
  probing: 'Ownership under pressure',
  points: ['Led the cutover', 'Cut downtime to 4 minutes'],
  story: 'Workday: migration',
  watch: null,
  askBack: null,
};

describe('interview sessions', () => {
  it('creates, starts and ends a session, keeping segments and hints in order', () => {
    const s = createSession(db, applicationId, {
      round: 'Recruiter screen',
      coachModel: 'claude-sonnet-5-5',
    });
    expect(s).toMatchObject({ round: 'Recruiter screen', recordAudio: true, startedAt: null });
    startSession(db, s.id, {
      transcriber: 'whisper-local',
      micDevice: 'Mic',
      outputDevice: 'Speakers',
    });
    expect(unfinishedSessions(db).map((r) => r.id)).toEqual([s.id]);

    const b = appendSegment(db, s.id, {
      speaker: 'them',
      text: 'Tell me about a hard launch',
      startMs: 5000,
      endMs: 8000,
    });
    appendSegment(db, s.id, {
      speaker: 'me',
      text: 'Hi, thanks for having me',
      startMs: 1000,
      endMs: 2500,
    });
    saveHint(db, s.id, { segmentId: b, trigger: 'utterance', hint, usageId: null, atMs: 8200 });
    setAsked(db, s.id, ['What does success look like?']);
    endSession(db, s.id, 61_000);

    const full = getSession(db, s.id);
    expect(full.segments.map((x) => x.speaker)).toEqual(['me', 'them']);
    expect(full.hints[0]).toMatchObject({
      segmentId: b,
      hint: { probing: 'Ownership under pressure' },
    });
    expect(full.askedQuestions).toEqual(['What does success look like?']);
    expect(full.audioMs).toBe(61_000);
    expect(unfinishedSessions(db)).toEqual([]);
  });

  it('lists sessions for an application with segment counts and recording size', () => {
    const s = createSession(db, applicationId, {
      round: 'Technical',
      coachModel: 'claude-sonnet-5-5',
    });
    appendSegment(db, s.id, { speaker: 'them', text: 'hello there', startMs: 0, endMs: 900 });
    fs.mkdirSync(path.join(root, String(s.id)), { recursive: true });
    fs.writeFileSync(path.join(root, String(s.id), 'call.ogg'), Buffer.alloc(1234));
    const [row] = listSessions(db, applicationId, root);
    expect(row).toMatchObject({ id: s.id, segments: 1, audioBytes: 1234 });
  });

  it('deleting a session removes its rows and its folder', () => {
    const s = createSession(db, applicationId, { round: 'Other', coachModel: 'claude-sonnet-5-5' });
    appendSegment(db, s.id, { speaker: 'me', text: 'x', startMs: 0, endMs: 1 });
    const dir = path.join(root, String(s.id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'me.wav'), 'x');
    deleteSession(db, s.id, root);
    expect(fs.existsSync(dir)).toBe(false);
    expect(() => getSession(db, s.id)).toThrow(/not found/);
  });

  it('refuses a session for an application that does not exist', () => {
    expect(() => createSession(db, 9999, { round: 'Other', coachModel: 'm' })).toThrow(/not found/);
  });
});
