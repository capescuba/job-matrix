import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  FIT_PARTS,
  type CompanyResearch,
  type FitPartKey,
  type FitResult,
  type Gate,
  type GateReason,
} from '@jm/shared';
import { api, type ApplicationDetail, type StockQuote } from '../api.ts';
import { formatScore } from './badges.tsx';
import { cx } from './ui.tsx';

/**
 * The at-a-glance decision view shared by Screening cards and the job page: score and filter
 * chip, five tiles, short "Works for you" / "Watch out" lists, and thin fit bars.
 */

/** Everything the decision view reads for one job: its detail, the company brief and stock. */
export function useDecisionData(applicationId: number, companyId: number) {
  const { data: detail } = useQuery({
    queryKey: ['application', applicationId],
    queryFn: () => api.getApplication(applicationId),
  });
  const { data: research } = useQuery({
    queryKey: ['research', companyId],
    queryFn: () => api.getResearch(companyId),
  });
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: api.getProfile });
  const brief = research?.result as CompanyResearch | undefined;
  const isPublic = brief?.snapshot.ownership === 'Public' && !!brief.snapshot.ticker;
  const { data: stock } = useQuery({
    queryKey: ['stock', companyId],
    queryFn: () => api.getStock(companyId),
    enabled: isPublic,
    staleTime: 30 * 60_000,
  });
  const latest = detail?.fits[0];
  return {
    detail,
    brief,
    stock,
    minBase: profile?.profile.minBase ?? null,
    // Assessments from the first scoring version have no parts; treat them as unscored here.
    fit: (latest?.result as FitResult | undefined)?.parts
      ? (latest!.result as FitResult)
      : undefined,
  };
}

/** Score ring with the verdict and the must-have / deal-breaker chip beside it. */
export function Verdict({
  score,
  verdict,
  gate,
  reasons,
  compact,
}: {
  score: number;
  verdict: string | null;
  gate: Gate | null;
  reasons: GateReason[];
  /** A smaller ring, for one-line rows. */
  compact?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="text-right text-xs">
        <div className="text-ink-2">{verdict}</div>
        {gate === 'fail' ? (
          <GateChip
            tone="bad"
            reasons={reasons.filter((x) => x.status === 'fails')}
            prefix="Fails"
          />
        ) : gate === 'check' ? (
          <GateChip tone="warn" reasons={reasons} prefix="Check" />
        ) : (
          <span className="mt-1 inline-block rounded bg-good/10 px-2 py-0.5 text-good">
            Passes filters
          </span>
        )}
      </div>
      <div
        className={cx(
          'flex shrink-0 items-center justify-center rounded-full font-semibold tabular-nums',
          compact ? 'size-10 border-2 text-sm' : 'size-13 border-[3px] text-lg',
          gate === 'fail' ? 'border-bad/50 text-ink-3' : 'border-accent/60',
        )}
        title="Fit score (0–10)"
      >
        {formatScore(score)}
      </div>
    </div>
  );
}

/** Tiles, the two short lists and the fit bars. */
export function DecisionBody({
  title,
  fit,
  reasons,
  detail,
  brief,
  stock,
  minBase,
  onMore,
  moreLabel,
}: {
  title: string;
  fit: FitResult | undefined;
  reasons: GateReason[];
  detail: ApplicationDetail | undefined;
  brief: CompanyResearch | undefined;
  stock: StockQuote | null | undefined;
  minBase: number | null;
  onMore: () => void;
  moreLabel: string;
}) {
  return (
    <>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <PayTile detail={detail} minBase={minBase} reasons={reasons} />
        <OfficeTile fit={fit} brief={brief} reasons={reasons} />
        <Tile
          label="Level"
          value={levelOf(title)}
          sub={fit?.flags.levelMismatch ? 'below your target' : fit ? 'fits your target' : ''}
          tone={fit?.flags.levelMismatch ? 'warn' : fit ? 'good' : 'none'}
          title={fit?.flags.levelMismatch ?? fit?.parts.level.why}
        />
        <MarketTile brief={brief} stock={stock} />
        <CultureTile brief={brief} />
      </div>

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
            onMore={onMore}
            moreLabel={moreLabel}
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
            onMore={onMore}
            moreLabel={moreLabel}
          />
        </div>
      )}

      {fit && <FitBars fit={fit} />}
    </>
  );
}

export function FitBars({ fit }: { fit: FitResult }) {
  return (
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
  );
}

type Tone = 'good' | 'warn' | 'bad' | 'none';
const toneText: Record<Tone, string> = {
  good: 'text-good',
  warn: 'text-warn',
  bad: 'text-bad',
  none: 'text-ink-3',
};
const toneIcon: Record<Tone, string> = { good: '✓', warn: '!', bad: '✕', none: '' };

export const barTone = (s: number) =>
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

export function GateChip({
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
  detail: ApplicationDetail | undefined;
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
  if (s.ownership === 'Subsidiary')
    return (
      <Tile
        label="Ownership"
        value="Subsidiary"
        sub="no stock of its own"
        tone="none"
        title={s.whatTheyDo}
      />
    );
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

export function ShortList({
  title,
  tone,
  items,
  onMore,
  moreLabel = 'in details',
}: {
  title: string;
  tone: 'good' | 'bad';
  items: { label: string; detail: string }[];
  onMore: () => void;
  moreLabel?: string;
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
          +{items.length - shown.length} more {moreLabel}
        </button>
      )}
    </div>
  );
}
