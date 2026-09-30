import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { GateReason } from '@jm/shared';
import { api, type ApplicationRow } from '../api.ts';
import { useAiRuns } from '../aiActivity.ts';
import { formatScore, postedOf } from './badges.tsx';
import { CompanyInsights } from './CompanyInsights.tsx';
import { DecisionBody, Verdict, useDecisionData } from './Decision.tsx';
import { LiveRun } from './LiveRun.tsx';
import { Button, ErrorText, Input, cx } from './ui.tsx';

export interface Costs {
  fit: number | null;
  research: number;
}

/**
 * One job in the Screening inbox, as a single line: title, verdict and score, and the two
 * decisions you make most (add to pipeline, pass). Opening a scored job shows the decision card
 * (five tiles, short works-for-you / watch-out lists, fit bars) and the rarer actions.
 */
export function ScreeningCard({
  row: r,
  focused,
  expanded,
  costs,
  onChanged,
}: {
  row: ApplicationRow;
  focused: boolean;
  /** "Expand all" on the page. */
  expanded: boolean;
  costs: Costs;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState(focused);
  const [open, setOpen] = useState(false);
  const [mountedAt] = useState(Date.now);
  const runs = useAiRuns().filter(
    (x) =>
      x.applicationId === r.id &&
      x.companyId == null &&
      (!x.finishedAt || x.startedAt >= mountedAt - 1000),
  );
  const researchRuns = useAiRuns().filter(
    (x) => x.companyId === r.companyId && (!x.finishedAt || x.startedAt >= mountedAt - 1000),
  );

  useEffect(() => {
    if (!focused) return;
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlight(true);
    const t = setTimeout(() => setHighlight(false), 3000);
    return () => clearTimeout(t);
  }, [focused]);

  const score = useMutation({
    mutationFn: () => api.analyze(r.id, r.fitScore != null),
    onSettled: () => {
      onChanged();
      qc.invalidateQueries({ queryKey: ['application', r.id] });
      qc.invalidateQueries({ queryKey: ['research', r.companyId] });
      qc.invalidateQueries({ queryKey: ['usage'] });
    },
  });
  const scoring =
    score.isPending || runs.some((x) => !x.finishedAt) || researchRuns.some((x) => !x.finishedAt);
  const cost = (costs.fit ?? 0) + (r.researchAt ? 0 : costs.research);
  const scoreLabel = `${r.fitScore == null ? 'Score' : 'Re-score'}${costs.fit != null ? ` · ~${cost < 1 ? `${Math.round(cost * 100)}¢` : `$${cost.toFixed(2)}`}` : ''}`;
  const scoreButton = (
    <Button
      variant={r.fitScore == null ? 'primary' : 'ghost'}
      disabled={!r.hasDescription || scoring}
      onClick={() => score.mutate()}
      title={
        !r.hasDescription
          ? 'Needs a job description first'
          : r.researchAt
            ? 'Fit score for this job; the company brief already exists and is reused'
            : 'Fit score + a company brief (web research, made once per company)'
      }
    >
      {scoring ? 'Scoring…' : scoreLabel}
    </Button>
  );

  const live = (runs.length > 0 || researchRuns.length > 0) && (
    <div className="grid gap-2 lg:grid-cols-2">
      {[...runs, ...researchRuns].map((x) => (
        <LiveRun key={x.id} run={x} showLabel />
      ))}
    </div>
  );
  const errors = (score.data?.fitError || score.data?.researchError) && (
    <p className="text-sm text-warn">
      {score.data.fitError && `Fit score failed: ${score.data.fitError}. `}
      {score.data.researchError && `Company research failed: ${score.data.researchError}`}
    </p>
  );

  const frame = cx(
    'rounded-lg border bg-surface transition-shadow',
    highlight ? 'border-accent ring-2 ring-accent/40' : 'border-border',
  );

  // ---- Unscored: one line ----
  if (r.fitScore == null) {
    return (
      <div ref={ref} className={cx(frame, 'px-4 py-2.5')}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <div className="min-w-0 flex-1">
            <Title row={r} onChanged={onChanged} />
            <span className="text-ink-3"> · </span>
            <span className="text-ink-2">{metaLine(r).join(' · ')}</span>
            <WatchlistChips row={r} />
            <span className="ml-2 inline-flex gap-x-2 text-xs">
              <JobLinks row={r} />
            </span>
          </div>
          {!r.hasDescription && <span className="text-xs text-warn">No description captured</span>}
          <PrescreenButton row={r} onChanged={onChanged} />
          {scoreButton}
          <Button variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? 'Less' : 'More'}
          </Button>
        </div>
        {live && <div className="mt-2">{live}</div>}
        {errors}
        {open && (
          <div className="mt-2 space-y-2 border-t border-border pt-2">
            <Description row={r} />
            <Actions row={r} onChanged={onChanged} />
          </div>
        )}
      </div>
    );
  }

  // ---- Scored: one line that opens into the decision card ----
  return (
    <div ref={ref} className={cx(frame, 'px-4 py-2.5')}>
      <Scored
        row={r}
        expanded={expanded}
        onChanged={onChanged}
        live={live}
        errors={errors}
        scoreButton={scoreButton}
      />
    </div>
  );
}

