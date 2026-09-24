import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.ts';
import { ScreeningCard } from '../components/ScreeningCard.tsx';
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
  const { data: usage } = useQuery({ queryKey: ['usage'], queryFn: api.usage });
  const costs = {
    fit: usage?.forecast.perCallUsd ?? null,
    research: usage?.forecast.researchPerCallUsd ?? 0.8,
  };

  const scoreAll = useMutation({
    mutationFn: () => api.startScoreAllWithResearch('Screening'),
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
                  // Research runs once per company that has no brief yet.
                  const toResearch = new Set(
                    unscored.filter((r) => !r.researchAt).map((r) => r.companyId),
                  ).size;
                  const total =
                    (each ?? 0) * unscored.length + u.forecast.researchPerCallUsd * toResearch;
                  const cost =
                    each != null
                      ? ` for about $${total.toFixed(2)} (fit $${(each * unscored.length).toFixed(2)}${toResearch ? ` + research on ${toResearch} ${toResearch === 1 ? 'company' : 'companies'}` : ''})`
                      : '';
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
            <ScreeningCard
              key={r.id}
              row={r}
              focused={r.id === focus}
              costs={costs}
              onChanged={refresh}
            />
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
