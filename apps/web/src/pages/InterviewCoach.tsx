import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { INTERVIEW_ROUNDS, type Debrief, type InterviewRound, type PrepCard } from '@jm/shared';
import { api, type InterviewDetail } from '../api.ts';
import { Button, ErrorText, Field, Select, cx } from '../components/ui.tsx';
import { CoachCard } from '../interview/CoachCard.tsx';
import { TranscriptLines } from '../interview/TranscriptLines.tsx';
import { Playback } from '../interview/Playback.tsx';
import {
  clock,
  currentCard,
  talkShare,
  useLiveSession,
  type LiveState,
} from '../interview/live.ts';
import { usePictureInPicture } from '../interview/usePictureInPicture.ts';

const money = (usd: number) =>
  usd < 1 ? `${Math.max(1, Math.round(usd * 100))}¢` : `$${usd.toFixed(2)}`;

const ROUND_FOR_STATUS: Record<string, InterviewRound> = {
  'Recruiter Screen': 'Recruiter screen',
  'Hiring Manager': 'Hiring manager',
  'Interview Loop': 'Panel / loop',
};

export default function InterviewCoachPage() {
  const { applicationId, sessionId } = useParams();
  const appId = Number(applicationId);
  return sessionId ? (
    <SessionView appId={appId} sessionId={Number(sessionId)} />
  ) : (
    <Setup appId={appId} />
  );
}