/**
 * Where the watchlist found this job, and the pre-screen's answer (its rough 0–10 match, with
 * the reason on hover). Jobs you added yourself show nothing.
 */
export function WatchlistChips({ row: r }: { row: ApplicationRow }) {
  if (!r.foundBy && !r.prescreenVerdict) return null;
  return (
    <span className="ml-2 inline-flex flex-wrap items-center gap-1 align-middle text-xs">
      {r.foundBy && (
        <span
          className="rounded bg-accent/10 px-1.5 py-0.5 text-accent"
          title="Found by the watchlist"
        >
          Watchlist · {r.foundBy}
        </span>
      )}
      {r.prescreenVerdict && (
        <span
          className={cx(
            'rounded px-1.5 py-0.5',
            r.prescreenVerdict === 'yes'
              ? 'bg-good/10 text-good'
              : r.prescreenVerdict === 'no'
                ? 'bg-bad/10 text-bad'
                : 'bg-warn/10 text-warn',
          )}
          title={`Pre-screen by ${r.prescreenModel}: ${r.prescreenReason ?? ''}`}
        >
          Pre-screen {r.prescreenScore != null ? `${r.prescreenScore}/10 · ` : ''}
          {r.prescreenVerdict}
        </span>
      )}
    </span>
  );
}

/** The free pre-screen, offered before a paid score when a pre-screen model is set up. */
function PrescreenButton({ row: r, onChanged }: { row: ApplicationRow; onChanged: () => void }) {
  const { data: status } = useQuery({ queryKey: ['crawl-status'], queryFn: api.crawlStatus });
  const run = useMutation({
    mutationFn: () => api.prescreenApplication(r.id),
    onSettled: onChanged,
  });
  if (!status?.prescreen) return null;
  return (
    <>
      <Button
        variant={r.prescreenVerdict ? 'ghost' : 'secondary'}
        disabled={run.isPending}
        onClick={() => run.mutate()}
        title={`A quick yes / maybe / no and 0–10 from ${status.prescreen.model}, before you pay for a fit score`}
      >
        {run.isPending
          ? 'Pre-screening…'
          : r.prescreenVerdict
            ? 'Pre-screen again'
            : 'Pre-screen · free'}
      </Button>
      <ErrorText error={run.error} />
    </>
  );
}

function metaLine(r: ApplicationRow): string[] {
  const posted = postedOf(r);
  return [
    r.location,
    r.remoteType,
    posted?.label.replace(/^Posted /, 'posted '),
    r.source && `via ${r.source}`,
  ].filter((x): x is string => !!x);
}

/** The posting on its own site, and the job's page in Job Matrix. */
function JobLinks({ row: r }: { row: ApplicationRow }) {
  return (
    <>
      {r.url && (
        <a href={r.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
          posting ↗
        </a>
      )}
      <Link to={`/applications/${r.id}`} className="text-accent hover:underline">
        job page
      </Link>
    </>
  );
}

function Title({ row: r, onChanged }: { row: ApplicationRow; onChanged: () => void }) {
  return (
    <>
      <InlineEdit
        value={r.title}
        unknown={r.title === 'Unknown role'}
        className="font-medium"
        onSave={(v) => api.updateJob(r.jobId, { title: v }).then(onChanged)}
      />
      <span className="text-ink-3"> · </span>
      <InlineEdit
        value={r.company}
        unknown={r.company === 'Unknown'}
        className="text-ink-2"
        onSave={(v) => api.updateJob(r.jobId, { companyName: v }).then(onChanged)}
      />
    </>
  );
}

function Scored({
  row: r,
  expanded,
  onChanged,
  live,
  errors,
  scoreButton,
}: {
  row: ApplicationRow;
  expanded: boolean;
  onChanged: () => void;
  live: ReactNode;
  errors: ReactNode;
  scoreButton: ReactNode;
}) {
  const [open, setOpen] = useState(expanded);
  useEffect(() => setOpen(expanded), [expanded]);
  const reasons = (r.fitGateReasons ?? []) as GateReason[];

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className={open ? 'text-base' : 'text-sm'}>
            <Title row={r} onChanged={onChanged} />
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-ink-3">
            <span>{metaLine(r).join(' · ')}</span>
            <WatchlistChips row={r} />
            <JobLinks row={r} />
          </div>
        </div>
        <Verdict
          score={r.fitScore!}
          verdict={r.fitVerdict}
          gate={r.fitGate}
          reasons={reasons}
          compact={!open}
        />
        {!open && <Actions row={r} onChanged={onChanged} compact />}
        <Button
          variant="ghost"
          className="px-2"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? 'Collapse' : 'Show the details'}
        >
          {open ? '▾' : '▸'}
        </Button>
      </div>

      {live && <div className="mt-3">{live}</div>}
      {errors}
      {open && <ScoredBody row={r} onChanged={onChanged} scoreButton={scoreButton} />}
    </>
  );
}

