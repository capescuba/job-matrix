import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Line, LineChart, ResponsiveContainer, Tooltip, YAxis } from 'recharts';
import type { CompanyResearch } from '@jm/shared';
import { api } from '../api.ts';
import { useAiRuns } from '../aiActivity.ts';
import { CallInspector } from './CallInspector.tsx';
import { LiveRun } from './LiveRun.tsx';
import { Button, ErrorText, cx } from './ui.tsx';

type Tab = 'flags' | 'news' | 'culture' | 'stock' | 'questions' | 'sources';
const TABS: { key: Tab; label: string }[] = [
  { key: 'flags', label: 'Flags for you' },
  { key: 'news', label: 'News & momentum' },
  { key: 'culture', label: 'Culture & interviews' },
  { key: 'stock', label: 'Stock & financials' },
  { key: 'questions', label: 'Questions to ask' },
  { key: 'sources', label: 'Sources' },
];

const ago = (iso: string) => {
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
};

/** Cited company brief (web research) — shared by Screening cards and the job page. */
export function CompanyInsights({
  companyId,
  companyName,
}: {
  companyId: number;
  companyName: string;
}) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('flags');
  const [inspect, setInspect] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['research', companyId],
    queryFn: () => api.getResearch(companyId),
  });
  // Research runs for this company (from Score, Research now or Refresh), shown live here.
  const [mountedAt] = useState(Date.now);
  const runs = useAiRuns().filter(
    (x) => x.companyId === companyId && (!x.finishedAt || x.startedAt >= mountedAt - 1000),
  );
  const running = runs.some((x) => !x.finishedAt);
  const finished = runs.filter((x) => x.finishedAt).length;
  useEffect(() => {
    if (!finished) return;
    qc.invalidateQueries({ queryKey: ['research', companyId] });
    qc.invalidateQueries({ queryKey: ['stock', companyId] });
    qc.invalidateQueries({ queryKey: ['applications'] });
    qc.invalidateQueries({ queryKey: ['usage'] });
  }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = runs.length > 0 && (
    <div className="space-y-2">
      {runs.map((x) => (
        <LiveRun key={x.id} run={x} showLabel />
      ))}
    </div>
  );
  const refresh = useMutation({
    mutationFn: () => api.refreshResearch(companyId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['research', companyId] });
      qc.invalidateQueries({ queryKey: ['stock', companyId] });
      qc.invalidateQueries({ queryKey: ['applications'] });
      qc.invalidateQueries({ queryKey: ['usage'] });
    },
  });

  if (isLoading) return null;
  if (!data)
    return (
      <div className="space-y-2">
        {live}
        {!running && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-ink-2">
            <span>No company brief for {companyName} yet — it's made when you press Score.</span>
            <Button
              variant="ghost"
              className="ml-auto"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              {refresh.isPending ? 'Researching…' : 'Research now'}
            </Button>
            <ErrorText error={refresh.error} />
          </div>
        )}
      </div>
    );

  const r = data.result as CompanyResearch;
  const src = new Map(r.sources.map((s) => [s.id, s]));
  const Cite = ({ ids }: { ids: number[] }) => (
    <>
      {ids
        .filter((id) => src.has(id))
        .map((id) => (
          <a
            key={id}
            href={src.get(id)!.url}
            target="_blank"
            rel="noreferrer"
            title={src.get(id)!.title}
            className="ml-0.5 align-super text-[10px] text-accent hover:underline"
          >
            [{id}]
          </a>
        ))}
    </>
  );
  const reds = r.flags.filter((f) => f.tone === 'red').length;
  const greens = r.flags.length - reds;

  return (
    <div className="rounded-md border border-border">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-xs">
        <span className="text-sm font-semibold">Company insights</span>
        <span className="text-bad">{reds} red</span>
        <span className="text-good">{greens} green</span>
        <span
          className={data.stale ? 'text-warn' : 'text-ink-3'}
          title={
            data.stale
              ? 'Briefs are never redone automatically — press Refresh if you want the latest'
              : 'Kept for this company and reused by all its jobs; only Refresh researches again'
          }
        >
          researched {ago(data.createdAt)}
          {data.stale && ' · Refresh for the latest'}
        </span>
        <span className="ml-auto flex gap-1">
          {data.usageId != null && (
            <Button
              variant="ghost"
              className="px-2 py-0.5 text-xs"
              onClick={() => setInspect(true)}
            >
              Inspect request
            </Button>
          )}
          <Button
            variant="ghost"
            className="px-2 py-0.5 text-xs"
            disabled={refresh.isPending || running}
            onClick={() => refresh.mutate()}
            title="Research again with web search (a paid AI call, about 80¢)"
          >
            {refresh.isPending ? 'Researching…' : 'Refresh'}
          </Button>
        </span>
      </div>
      <ErrorText error={refresh.error} />
      {live && <div className="border-b border-border p-2">{live}</div>}
      <div className="flex flex-wrap gap-1 border-b border-border px-2 pt-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cx(
              '-mb-px border-b-2 px-2 py-1 text-xs',
              tab === t.key
                ? 'border-accent font-medium text-ink'
                : 'border-transparent text-ink-2 hover:text-ink',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="p-3 text-sm">
        {tab === 'flags' && (
          <ul className="space-y-2">
            {r.flags.map((f, i) => (
              <li key={i} className="flex gap-2">
                <span
                  className={cx(
                    'mt-0.5 shrink-0 font-bold',
                    f.tone === 'red' ? 'text-bad' : 'text-good',
                  )}
                >
                  {f.tone === 'red' ? '▼' : '▲'}
                </span>
                <span>
                  <span className="font-medium">{f.title}</span>
                  <Cite ids={f.sourceIds} /> — {f.detail}
                  <span className="block text-xs text-ink-3">For you: {f.whyItMatters}</span>
                </span>
              </li>
            ))}
            {r.flags.length === 0 && <li className="text-ink-3">No flags found.</li>}
          </ul>
        )}

        {tab === 'news' && (
          <div className="space-y-3">
            <p>
              <span
                className={cx(
                  'mr-2 rounded-full border px-2 py-0.5 text-xs font-medium',
                  r.momentum.trend === 'Growing'
                    ? 'border-good/40 text-good'
                    : r.momentum.trend === 'Shrinking'
                      ? 'border-bad/40 text-bad'
                      : 'border-border text-ink-2',
                )}
              >
                {r.momentum.trend}
              </span>
              {r.momentum.summary}
              <Cite ids={r.momentum.sourceIds} />
            </p>
            <ul className="space-y-2">
              {r.news.map((n, i) => (
                <li key={i}>
                  <span className="tabular-nums text-xs text-ink-3">{n.date}</span>{' '}
                  <span className="rounded bg-surface-2 px-1.5 text-[11px] text-ink-2">
                    {n.category}
                  </span>{' '}
                  <span className="font-medium">{n.headline}</span>
                  <Cite ids={n.sourceIds} />
                  <span className="block text-ink-2">{n.summary}</span>
                </li>
              ))}
              {r.news.length === 0 && <li className="text-ink-3">No recent news found.</li>}
            </ul>
          </div>
        )}

        {tab === 'culture' && (
          <div className="space-y-3">
            <p>
              {r.culture.summary}
              <Cite ids={r.culture.sourceIds} />
            </p>
            {r.culture.ratings.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {r.culture.ratings.map((x, i) => (
                  <span key={i} className="rounded border border-border px-2 py-0.5 text-xs">
                    {x.site} <strong className="tabular-nums">{x.rating}</strong>
                    {x.reviews != null && (
                      <span className="text-ink-3"> ({x.reviews.toLocaleString()})</span>
                    )}
                    <Cite ids={x.sourceIds} />
                  </span>
                ))}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Bullets title="Pros" items={r.culture.pros} />
              <Bullets title="Cons" items={r.culture.cons} />
            </div>
            <Facts
              rows={[
                ['Return to office', r.culture.returnToOffice],
                ['Work-life balance', r.culture.workLifeBalance],
                ['TPM org', r.culture.tpmOrg],
                ['Interview process', r.interview.process],
                ['TPM pay bands', r.comp.tpmBands],
              ]}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Bullets title="Interview rounds" items={r.interview.rounds} />
              <Bullets title="Tips" items={r.interview.tips} />
            </div>
          </div>
        )}

        {tab === 'stock' && (
          <StockTab companyId={companyId} research={r} cite={(ids) => <Cite ids={ids} />} />
        )}

        {tab === 'questions' && (
          <ol className="list-decimal space-y-1 pl-5">
            {r.questionsToAsk.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ol>
        )}

        {tab === 'sources' && (
          <ol className="space-y-1">
            {r.sources.map((s) => (
              <li key={s.id} className="flex gap-2">
                <span className="w-6 shrink-0 text-right tabular-nums text-ink-3">[{s.id}]</span>
                <span className="min-w-0">
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent hover:underline"
                  >
                    {s.title}
                  </a>
                  <span className="text-xs text-ink-3">
                    {' '}
                    {[s.publisher, s.date].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
      {inspect && data.usageId != null && (
        <CallInspector usageId={data.usageId} onClose={() => setInspect(false)} />
      )}
    </div>
  );
}

function Bullets({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-2">{title}</div>
      <ul className="list-disc space-y-0.5 pl-5">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

function Facts({ rows }: { rows: [string, ReactNode | null][] }) {
  const shown = rows.filter(([, v]) => v);
  if (!shown.length) return null;
  return (
    <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1">
      {shown.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-3">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const money = (n: number, currency: string | null) =>
  n.toLocaleString(undefined, {
    style: 'currency',
    currency: currency ?? 'USD',
    maximumFractionDigits: 2,
  });

function StockTab({
  companyId,
  research: r,
  cite,
}: {
  companyId: number;
  research: CompanyResearch;
  cite: (ids: number[]) => ReactNode;
}) {
  const s = r.snapshot;
  const isPublic = s.ownership === 'Public' && !!s.ticker;
  const { data: q, isLoading } = useQuery({
    queryKey: ['stock', companyId],
    queryFn: () => api.getStock(companyId),
    enabled: isPublic,
    staleTime: 30 * 60_000,
  });
  const facts: [string, ReactNode | null][] = [
    ['Company', s.whatTheyDo],
    [
      'Ownership',
      `${s.ownership}${s.ticker ? ` · ${s.ticker}${s.exchange ? ` (${s.exchange})` : ''}` : ''}`,
    ],
    ['Headquarters', s.headquarters],
    ['Headcount', s.headcount],
    ['Funding stage', s.fundingStage],
    ['Last funding', s.lastFunding],
    ['Market cap', r.financials.marketCap],
    ['Revenue trend', r.financials.revenueTrend],
  ];
  return (
    <div className="space-y-3">
      {isPublic &&
        (isLoading ? (
          <p className="text-ink-3">Loading {s.ticker}…</p>
        ) : !q ? (
          <p className="text-ink-3">No price data found for {s.ticker}.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-center">
            <div>
              <div className="text-xs text-ink-3">
                {q.ticker} · {q.exchange ?? ''}
              </div>
              <div className="text-2xl font-semibold tabular-nums">
                {money(q.price, q.currency)}
              </div>
              {q.change1yPct != null && (
                <div
                  className={cx(
                    'text-sm tabular-nums',
                    q.change1yPct >= 0 ? 'text-good' : 'text-bad',
                  )}
                >
                  {q.change1yPct >= 0 ? '+' : ''}
                  {q.change1yPct.toFixed(1)}% over 1 year
                </div>
              )}
              {q.low52 != null && q.high52 != null && (
                <div className="mt-1 text-xs text-ink-3">
                  52-week range {money(q.low52, q.currency)} – {money(q.high52, q.currency)}
                </div>
              )}
            </div>
            <div className="h-24 min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={q.series} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                  <YAxis domain={['dataMin', 'dataMax']} hide />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      color: 'var(--ink)',
                      fontSize: 12,
                    }}
                    labelFormatter={(_, p) => p?.[0]?.payload?.date ?? ''}
                    formatter={(v) => [money(Number(v), q.currency), 'Close']}
                  />
                  <Line
                    type="monotone"
                    dataKey="close"
                    stroke="var(--series-1)"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        ))}
      <Facts rows={facts} />
      <p className="text-xs text-ink-3">
        Company facts from research{cite([...s.sourceIds, ...r.financials.sourceIds])}
        {isPublic && q && ` · price from ${q.source}, ${new Date(q.asOf).toLocaleDateString()}`}
      </p>
    </div>
  );
}
