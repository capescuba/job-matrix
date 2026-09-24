import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  FIT_PARTS,
  type CompanyResearch,
  type FitPartKey,
  type FitResult,
  type GateReason,
} from '@jm/shared';
import { api, type ApplicationRow, type StockQuote } from '../api.ts';
import { useAiRuns } from '../aiActivity.ts';
import { formatScore, postedOf } from './badges.tsx';
import { CompanyInsights } from './CompanyInsights.tsx';
import { LiveRun } from './LiveRun.tsx';
import { Button, ErrorText, Input, cx } from './ui.tsx';

type Tone = 'good' | 'warn' | 'bad' | 'none';
const toneText: Record<Tone, string> = {
  good: 'text-good',
  warn: 'text-warn',
  bad: 'text-bad',
  none: 'text-ink-3',
};
const toneIcon: Record<Tone, string> = { good: '✓', warn: '!', bad: '✕', none: '' };

const barTone = (s: number) =>
  s >= 8 ? 'bg-good' : s >= 7 ? 'bg-accent' : s >= 6 ? 'bg-warn' : 'bg-bad';

const k = (n: number) => `$${Math.round(n / 1000)}K`;
const range = (min: number | null | undefined, max: number | null | undefined) =>
  min && max ? `${k(min)}–${k(max).slice(1)}` : min ? `${k(min)}+` : max ? `up to ${k(max)}` : null;

/** The seniority word in a title, for the Level tile. */
function levelOf(title: string): string {
  const m = title.match(/\b(principal|staff|senior|sr\.?|lead|director|head|manager)\b/i);
  if (!m) return 'Not stated';
  const w = m[1].toLowerCase();
  return w.startsWith('sr') ? 'Senior' : w[0].toUpperCase() + w.slice(1);
}

export interface Costs {
  fit: number | null;
  research: number;
}

/**
 * One job in the Screening inbox. Scored jobs get the decision card (verdict, five tiles, short
 * works-for-you / watch-out lists, fit bars); unscored ones stay a single line until you score.
 */