/** The opened card: tiles, lists and bars, every action, and the deeper details on request. */
function ScoredBody({
  row: r,
  onChanged,
  scoreButton,
}: {
  row: ApplicationRow;
  onChanged: () => void;
  scoreButton: ReactNode;
}) {
  const [details, setDetails] = useState(false);
  const { detail, brief, stock, minBase, fit } = useDecisionData(r.id, r.companyId);
  const reasons = (r.fitGateReasons ?? []) as GateReason[];
  return (
    <>
      <DecisionBody
        title={r.title}
        fit={fit}
        reasons={reasons}
        detail={detail}
        brief={brief}
        stock={stock}
        minBase={minBase}
        onMore={() => setDetails(true)}
        moreLabel="in details"
      />

      <div className="mt-3 border-t border-border pt-3">
        <Actions
          row={r}
          onChanged={onChanged}
          extra={
            <>
              {scoreButton}
              <Button variant="ghost" onClick={() => setDetails((v) => !v)} aria-expanded={details}>
                {details ? '▾ Less' : '▸ Summary, company, description'}
              </Button>
            </>
          }
        />
      </div>

      {details && (
        <div className="mt-3 space-y-3 border-t border-border pt-3 text-sm">
          {fit && (
            <div className="space-y-1">
              <p>{fit.summary}</p>
              <p className="text-ink-2">
                <span className="font-medium text-ink">Why not higher:</span> {fit.whyNotHigher}
              </p>
            </div>
          )}
          <CompanyInsights companyId={r.companyId} companyName={r.company} />
          <Description row={r} />
        </div>
      )}
    </>
  );
}

function Description({ row: r }: { row: ApplicationRow }) {
  const [expanded, setExpanded] = useState(false);
  if (!r.descriptionPreview)
    return (
      <p className="text-sm text-warn">
        No description captured.{' '}
        <Link to={`/applications/${r.id}`} className="underline">
          Paste it on the job page
        </Link>{' '}
        to enable scoring.
      </p>
    );
  return (
    <div className="text-sm">
      <div className="text-xs text-ink-3">
        Job description · from {r.descriptionSource ?? 'unknown'}
      </div>
      <p className={cx('mt-1 whitespace-pre-wrap text-ink-2', !expanded && 'line-clamp-3')}>
        {r.descriptionPreview}
      </p>
      <button
        className="text-xs text-accent hover:underline"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? 'Less' : 'More'}
      </button>
    </div>
  );
}

/**
 * Pipeline / Applied / Pass (with reason) / Delete — plus any extra controls on the right.
 * `compact` keeps just Pipeline and Pass, for the one-line row.
 */
function Actions({
  row: r,
  onChanged,
  extra,
  compact,
}: {
  row: ApplicationRow;
  onChanged: () => void;
  extra?: ReactNode;
  compact?: boolean;
}) {
  const [passing, setPassing] = useState(false);
  const [reason, setReason] = useState('');
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
  const remove = useMutation({
    mutationFn: () => api.deleteApplication(r.id),
    onSuccess: onChanged,
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      {r.status === 'Screening' ? (
        <>
          <Button
            variant={compact ? 'secondary' : 'primary'}
            onClick={() => move.mutate('Saved')}
            disabled={move.isPending}
          >
            Add to pipeline
          </Button>
          {!compact && (
            <Button onClick={() => move.mutate('Applied')} disabled={move.isPending}>
              Applied
            </Button>
          )}
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
                className="w-52"
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
      {!compact && (
        <>
          <span className="flex-1" />
          {extra}
          <Button
            variant="ghost"
            className="text-ink-3"
            disabled={remove.isPending}
            onClick={() =>
              confirm(
                `Delete "${r.title}" at ${r.company}? This removes it and its scores completely.`,
              ) && remove.mutate()
            }
            title="Delete completely"
          >
            Delete
          </Button>
        </>
      )}
      <ErrorText error={move.error ?? pass.error ?? remove.error} />
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
