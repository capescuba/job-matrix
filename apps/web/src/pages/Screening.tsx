import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type ApplicationRow } from '../api.ts';
import { useAiRuns } from '../aiActivity.ts';
import { FitBadge, FlagChips, jobFlags } from '../components/badges.tsx';
import { LiveRun } from '../components/LiveRun.tsx';
import { Button, ErrorText, Input, cx } from '../components/ui.tsx';

/**
 * The Screening inbox: jobs captured (by the extension or "Screen a URL") waiting for a decision.
 * Capturing is free; scoring costs an AI call, so it only happens when you press Score.
 */
export default function ScreeningPage() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'passed' ? 'passed' : 'inbox';
  const focus = Number(params.get('focus')) || null;
  const {
    data = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['applications'],
    queryFn: api.listApplications,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['applications'] });
    qc.invalidateQueries({ queryKey: ['stats'] });
  };

  const inbox = data
    .filter((r) => r.status === 'Screening')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const passed = data
    .filter((r) => r.status === 'Passed')
    .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));
  const rows = tab === 'inbox' ? inbox : passed;
  const unscored = inbox.filter((r) => r.hasDescription && r.fitScore == null);

  const scoreAll = useMutation({
    mutationFn: () => api.startScoreAll('Screening'),
    onSuccess: (s) => qc.setQueryData(['fitBatch'], s),
  });
  const { data: batch } = useQuery({
    queryKey: ['fitBatch'],
    queryFn: api.scoreAllStatus,
    refetchInterval: (q) => (q.state.data?.running ? 1500 : false),
  });
  useEffect(() => {
    if (batch) refresh();
  }, [batch?.done, batch?.running]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold">Screening</h1>
        <div className="flex rounded-md border border-border p-0.5">
          {(
            [
              ['inbox', `Inbox (${inbox.length})`],
              ['passed', `Passed (${passed.length})`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setParams(key === 'passed' ? { tab: 'passed' } : {})}
              className={cx(
                'rounded px-2.5 py-1 text-sm',
                tab === key ? 'bg-surface-2 font-medium' : 'text-ink-2',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === 'inbox' &&
          (batch?.running ? (
            <Button disabled>
              Scoring {batch.done}/{batch.total}…
            </Button>
          ) : (
            unscored.length > 0 && (
              <Button
                onClick={async () => {
                  const u = await qc.fetchQuery({ queryKey: ['usage'], queryFn: api.usage });
                  const each = u.forecast.perCallUsd;
                  const cost =
                    each != null ? ` for about $${(each * unscored.length).toFixed(2)}` : '';
                  if (
                    confirm(
                      `Score ${unscored.length} inbox jobs with ${u.forecast.modelLabel}${cost}?`,
                    )
                  )
                    scoreAll.mutate();
                }}
              >
                Score {unscored.length} unscored
              </Button>
            )
          ))}
      </div>

      <ScreenUrl onAdded={(id) => setParams({ focus: String(id) })} />
      <ErrorText error={error ?? scoreAll.error} />

      {isLoading ? (
        <p className="text-ink-2">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-ink-2">
          {tab === 'inbox'
            ? 'Nothing to screen. Capture a job with the Chrome extension, or paste a link above.'
            : 'No passed jobs.'}
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <ScreeningCard key={r.id} row={r} focused={r.id === focus} onChanged={refresh} />
          ))}
        </div>
      )}
    </div>
  );
}