export function ScreeningCard({
  row: r,
  focused,
  costs,
  onChanged,
}: {
  row: ApplicationRow;
  focused: boolean;
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
          </div>
          {!r.hasDescription && <span className="text-xs text-warn">No description captured</span>}
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

  // ---- Scored: the decision card ----
  return (
    <div ref={ref} className={cx(frame, 'p-4')}>
      <Scored row={r} onChanged={onChanged} live={live} errors={errors} scoreButton={scoreButton} />
    </div>
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
  onChanged,
  live,
  errors,
  scoreButton,
}: {
  row: ApplicationRow;
  onChanged: () => void;
  live: ReactNode;
  errors: ReactNode;
  scoreButton: ReactNode;
}) {
  const [details, setDetails] = useState(false);
  const { data: detail } = useQuery({
    queryKey: ['application', r.id],
    queryFn: () => api.getApplication(r.id),
  });
  const { data: research } = useQuery({
    queryKey: ['research', r.companyId],
    queryFn: () => api.getResearch(r.companyId),
  });
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: api.getProfile });
  const brief = research?.result as CompanyResearch | undefined;
  const isPublic = brief?.snapshot.ownership === 'Public' && !!brief.snapshot.ticker;
  const { data: stock } = useQuery({
    queryKey: ['stock', r.companyId],
    queryFn: () => api.getStock(r.companyId),
    enabled: isPublic,
    staleTime: 30 * 60_000,
  });
  const fit = detail?.fits[0]?.result as FitResult | undefined;
  const reasons = (r.fitGateReasons ?? []) as GateReason[];

  return (
    <>
      {/* Header */}
      <div className="flex gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-base">
            <Title row={r} onChanged={onChanged} />
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-ink-3">
            <span>{metaLine(r).join(' · ')}</span>
            {r.url && (
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                posting ↗
              </a>
            )}
            <Link to={`/applications/${r.id}`} className="text-accent hover:underline">
              job page
            </Link>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right text-xs">
            <div className="text-ink-2">{r.fitVerdict}</div>
            {r.fitGate === 'fail' ? (
              <GateChip
                tone="bad"
                reasons={reasons.filter((x) => x.status === 'fails')}
                prefix="Fails"
              />
            ) : r.fitGate === 'check' ? (
              <GateChip tone="warn" reasons={reasons} prefix="Check" />
            ) : (
              <span className="mt-1 inline-block rounded bg-good/10 px-2 py-0.5 text-good">
                Passes filters
              </span>
            )}
          </div>
          <div
            className={cx(
              'flex size-13 items-center justify-center rounded-full border-[3px] text-lg font-semibold tabular-nums',
              r.fitGate === 'fail' ? 'border-bad/50 text-ink-3' : 'border-accent/60',
            )}
            title="Fit score (0–10)"
          >
            {formatScore(r.fitScore!)}
          </div>
        </div>
      </div>

      {/* Five decision tiles */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <PayTile detail={detail} minBase={profile?.profile.minBase ?? null} reasons={reasons} />
        <OfficeTile fit={fit} brief={brief} reasons={reasons} />
        <Tile
          label="Level"
          value={levelOf(r.title)}
          sub={fit?.flags.levelMismatch ? 'below your target' : fit ? 'fits your target' : ''}
          tone={fit?.flags.levelMismatch ? 'warn' : fit ? 'good' : 'none'}
          title={fit?.flags.levelMismatch ?? fit?.parts.level.why}
        />
        <MarketTile brief={brief} stock={stock} />
        <CultureTile brief={brief} />
      </div>

      {/* Works for you / Watch out */}
      {(fit || brief) && (
        <div className="mt-3 grid gap-4 text-sm sm:grid-cols-2">
          <ShortList
            title="Works for you"
            tone="good"
            items={[
              ...(fit?.strengths ?? []).map((s) => ({
                label: s.label ?? s.point,
                detail: `${s.point} — “${s.evidence}”`,
              })),
              ...(brief?.flags ?? [])
                .filter((f) => f.tone === 'green')
                .map((f) => ({ label: f.title, detail: `${f.detail} ${f.whyItMatters}` })),
            ]}
            onMore={() => setDetails(true)}
          />
          <ShortList
            title="Watch out"
            tone="bad"
            items={[
              ...(fit?.gaps ?? [])
                .filter((g) => g.severity !== 'Minor')
                .map((g) => ({ label: g.label ?? g.gap, detail: `${g.gap} → ${g.mitigation}` })),
              ...(brief?.flags ?? [])
                .filter((f) => f.tone === 'red')
                .map((f) => ({ label: f.title, detail: `${f.detail} ${f.whyItMatters}` })),
            ]}
            onMore={() => setDetails(true)}
          />
        </div>
      )}

      {/* Fit breakdown */}
      {fit && (
        <div className="mt-3 grid grid-cols-5 gap-3 text-[11px] text-ink-3">
          {(Object.keys(FIT_PARTS) as FitPartKey[]).map((key) => (
            <div key={key} title={fit.parts[key].why}>
              <div className="flex justify-between">
                <span className="truncate">
                  {FIT_PARTS[key].label.replace(/ match| & interest/, '')}
                </span>
                <span className="tabular-nums text-ink-2">{formatScore(fit.parts[key].score)}</span>
              </div>
              <div className="mt-1 h-1 rounded-full bg-surface-2">
                <div
                  className={cx('h-1 rounded-full', barTone(fit.parts[key].score))}
                  style={{ width: `${Math.max(0, Math.min(10, fit.parts[key].score)) * 10}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {live && <div className="mt-3">{live}</div>}
      {errors}

      {/* Actions */}
      <div className="mt-3 border-t border-border pt-3">
        <Actions
          row={r}
          onChanged={onChanged}
          extra={
            <>
              {scoreButton}
              <Button variant="ghost" onClick={() => setDetails((v) => !v)} aria-expanded={details}>
                {details ? '▾ Hide details' : '▸ Details'}
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

function GateChip({
  tone,
  reasons,
  prefix,
}: {
  tone: 'bad' | 'warn';
  reasons: GateReason[];
  prefix: string;
}) {
  return (
    <span
      className={cx(
        'mt-1 inline-block rounded px-2 py-0.5',
        tone === 'bad' ? 'bg-bad/10 text-bad' : 'bg-warn/10 text-warn',
      )}
      title={reasons.map((x) => `${x.label}: ${x.note}`).join('\n')}
    >
      {prefix}: {reasons.map((x) => x.label.toLowerCase()).join(', ')}
    </span>
  );
}

function Tile({
  label,
  value,
  sub,
  tone,
  title,
  children,
}: {
  label: string;
  value: ReactNode;
  sub: ReactNode;
  tone: Tone;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-md bg-surface-2 px-3 py-2" title={title}>
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className="truncate text-sm font-semibold">{value}</div>
      {children}
      <div className={cx('truncate text-[11px]', toneText[tone])}>
        {toneIcon[tone] && <span className="mr-1">{toneIcon[tone]}</span>}
        {sub}
      </div>
    </div>
  );
}

function PayTile({
  detail,
  minBase,
  reasons,
}: {
  detail: Awaited<ReturnType<typeof api.getApplication>> | undefined;
  minBase: number | null;
  reasons: GateReason[];
}) {
  const p = detail?.payRange;
  const text = p ? range(p.min, p.max) : null;
  const pay = reasons.find((x) => x.kind === 'pay');
  const tone: Tone = !text ? 'warn' : pay?.status === 'fails' ? 'bad' : minBase ? 'good' : 'none';
  return (
    <Tile
      label="Base pay"
      value={text ?? 'Not posted'}
      sub={
        !text
          ? 'ask the recruiter'
          : pay?.status === 'fails'
            ? `below ${k(minBase ?? 0)}`
            : minBase
              ? `clears ${k(minBase)}`
              : p?.from === 'description'
                ? 'from description'
                : 'posted'
      }
      tone={tone}
      title={pay?.note ?? (p?.from === 'description' ? 'Read from the job description' : undefined)}
    />
  );
}

function OfficeTile({
  fit,
  brief,
  reasons,
}: {
  fit: FitResult | undefined;
  brief: CompanyResearch | undefined;
  reasons: GateReason[];
}) {
  const days = fit?.facts.officeDaysPerWeek ?? brief?.culture.officeDaysPerWeek ?? null;
  const officeFail = reasons.find(
    (x) =>
      x.status === 'fails' &&
      /remote|office|onsite|on-site|hybrid|days/i.test(`${x.label} ${x.note}`),
  );
  const value =
    days == null ? 'Not stated' : days === 0 ? 'Remote' : `${days} day${days === 1 ? '' : 's'}/wk`;
  return (
    <Tile
      label="Office"
      value={value}
      sub={
        officeFail ? 'fails your must-have' : days == null ? 'check policy' : 'meets your must-have'
      }
      tone={officeFail ? 'bad' : days == null ? 'warn' : 'good'}
      title={officeFail?.note ?? brief?.culture.returnToOffice ?? undefined}
    />
  );
}

function MarketTile({
  brief,
  stock,
}: {
  brief: CompanyResearch | undefined;
  stock: StockQuote | null | undefined;
}) {
  if (!brief) return <Tile label="Company" value="—" sub="not researched" tone="none" />;
  const s = brief.snapshot;
  if (s.ownership === 'Public' && s.ticker) {
    if (!stock) return <Tile label={s.ticker} value="…" sub="loading price" tone="none" />;
    const up = (stock.change1yPct ?? 0) >= 0;
    return (
      <Tile
        label={stock.ticker}
        value={stock.price.toLocaleString(undefined, {
          style: 'currency',
          currency: stock.currency ?? 'USD',
        })}
        sub={
          stock.change1yPct == null ? '' : `${up ? '+' : ''}${stock.change1yPct.toFixed(0)}% 1 yr`
        }
        tone={stock.change1yPct == null ? 'none' : up ? 'good' : 'bad'}
        title={`52-week range ${stock.low52} – ${stock.high52} (${stock.source})`}
      >
        <Spark points={stock.series.map((p) => p.close)} up={up} />
      </Tile>
    );
  }
  return (
    <Tile
      label={s.ownership === 'Private' ? 'Private' : s.ownership}
      value={s.fundingStage ?? '—'}
      sub={s.lastFunding ?? 'funding not found'}
      tone="none"
      title={s.lastFunding ?? undefined}
    />
  );
}

function CultureTile({ brief }: { brief: CompanyResearch | undefined }) {
  if (!brief) return <Tile label="Culture" value="—" sub="not researched" tone="none" />;
  const rating = brief.culture.ratings[0];
  const trend = brief.momentum.trend;
  return (
    <Tile
      label="Culture"
      value={
        rating ? (
          <>
            {rating.rating}{' '}
            <span className="text-[11px] font-normal text-ink-3">
              {rating.site.replace(/\s*\(.*\)/, '')}
            </span>
          </>
        ) : (
          'No ratings'
        )
      }
      sub={`${trend === 'Unknown' ? 'momentum unclear' : trend.toLowerCase()}`}
      tone={
        trend === 'Growing'
          ? 'good'
          : trend === 'Shrinking'
            ? 'bad'
            : trend === 'Mixed'
              ? 'warn'
              : 'none'
      }
      title={`${brief.culture.summary}\n\nMomentum: ${brief.momentum.summary}`}
    />
  );
}

/** Tiny 1-year price line. */
function Spark({ points, up }: { points: number[]; up: boolean }) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const d = points
    .map((p, i) => `${(i / (points.length - 1)) * 100},${14 - ((p - min) / (max - min || 1)) * 12}`)
    .join(' ');
  return (
    <svg
      viewBox="0 0 100 16"
      preserveAspectRatio="none"
      className="my-0.5 h-3.5 w-full"
      aria-hidden
    >
      <polyline
        fill="none"
        strokeWidth="1.5"
        className={up ? 'stroke-good' : 'stroke-bad'}
        points={d}
      />
    </svg>
  );
}

function ShortList({
  title,
  tone,
  items,
  onMore,
}: {
  title: string;
  tone: 'good' | 'bad';
  items: { label: string; detail: string }[];
  onMore: () => void;
}) {
  const shown = items.slice(0, 4);
  return (
    <div>
      <div className={cx('mb-1 text-xs font-semibold', tone === 'good' ? 'text-good' : 'text-bad')}>
        {title}
      </div>
      {shown.length === 0 && <div className="text-xs text-ink-3">Nothing notable</div>}
      <ul className="space-y-0.5">
        {shown.map((x, i) => (
          <li key={i} className="flex gap-1.5" title={x.detail}>
            <span className={cx('shrink-0', tone === 'good' ? 'text-good' : 'text-bad')}>
              {tone === 'good' ? '✓' : '!'}
            </span>
            <span className="truncate">{x.label}</span>
          </li>
        ))}
      </ul>
      {items.length > shown.length && (
        <button className="mt-0.5 text-xs text-accent hover:underline" onClick={onMore}>
          +{items.length - shown.length} more in details
        </button>
      )}
    </div>
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

/** Pipeline / Applied / Pass (with reason) / Delete — plus any extra controls on the right. */
function Actions({
  row: r,
  onChanged,
  extra,
}: {
  row: ApplicationRow;
  onChanged: () => void;
  extra?: ReactNode;
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
          <Button variant="primary" onClick={() => move.mutate('Saved')} disabled={move.isPending}>
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
