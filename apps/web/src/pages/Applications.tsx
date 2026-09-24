import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CLOSED_STATUSES, STATUSES, type Status } from '@jm/shared';
import { api, type ApplicationRow } from '../api.ts';
import { FitBadge, FlagChips, jobFlags } from '../components/badges.tsx';
import { Kanban } from '../components/Kanban.tsx';
import { QuickAdd } from '../components/QuickAdd.tsx';
import { Button, ErrorText, Input, Select, cx } from '../components/ui.tsx';

type SortKey =
  | 'company'
  | 'title'
  | 'status'
  | 'appliedAt'
  | 'lastActivityAt'
  | 'fitScore'
  | 'nextActionDate'
  | 'updated';

const sorters: Record<SortKey, (r: ApplicationRow) => string | number> = {
  company: (r) => r.company.toLowerCase(),
  title: (r) => r.title.toLowerCase(),
  status: (r) => STATUSES.indexOf(r.status),
  appliedAt: (r) => r.appliedAt ?? '',
  lastActivityAt: (r) => r.lastActivityAt ?? '',
  fitScore: (r) =>
    r.fitScore == null ? -100 : r.fitGate === 'fail' ? r.fitScore - 20 : r.fitScore,
  nextActionDate: (r) => r.nextActionDate ?? '9999',
  updated: (r) => r.updatedAt ?? r.createdAt,
};