function Shell({ children, back }: { children: React.ReactNode; back: string }) {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <div className="mx-auto max-w-6xl px-4 py-4">
        <Link to={back} className="text-sm text-ink-3 hover:text-ink">
          ← Back to the application
        </Link>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

// ---------- before the call: pick the round and devices ----------

function Setup({ appId }: { appId: number }) {
  const navigate = useNavigate();
  const { data: app, error: appError } = useQuery({
    queryKey: ['application', appId],
    queryFn: () => api.getApplication(appId),
  });
  const { data: engine } = useQuery({ queryKey: ['audio-engine'], queryFn: api.audioEngine });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const devices = useQuery({
    queryKey: ['audio-devices'],
    queryFn: api.audioDevices,
    enabled: Boolean(engine?.installed),
    retry: false,
    staleTime: 60_000,
  });
  const [round, setRound] = useState<InterviewRound | null>(null);
  const [mic, setMic] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [record, setRecord] = useState(true);

  const status = app?.application.status;
  const pickedRound =
    round ?? (status ? ROUND_FOR_STATUS[status] : undefined) ?? 'Recruiter screen';
  const pick = (
    list: { name: string; isDefault: boolean }[] | undefined,
    chosen: string | null,
    saved: string | null | undefined,
  ) =>
    chosen ??
    (list?.some((d) => d.name === saved)
      ? saved!
      : (list?.find((d) => d.isDefault)?.name ?? list?.[0]?.name ?? ''));
  const micName = pick(devices.data?.inputs, mic, settings?.micDevice);
  const outName = pick(devices.data?.outputs, output, settings?.outputDevice);

  const create = useMutation({
    mutationFn: () =>
      api.createInterview(appId, {
        round: pickedRound,
        recordAudio: record,
        micDevice: micName || null,
        outputDevice: outName || null,
      }),
    onSuccess: (s) => navigate(`/interview/${appId}/${s.id}`),
  });

  return (
    <Shell back={`/applications/${appId}`}>
      <ErrorText error={appError} />
      {app && (
        <h1 className="text-2xl font-semibold">
          Interview coach · {app.company.name}, {app.job.title}
        </h1>
      )}
      <p className="mt-1 max-w-2xl text-sm text-ink-2">
        Records your microphone and what your PC plays (the other side of Zoom, Teams or Meet, in
        any app), transcribes both live on this PC, and shows one short card after each question.
      </p>

      {engine && !engine.installed && (
        <div className="mt-4 rounded-lg border border-warn/40 bg-warn/10 p-4 text-sm">
          The audio engine is not installed yet. In PowerShell, run once:
          <pre className="mt-2 rounded bg-surface p-2 text-xs">
            scripts\install-audio-engine.ps1
          </pre>
        </div>
      )}

      <div className="mt-5 grid max-w-2xl gap-4">
        <Field label="Which round">
          <Select value={pickedRound} onChange={(e) => setRound(e.target.value as InterviewRound)}>
            {INTERVIEW_ROUNDS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
        </Field>
        {engine?.installed && devices.isLoading && (
          <p className="text-sm text-ink-3">
            Starting the audio engine and loading the speech model…
          </p>
        )}
        <ErrorText error={devices.error} />
        {devices.data && (
          <>
            <Field label="Your microphone">
              <Select value={micName} onChange={(e) => setMic(e.target.value)}>
                {devices.data.inputs.map((d) => (
                  <option key={d.index} value={d.name}>
                    {d.name}
                    {d.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Where you hear the call (speakers or headphones)">
              <Select value={outName} onChange={(e) => setOutput(e.target.value)}>
                {devices.data.outputs.map((d) => (
                  <option key={d.index} value={d.name}>
                    {d.name.replace(/ \[Loopback\]$/, '')}
                    {d.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} />
          Keep the audio, so you can play the call back later (about 25 MB an hour)
        </label>
        <ul className="list-disc space-y-1 pl-5 text-xs text-ink-3">
          <li>Use headphones: with speakers, your mic hears them too.</li>
          <li>Everything your PC plays is captured, so mute notifications and music.</li>
          <li>Some places need everyone's consent to record a call. Say you're keeping notes.</li>
        </ul>
        <div>
          <Button
            variant="primary"
            disabled={!engine?.installed || !devices.data || create.isPending}
            onClick={() => create.mutate()}
          >
            Get ready
          </Button>
          <ErrorText error={create.error} />
        </div>
      </div>
    </Shell>
  );
}

// ---------- one session: ready, live, or over ----------

function SessionView({ appId, sessionId }: { appId: number; sessionId: number }) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ['interview', sessionId],
    queryFn: () => api.getInterview(sessionId),
  });
  const live = useLiveSession(sessionId);
  const refresh = () => qc.invalidateQueries({ queryKey: ['interview', sessionId] });

  // Pick up the saved transcript, hints and recording once the call ends.
  useEffect(() => {
    if (live.ended) void refresh();
  }, [live.ended, live.audioFile]); // eslint-disable-line react-hooks/exhaustive-deps

  if (detail.error)
    return (
      <Shell back={`/applications/${appId}`}>
        <ErrorText error={detail.error} />
      </Shell>
    );
  const d = detail.data;
  if (!d)
    return (
      <Shell back={`/applications/${appId}`}>
        <p className="text-ink-3">Loading…</p>
      </Shell>
    );

  if (live.live) return <LiveView d={d} live={live} />;
  if (d.endedAt || live.ended)
    return <EndedView d={d} live={live} appId={appId} onChanged={refresh} />;
  return <ReadyView d={d} live={live} appId={appId} onChanged={refresh} />;
}

function Header({ d }: { d: InterviewDetail }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3">
      <h1 className="text-xl font-semibold">{d.company}</h1>
      <span className="text-ink-2">{d.title}</span>
      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-2">
        {d.round}
      </span>
    </div>
  );
}

function PrepSection({ d, onChanged }: { d: InterviewDetail; onChanged: () => void }) {
  const prep = useMutation({ mutationFn: () => api.interviewPrep(d.id), onSuccess: onChanged });
  if (!d.prep)
    return (
      <div>
        <Button onClick={() => prep.mutate()} disabled={prep.isPending}>
          {prep.isPending
            ? 'Writing the prep card…'
            : `Write a prep card (~${money(d.estimates.prepUsd)})`}
        </Button>
        <p className="mt-1 text-xs text-ink-3">
          Likely questions, the stories to have ready and what to ask, from your profile and the
          company research. The coach uses it during the call.
        </p>
        <ErrorText error={prep.error} />
      </div>
    );
  return <PrepView prep={d.prep} />;
}

function PrepView({ prep }: { prep: PrepCard }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-base font-medium">{prep.headline}</p>
      <Section title="Lead with" items={prep.leadWith} />
      {!!prep.likelyQuestions.length && (
        <div>
          <p className="mb-1 text-xs font-medium text-ink-3">Likely questions</p>
          <ul className="space-y-1">
            {prep.likelyQuestions.map((q, i) => (
              <li key={i}>
                <span className="font-medium">{q.question}</span>{' '}
                <span className="text-ink-2">→ {q.approach}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!prep.stories.length && (
        <div>
          <p className="mb-1 text-xs font-medium text-ink-3">Stories to have ready</p>
          <ul className="space-y-1">
            {prep.stories.map((s, i) => (
              <li key={i}>
                <span className="font-medium">{s.name}</span>{' '}
                <span className="text-ink-2">· {s.use}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Section title="Watch for" items={prep.risks} tone="warn" />
      <Section title="Logistics" items={prep.logistics} />
    </div>
  );
}

function Section({ title, items, tone }: { title: string; items: string[]; tone?: 'warn' }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-ink-3">{title}</p>
      <ul className={cx('list-disc space-y-0.5 pl-5', tone === 'warn' && 'text-warn')}>
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

function EngineLine({ live }: { live: LiveState }) {
  const p = live.engine.phase;
  const text =
    p === 'ready'
      ? `Speech model ready${live.engine.device === 'cpu' ? ' (on the CPU: slow)' : ''}.`
      : p === 'downloading'
        ? 'Downloading the speech model (about 1.6 GB, once)…'
        : p === 'loading' || p === 'starting'
          ? 'Loading the speech model…'
          : p === 'error'
            ? `Speech engine problem: ${live.engine.detail ?? 'unknown'}`
            : 'The speech engine starts when you press Start.';
  return <p className={cx('text-xs', p === 'error' ? 'text-bad' : 'text-ink-3')}>{text}</p>;
}

function ReadyView({
  d,
  live,
  appId,
  onChanged,
}: {
  d: InterviewDetail;
  live: LiveState;
  appId: number;
  onChanged: () => void;
}) {
  const start = useMutation({ mutationFn: () => api.startInterview(d.id), onSuccess: onChanged });
  const questions = useMemo(
    () => [...new Set([...(d.prep?.askThem ?? []), ...d.questionsToAsk])],
    [d.prep, d.questionsToAsk],
  );
  return (
    <Shell back={`/applications/${appId}`}>
      <Header d={d} />
      <div className="mt-4 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <PrepSection d={d} onChanged={onChanged} />
          {!!questions.length && (
            <div className="text-sm">
              <p className="mb-1 text-xs font-medium text-ink-3">
                Questions to ask (tick them off during the call)
              </p>
              <ul className="list-disc space-y-0.5 pl-5">
                {questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
          <Button
            variant="primary"
            className="w-full py-3 text-base"
            disabled={start.isPending}
            onClick={() => start.mutate()}
          >
            {start.isPending
              ? 'Starting…'
              : d.recordAudio
                ? '● Start recording'
                : 'Start (transcript only)'}
          </Button>
          <EngineLine live={live} />
          <ErrorText error={start.error} />
          <dl className="space-y-1 text-xs text-ink-2">
            <div>
              <dt className="inline text-ink-3">Mic: </dt>
              <dd className="inline">{d.micDevice ?? 'system default'}</dd>
            </div>
            <div>
              <dt className="inline text-ink-3">Call audio from: </dt>
              <dd className="inline">
                {d.outputDevice?.replace(/ \[Loopback\]$/, '') ?? 'system default'}
              </dd>
            </div>
          </dl>
          <p className="text-xs text-ink-3">
            Coach: {d.coachModel}. Tip: press Pop out once the call starts to float the card over
            Zoom.
          </p>
        </div>
      </div>
    </Shell>
  );
}

// ---------- during the call ----------

function useElapsed(startedAt: string | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return startedAt ? now - new Date(startedAt).getTime() : 0;
}

function Meter({ value }: { value: number }) {
  const pct = Math.min(100, Math.round(Math.sqrt(value) * 220));
  return (
    <span className="inline-block h-1.5 w-8 overflow-hidden rounded-full bg-surface-2 align-middle">
      <span className="block h-full bg-good transition-[width]" style={{ width: `${pct}%` }} />
    </span>
  );
}

function LiveView({ d, live }: { d: InterviewDetail; live: LiveState }) {
  const elapsed = useElapsed(live.startedAt);
  const [asked, setAsked] = useState<string[]>(d.askedQuestions);
  const nudge = useCallback(() => void api.nudgeInterview(d.id), [d.id]);
  const stop = useMutation({ mutationFn: () => api.stopInterview(d.id) });
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (e.key !== ' ' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
      e.preventDefault();
      nudge();
    },
    [nudge],
  );
  const pip = usePictureInPicture(onKey);
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  const { card, writing } = currentCard(live);
  const share = talkShare(live.turns);
  const talkWarn = d.round === 'Recruiter screen' ? share.mePct > 60 : share.mePct > 70;
  const questions = [...new Set([...(d.prep?.askThem ?? []), ...d.questionsToAsk])];
  const toggleAsked = (q: string) => {
    const next = asked.includes(q) ? asked.filter((x) => x !== q) : [...asked, q];
    setAsked(next);
    void api.setAsked(d.id, next);
  };
  return (
    <div className="flex min-h-screen flex-col bg-bg text-ink">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface px-4 py-2 text-sm">
        <span className="font-semibold">{d.company}</span>
        <span className="text-ink-2">{d.round}</span>
        <span className="flex items-center gap-1.5 font-medium text-bad">
          <span className="size-2 animate-pulse rounded-full bg-bad" />
          {d.recordAudio ? 'REC' : 'LIVE'}{' '}
          <span className="tabular-nums text-ink">{clock(elapsed)}</span>
        </span>
        <span className="flex items-center gap-1 text-xs text-ink-3">
          You <Meter value={live.level.me} /> Them <Meter value={live.level.them} />
        </span>
        <span className={cx('text-xs', talkWarn ? 'font-medium text-warn' : 'text-ink-3')}>
          You {share.mePct}% · Them {100 - share.mePct}%
        </span>
        <div className="ml-auto flex items-center gap-2">
          {pip.supported && !pip.win && <Button onClick={() => void pip.open()}>Pop out</Button>}
          <Button onClick={nudge}>
            Nudge <kbd className="text-xs text-ink-3">Space</kbd>
          </Button>
          <Button
            variant="danger"
            disabled={stop.isPending}
            onClick={() => confirm('End the call and stop recording?') && stop.mutate()}
          >
            {stop.isPending ? 'Stopping…' : 'Stop'}
          </Button>
        </div>
      </header>
      {(!!live.errors.length || pip.error) && (
        <div className="bg-bad/10 px-4 py-1.5 text-sm text-bad">
          {pip.error ?? live.errors.at(-1)}
        </div>
      )}
      {!live.connected && (
        <div className="bg-warn/10 px-4 py-1.5 text-sm text-warn">Reconnecting…</div>
      )}

      <main className="grid flex-1 gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="min-w-0">
          {pip.win ? (
            <p className="text-lg text-ink-3">
              The coach card is popped out.{' '}
              <button className="text-accent hover:underline" onClick={pip.close}>
                Bring it back
              </button>
            </p>
          ) : (
            <CoachCard card={card} writing={writing} />
          )}
          {!!live.earlier.length && !pip.win && (
            <div className="mt-8 space-y-1 border-t border-border pt-3 text-sm text-ink-3">
              {live.earlier.slice(0, 3).map((h, i) => (
                <p key={i} className="truncate">
                  {h.question ?? h.probing}
                </p>
              ))}
            </div>
          )}
        </section>
        <aside>
          <TranscriptLines live={live} limit={8} />
        </aside>
      </main>

      {!!questions.length && (
        <footer className="flex flex-wrap gap-2 border-t border-border bg-surface px-4 py-2">
          <span className="self-center text-xs text-ink-3">Ask:</span>
          {questions.map((q) => (
            <button
              key={q}
              onClick={() => toggleAsked(q)}
              className={cx(
                'max-w-md truncate rounded-full border px-3 py-1 text-xs',
                asked.includes(q)
                  ? 'border-border text-ink-3 line-through'
                  : 'border-accent/40 text-ink',
              )}
              title={q}
            >
              {q}
            </button>
          ))}
        </footer>
      )}

      {pip.win &&
        createPortal(
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs text-ink-3">
              <span className="size-2 animate-pulse rounded-full bg-bad" />
              <span className="tabular-nums">{clock(elapsed)}</span>
              <span className={talkWarn ? 'text-warn' : ''}>You {share.mePct}%</span>
              <button
                className="ml-auto rounded border border-border px-2 py-0.5 text-ink-2"
                onClick={nudge}
              >
                Nudge
              </button>
            </div>
            <CoachCard card={card} writing={writing} compact />
            <div className="border-t border-border pt-2">
              <TranscriptLines live={live} limit={3} compact />
            </div>
          </div>,
          pip.win.document.body,
        )}
    </div>
  );
}

// ---------- after the call ----------

function EndedView({
  d,
  live,
  appId,
  onChanged,
}: {
  d: InterviewDetail;
  live: LiveState;
  appId: number;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const debrief = useMutation({
    mutationFn: () => api.interviewDebrief(d.id),
    onSuccess: () => {
      onChanged();
      void qc.invalidateQueries({ queryKey: ['application', appId] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteInterview(d.id),
    onSuccess: () => navigate(`/applications/${appId}`),
  });
  const preparing = live.audioPending || (d.recordAudio && !d.audioFile && !live.audioFile);
  return (
    <Shell back={`/applications/${appId}`}>
      <div className="flex flex-wrap items-center gap-3">
        <Header d={d} />
        <span className="text-sm text-ink-3">
          {(d.startedAt ?? d.createdAt).slice(0, 10)}
          {d.audioMs ? ` · ${clock(d.audioMs)}` : ''}
        </span>
        <Button
          variant="danger"
          className="ml-auto"
          onClick={() =>
            confirm('Delete this call, its transcript and its recording?') && remove.mutate()
          }
        >
          Delete call
        </Button>
      </div>

      <div className="mt-4 rounded-lg border border-border bg-surface p-4">
        {d.summary ? (
          <DebriefView debrief={d.summary} />
        ) : (
          <div>
            <Button
              variant="primary"
              disabled={debrief.isPending || !d.segments.length}
              onClick={() => debrief.mutate()}
            >
              {debrief.isPending
                ? 'Writing the debrief…'
                : `Write the debrief with ${d.estimates.debriefModel} (~${money(d.estimates.debriefUsd)})`}
            </Button>
            <p className="mt-1 text-xs text-ink-3">
              How each answer landed, what they told you, what you promised, and points for the
              thank-you email. It is added to the application's activity log.
            </p>
            <ErrorText error={debrief.error} />
          </div>
        )}
      </div>

      <div className="mt-4">
        {preparing ? <p className="mb-3 text-sm text-ink-3">Preparing the recording…</p> : null}
        <Playback
          sessionId={d.id}
          audioFile={preparing ? null : (d.audioFile ?? live.audioFile)}
          turns={d.segments.map((s) => ({ ...s, speaker: s.speaker as 'me' | 'them' }))}
          hints={d.hints}
        />
      </div>
      {d.prep && (
        <details className="mt-4 rounded-lg border border-border bg-surface p-4">
          <summary className="cursor-pointer text-sm font-medium">Prep card</summary>
          <div className="mt-3">
            <PrepView prep={d.prep} />
          </div>
        </details>
      )}
    </Shell>
  );
}

const LANDED: Record<Debrief['questions'][number]['landed'], string> = {
  strong: 'text-good',
  ok: 'text-ink-2',
  weak: 'text-warn',
  unclear: 'text-ink-3',
};

function DebriefView({ debrief }: { debrief: Debrief }) {
  return (
    <div className="space-y-4 text-sm">
      <p className="text-base">{debrief.summary}</p>
      {debrief.nextRound && (
        <p>
          <span className="text-ink-3">Next: </span>
          {debrief.nextRound}
        </p>
      )}
      {!!debrief.questions.length && (
        <div>
          <p className="mb-1 text-xs font-medium text-ink-3">Questions</p>
          <ul className="space-y-2">
            {debrief.questions.map((q, i) => (
              <li key={i}>
                <p className="font-medium">
                  {q.question}{' '}
                  <span className={cx('text-xs font-semibold uppercase', LANDED[q.landed])}>
                    {q.landed}
                  </span>
                </p>
                <p className="text-ink-2">{q.yourAnswer}</p>
                {q.better && <p className="text-accent">Better: {q.better}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-3">
        <Section title="They shared" items={debrief.theyShared} />
        <Section title="Follow-ups" items={debrief.followUps} tone="warn" />
        <Section title="Thank-you email" items={debrief.thankYouPoints} />
      </div>
    </div>
  );
}