function ScreenUrl({ onAdded }: { onAdded: (applicationId: number) => void }) {
  const [url, setUrl] = useState('');
  const qc = useQueryClient();
  const add = useMutation({
    mutationFn: () => api.screenUrl(url.trim()),
    onSuccess: (r) => {
      setUrl('');
      qc.invalidateQueries({ queryKey: ['applications'] });
      onAdded(r.applicationId);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim()) add.mutate();
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <Input
        type="url"
        className="min-w-72 flex-1"
        placeholder="Screen a URL — paste a job link"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <Button type="submit" disabled={!url.trim() || add.isPending}>
        {add.isPending ? 'Adding…' : 'Add to inbox'}
      </Button>
      {add.data?.existing && (
        <span className="w-full text-sm text-warn">
          Already tracked: {add.data.company} — {add.data.title} ({add.data.status}).{' '}
          <Link
            to={`/applications/${add.data.applicationId}`}
            className="text-accent hover:underline"
          >
            Open
          </Link>
        </span>
      )}
      <ErrorText error={add.error} />
    </form>
  );
}

function ScreeningCard({
  row: r,
  focused,
  onChanged,
}: {
  row: ApplicationRow;
  focused: boolean;
  onChanged: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState(focused);
  const [expanded, setExpanded] = useState(false);
  const [passing, setPassing] = useState(false);
  const [reason, setReason] = useState('');
  const [mountedAt] = useState(Date.now);
  const run = useAiRuns().find(
    (x) => x.applicationId === r.id && (!x.finishedAt || x.startedAt >= mountedAt - 1000),
  );

  useEffect(() => {
    if (!focused) return;
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlight(true);
    const t = setTimeout(() => setHighlight(false), 3000);
    return () => clearTimeout(t);
  }, [focused]);

  const score = useMutation({
    mutationFn: () => api.scoreFit(r.id, r.fitScore != null),
    onSettled: onChanged,
  });
  const move = useMutation({
    mutationFn: (status: 'Saved' | 'Applied' | 'Screening') =>
      api.updateApplication(r.id, { status }),
    onSuccess: onChanged,
  });
  const pass = useMutation({
    mutationFn: () =>
      api.addActivity(r.id, {
        at: new Date().toLocaleDateString('en-CA'),
        kind: 'Note',
        summary: reason.trim() ? `Passed: ${reason.trim()}` : 'Passed at screening',
        setStatus: 'Passed',
      }),
    onSuccess: onChanged,
  });
  const scoring = score.isPending || (run && !run.finishedAt);

  return (
    <div
      ref={ref}
      className={cx(
        'rounded-lg border bg-surface p-4 transition-shadow',
        highlight ? 'border-accent ring-2 ring-accent/40' : 'border-border',
      )}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <InlineEdit
              value={r.title}
              unknown={r.title === 'Unknown role'}
              className="font-semibold"
              onSave={(v) => api.updateJob(r.jobId, { title: v }).then(onChanged)}
            />
            <span className="text-ink-3">·</span>
            <InlineEdit
              value={r.company}
              unknown={r.company === 'Unknown'}
              className="text-ink-2"
              onSave={(v) => api.updateJob(r.jobId, { companyName: v }).then(onChanged)}
            />
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-3">
            {r.location && <span>{r.location}</span>}
            {r.remoteType && <span>{r.remoteType}</span>}
            {r.applicantCount != null && <span>{r.applicantCount}+ applicants</span>}
            {r.source && <span>via {r.source}</span>}
            <span>captured {new Date(r.createdAt).toLocaleDateString()}</span>
            {r.url && (
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                Open posting ↗
              </a>
            )}
            <Link to={`/applications/${r.id}`} className="text-accent hover:underline">
              Details
            </Link>
          </div>
          <div className="mt-1">
            <FlagChips flags={jobFlags(r)} />
          </div>
        </div>
        <div className="text-right">
          {r.fitScore != null ? (
            <FitBadge
              score={r.fitScore}
              verdict={r.fitVerdict}
              gate={r.fitGate}
              reasons={r.fitGateReasons}
            />
          ) : (
            <span className="text-xs text-ink-3">Not scored</span>
          )}
        </div>
      </div>

      {r.fitSummary && !scoring && (
        <div className="mt-3 space-y-1 text-sm">
          <p>{r.fitSummary}</p>
          {r.fitWhyNotHigher && (
            <p className="text-ink-2">
              <span className="font-medium text-ink">Why not higher:</span> {r.fitWhyNotHigher}
            </p>
          )}
        </div>
      )}
      {run && <div className="mt-3">{<LiveRun run={run} />}</div>}

      <div className="mt-3 text-sm">
        {r.descriptionPreview ? (
          <>
            <div className="text-xs text-ink-3">
              Description from: {r.descriptionSource ?? 'unknown'}
            </div>
            <p className={cx('mt-1 whitespace-pre-wrap text-ink-2', !expanded && 'line-clamp-3')}>
              {r.descriptionPreview}
              {expanded && r.descriptionPreview.length >= 600 && '…'}
            </p>
            <button
              className="text-xs text-accent hover:underline"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Less' : 'More'}
            </button>
          </>
        ) : (
          <p className="text-warn">
            No description captured.{' '}
            <Link to={`/applications/${r.id}`} className="underline">
              Paste it on the details page
            </Link>{' '}
            to enable scoring.
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {r.status === 'Screening' ? (
          <>
            <Button
              variant={r.fitScore == null ? 'primary' : 'secondary'}
              disabled={!r.hasDescription || !!scoring}
              onClick={() => score.mutate()}
              title={
                r.hasDescription
                  ? 'Run the AI fit score (one paid call)'
                  : 'Needs a description first'
              }
            >
              {scoring ? 'Scoring…' : r.fitScore == null ? 'Score' : 'Re-score'}
            </Button>
            <span className="mx-1 h-5 w-px bg-border" />
            <Button onClick={() => move.mutate('Saved')} disabled={move.isPending}>
              Add to pipeline
            </Button>
            <Button onClick={() => move.mutate('Applied')} disabled={move.isPending}>
              Applied
            </Button>
            {passing ? (
              <form
                className="flex items-center gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  pass.mutate();
                }}
              >
                <Input
                  autoFocus
                  className="w-56"
                  placeholder="Reason (optional)"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <Button type="submit" variant="danger" disabled={pass.isPending}>
                  Pass
                </Button>
                <Button type="button" variant="ghost" onClick={() => setPassing(false)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <Button variant="danger" onClick={() => setPassing(true)}>
                Pass
              </Button>
            )}
          </>
        ) : (
          <Button onClick={() => move.mutate('Screening')} disabled={move.isPending}>
            Move back to inbox
          </Button>
        )}
        <ErrorText error={score.error ?? move.error ?? pass.error} />
      </div>
    </div>
  );
}

/** Click to edit; highlighted when the capture couldn't work the value out. */
function InlineEdit({
  value,
  unknown,
  className,
  onSave,
}: {
  value: string;
  unknown: boolean;
  className?: string;
  onSave: (v: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  if (editing)
    return (
      <form
        className="inline-flex"
        onSubmit={(e) => {
          e.preventDefault();
          if (v.trim() && v.trim() !== value) void onSave(v.trim()).then(() => setEditing(false));
          else setEditing(false);
        }}
      >
        <Input
          autoFocus
          className="w-56 py-0.5"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onBlur={() => setEditing(false)}
        />
      </form>
    );
  return (
    <button
      className={cx(
        className,
        'text-left hover:underline',
        unknown && 'rounded border border-dashed border-warn/60 px-1 text-warn',
      )}
      title={unknown ? 'Not found on the page — click to fill in' : 'Click to edit'}
      onClick={() => {
        setV(unknown ? '' : value);
        setEditing(true);
      }}
    >
      {value}
    </button>
  );
}