export default function ApplicationsPage() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'board' ? 'board' : 'table';
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'open' | 'all' | Status>('open');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'updated', dir: -1 });
  const qc = useQueryClient();

  const {
    data = [],
    isLoading,
    error,
  } = useQuery({ queryKey: ['applications'], queryFn: api.listApplications });

  const move = useMutation({
    mutationFn: ({ id, status }: { id: number; status: Status }) =>
      api.updateApplication(id, { status }),
    onMutate: async ({ id, status }) => {
      await qc.cancelQueries({ queryKey: ['applications'] });
      const prev = qc.getQueryData<ApplicationRow[]>(['applications']);
      qc.setQueryData<ApplicationRow[]>(['applications'], (rows) =>
        rows?.map((r) => (r.id === id ? { ...r, status } : r)),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(['applications'], ctx.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: ['applications'] }),
  });

  // Batch scoring runs in the background on the server; poll its progress while it runs.
  const startScoreAll = useMutation({
    mutationFn: api.startScoreAll,
    onSuccess: (s) => qc.setQueryData(['fitBatch'], s),
  });
  const { data: batch } = useQuery({
    queryKey: ['fitBatch'],
    queryFn: api.scoreAllStatus,
    refetchInterval: (q) => (q.state.data?.running ? 1500 : false),
  });
  const batchDone = batch?.done ?? 0;
  useEffect(() => {
    if (!batch) return;
    qc.invalidateQueries({ queryKey: ['applications'] });
    if (!batch.running) qc.invalidateQueries({ queryKey: ['usage'] });
  }, [batchDone, batch?.running]); // eslint-disable-line react-hooks/exhaustive-deps
  const [hideBatch, setHideBatch] = useState(false);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = data.filter((r) => {
      if (statusFilter === 'open' && CLOSED_STATUSES.includes(r.status)) return false;
      if (statusFilter !== 'open' && statusFilter !== 'all' && r.status !== statusFilter)
        return false;
      return (
        !needle || `${r.company} ${r.title} ${r.location ?? ''}`.toLowerCase().includes(needle)
      );
    });
    const get = sorters[sort.key];
    return filtered.sort((a, b) => (get(a) < get(b) ? -sort.dir : get(a) > get(b) ? sort.dir : 0));
  }, [data, q, statusFilter, sort]);

  const importDescriptions = useMutation({
    mutationFn: api.fetchMissingDescriptions,
    onSettled: () => qc.invalidateQueries({ queryKey: ['applications'] }),
  });

  const checkPostings = useMutation({
    mutationFn: api.checkPostings,
    onSettled: () => qc.invalidateQueries({ queryKey: ['applications'] }),
  });

  const unscored = data.filter((r) => r.hasDescription && r.fitScore == null).length;
  const missingDescriptions = data.filter((r) => r.url && !r.hasDescription).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold">
          Applications <span className="text-ink-3">{data.length}</span>
        </h1>
        <Input
          className="w-56"
          placeholder="Search company, title…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {view === 'table' && (
          <Select
            className="w-44"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          >
            <option value="open">Open only</option>
            <option value="all">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        )}
        <div className="flex rounded-md border border-border p-0.5">
          {(['table', 'board'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setParams(v === 'board' ? { view: 'board' } : {})}
              className={cx(
                'rounded px-2.5 py-1 text-sm capitalize',
                view === v ? 'bg-surface-2 font-medium' : 'text-ink-2',
              )}
            >
              {v}
            </button>
          ))}
        </div>
        <Button
          onClick={() => checkPostings.mutate()}
          disabled={checkPostings.isPending}
          title="Re-check each open application's posting: still open? when was it posted?"
        >
          {checkPostings.isPending ? 'Checking…' : 'Check postings'}
        </Button>
        {missingDescriptions > 0 && (
          <Button
            onClick={() => importDescriptions.mutate()}
            disabled={importDescriptions.isPending}
            title="Fetch the job description from each posting's link"
          >
            {importDescriptions.isPending
              ? 'Importing…'
              : `Import ${missingDescriptions} description${missingDescriptions === 1 ? '' : 's'}`}
          </Button>
        )}
        {batch?.running ? (
          <Button disabled title="Scoring in the background, 4 at a time">
            Scoring {batch.done}/{batch.total}…
          </Button>
        ) : (
          unscored > 0 && (
            <Button
              onClick={async () => {
                // Show the estimated spend before running a batch of paid AI calls.
                const f = await qc.fetchQuery({ queryKey: ['usage'], queryFn: api.usage });
                const cost =
                  f.forecast.totalUsd != null
                    ? ` for about $${f.forecast.totalUsd.toFixed(2)}`
                    : '';
                if (confirm(`Score ${unscored} jobs with ${f.forecast.modelLabel}${cost}?`)) {
                  setHideBatch(false);
                  startScoreAll.mutate();
                }
              }}
              disabled={startScoreAll.isPending}
              title="Score every job that has a description but no fit score"
            >
              Score {unscored} unscored
            </Button>
          )
        )}
        <Button variant="primary" onClick={() => setAdding(true)}>
          + Add job
        </Button>
      </div>
      <ErrorText error={error ?? startScoreAll.error ?? move.error ?? importDescriptions.error} />
      {batch && !batch.running && batch.total > 0 && !hideBatch && (
        <div className="flex items-start justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm">
          <span>
            Scored {batch.scored} of {batch.total} in{' '}
            {Math.round((Date.parse(batch.finishedAt!) - Date.parse(batch.startedAt)) / 1000)}s
            {batch.failed.length > 0 && (
              <span className="block text-xs text-warn">
                {batch.failed.length} failed: {batch.failed[0].error}
              </span>
            )}
          </span>
          <Button variant="ghost" className="px-2 py-0.5" onClick={() => setHideBatch(true)}>
            ✕
          </Button>
        </div>
      )}
      {checkPostings.data && (
        <div className="flex items-start justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm">
          <span>
            Checked {checkPostings.data.checked} postings: {checkPostings.data.open} open,{' '}
            <span className={checkPostings.data.closed.length ? 'font-medium text-bad' : ''}>
              {checkPostings.data.closed.length} closed
            </span>
            {checkPostings.data.unknown.length > 0 &&
              `, ${checkPostings.data.unknown.length} couldn't be checked (blocked or no link)`}
            .
            {checkPostings.data.closed.length > 0 && (
              <span className="block text-xs text-ink-2">
                Closed: {checkPostings.data.closed.map((c) => c.company).join(', ')}
              </span>
            )}
          </span>
          <Button variant="ghost" className="px-2 py-0.5" onClick={() => checkPostings.reset()}>
            ✕
          </Button>
        </div>
      )}
      {importDescriptions.data && (
        <div className="rounded-md border border-border bg-surface px-3 py-2 text-sm">
          <div className="flex items-center justify-between">
            <span>
              Imported {importDescriptions.data.fetched} description
              {importDescriptions.data.fetched === 1 ? '' : 's'}
              {importDescriptions.data.failed.length > 0 &&
                ` · ${importDescriptions.data.failed.length} need pasting by hand:`}
            </span>
            <Button
              variant="ghost"
              className="px-2 py-0.5"
              onClick={() => importDescriptions.reset()}
            >
              ✕
            </Button>
          </div>
          <ul className="mt-1 space-y-0.5 text-xs text-ink-2">
            {importDescriptions.data.failed.map((f) => {
              const row = data.find((r) => r.jobId === f.jobId);
              return (
                <li key={f.jobId}>
                  {row ? (
                    <Link to={`/applications/${row.id}`} className="font-medium hover:underline">
                      {f.company} — {f.title}
                    </Link>
                  ) : (
                    `${f.company} — ${f.title}`
                  )}
                  : <span className="text-ink-3">{f.error}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {isLoading ? (
        <p className="text-ink-2">Loading…</p>
      ) : data.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-ink-2">
          No applications yet.{' '}
          <button className="text-accent underline" onClick={() => setAdding(true)}>
            Add your first job
          </button>
          .
        </div>
      ) : view === 'board' ? (
        <Kanban
          rows={data.filter((r) => {
            const n = q.trim().toLowerCase();
            return !n || `${r.company} ${r.title}`.toLowerCase().includes(n);
          })}
          onMove={(id, status) => move.mutate({ id, status })}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-ink-2">
              <tr>
                {(
                  [
                    ['company', 'Company'],
                    ['title', 'Role'],
                    ['status', 'Status'],
                    ['fitScore', 'Fit'],
                    ['appliedAt', 'Applied'],
                    ['lastActivityAt', 'Last touch'],
                    ['nextActionDate', 'Next action'],
                  ] as [SortKey, string][]
                ).map(([key, label]) => (
                  <th key={key} className="px-3 py-2 font-medium">
                    <button
                      className="hover:text-ink"
                      onClick={() =>
                        setSort((s) => ({
                          key,
                          dir: s.key === key ? (-s.dir as 1 | -1) : key === 'fitScore' ? -1 : 1,
                        }))
                      }
                    >
                      {label} {sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : ''}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-border last:border-0 hover:bg-surface-2/60"
                >
                  <td className="px-3 py-2 font-medium">{r.company}</td>
                  <td className="px-3 py-2">
                    <Link to={`/applications/${r.id}`} className="hover:underline">
                      {r.title}
                    </Link>
                    {r.location && <span className="ml-2 text-xs text-ink-3">{r.location}</span>}
                    <div className="mt-0.5">
                      <FlagChips flags={jobFlags(r)} />
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <select
                      className="rounded border-none bg-transparent text-sm focus:ring-2 focus:ring-accent/40"
                      value={r.status}
                      onChange={(e) => move.mutate({ id: r.id, status: e.target.value as Status })}
                      aria-label="Status"
                    >
                      {STATUSES.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <FitBadge
                      score={r.fitScore}
                      verdict={r.fitVerdict}
                      gate={r.fitGate}
                      reasons={r.fitGateReasons}
                    />
                  </td>
                  <td className="px-3 py-2 tabular-nums text-ink-2">{r.appliedAt ?? '—'}</td>
                  <td className="px-3 py-2 tabular-nums text-ink-2">
                    <DaysAgo date={r.lastActivityAt} closed={CLOSED_STATUSES.includes(r.status)} />
                  </td>
                  <td className="px-3 py-2 text-ink-2">
                    {r.nextAction ? (
                      <>
                        {r.nextAction}{' '}
                        {r.nextActionDate && (
                          <span className="text-ink-3">· {r.nextActionDate}</span>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-ink-3">
                    No matches.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <QuickAdd open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

/** "5d ago", highlighted once an open application has gone quiet for two weeks. */
function DaysAgo({ date, closed }: { date: string | null; closed: boolean }) {
  if (!date) return <>—</>;
  const days = Math.floor((Date.now() - Date.parse(`${date.slice(0, 10)}T12:00:00Z`)) / 86_400_000);
  return (
    <span className={cx(!closed && days >= 14 && 'text-warn')} title={date.slice(0, 10)}>
      {days <= 0 ? 'today' : `${days}d ago`}
    </span>
  );
}
