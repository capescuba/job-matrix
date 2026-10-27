import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CLIENT_RUN_LABEL, type ClientCandidate } from '@jm/shared';
import { api, type ApplicationRow, type ClientView } from '../api.ts';
import { useAiRuns } from '../aiActivity.ts';
import { LiveRun } from './LiveRun.tsx';
import { Button, ErrorText, Input, cx } from './ui.tsx';

const cents = (usd: number) => (usd < 1 ? `${Math.round(usd * 100)}¢` : `$${usd.toFixed(2)}`);

const CONFIDENCE_TONE = {
  high: 'bg-good/10 text-good',
  medium: 'bg-warn/10 text-warn',
  low: 'bg-surface-2 text-ink-3',
} as const;

/** Chip by the company name: an agency, and who it's likely for. */
export function AgencyChip({ row: r }: { row: ApplicationRow }) {
  if (!r.isAgency) return null;
  return (
    <span className="ml-2 inline-flex items-center gap-1 align-middle text-xs">
      <span className="rounded bg-surface-2 px-1.5 py-0.5 text-ink-2" title="A staffing agency">
        Agency
      </span>
      {r.client && (
        <span
          className={cx(
            'rounded px-1.5 py-0.5',
            r.client.direct === 'match' ? 'bg-good/10 text-good' : 'bg-surface-2 text-ink-2',
          )}
          title={
            r.client.direct === 'match'
              ? `${r.client.company} posts a similar role itself: you can apply directly`
              : `Likely client (${r.client.confidence} confidence)`
          }
        >
          for {r.client.company}?{r.client.direct === 'match' && ' · hiring directly'}
        </span>
      )}
    </span>
  );
}

/**
 * Who an agency's job is for: hints from the email, likely clients with evidence, and whether
 * each posts the role itself — with one click to apply directly instead. For a recruiter email
 * that names its client, just the check of that company's own board.
 */
export function EndClient({ row: r, onChanged }: { row: ApplicationRow; onChanged: () => void }) {
  const qc = useQueryClient();
  const key = ['client', r.id];
  const { data, error } = useQuery({ queryKey: key, queryFn: () => api.getClient(r.id) });
  const [mountedAt] = useState(Date.now);
  const runs = useAiRuns().filter(
    (x) =>
      x.applicationId === r.id &&
      x.label.startsWith(CLIENT_RUN_LABEL) &&
      (!x.finishedAt || x.startedAt >= mountedAt - 1000),
  );
  const done = (v: ClientView) => {
    qc.setQueryData(key, v);
    onChanged();
  };
  const find = useMutation({
    mutationFn: (force: boolean) => api.findClient(r.id, force),
    onSuccess: done,
    onSettled: () => qc.invalidateQueries({ queryKey: ['usage'] }),
  });
  const agency = useMutation({
    mutationFn: (isAgency: boolean) => api.updateCompany(r.companyId, { isAgency }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key });
      onChanged();
    },
  });
  const checkSelf = useMutation({
    mutationFn: () => api.addClient(r.id, { company: r.company }),
    onSuccess: done,
  });

  if (!data) return <ErrorText error={error} />;
  const { lookup } = data;
  const candidates = lookup.result.candidates;

  // A recruiter email that names the company: is it posted on their own board too?
  if (!data.isAgency) {
    const self = candidates.find((c) => c.company.toLowerCase() === r.company.toLowerCase());
    return (
      <div className="space-y-2 rounded-md border border-border p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">From a recruiter</span>
          <span className="text-ink-3">Is {r.company} hiring for this directly?</span>
          <span className="flex-1" />
          {!self && (
            <Button disabled={checkSelf.isPending} onClick={() => checkSelf.mutate()}>
              {checkSelf.isPending ? 'Checking…' : `Check ${r.company}'s board · free`}
            </Button>
          )}
          <button
            className="text-xs text-ink-3 hover:underline"
            disabled={agency.isPending}
            onClick={() => agency.mutate(true)}
            title={`${r.company} is the agency, not the employer`}
          >
            {r.company} is an agency
          </button>
        </div>
        {self && <Candidate row={r} c={self} onDone={done} onChanged={onChanged} />}
        <ErrorText error={checkSelf.error ?? agency.error} />
      </div>
    );
  }

  const running = find.isPending || runs.some((x) => !x.finishedAt);
  return (
    <div className="space-y-3 rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Who is {r.company} recruiting for?</span>
        <span className="flex-1" />
        <Button
          variant={data.aiDone ? 'ghost' : 'primary'}
          disabled={running}
          onClick={() => find.mutate(data.aiDone)}
          title={`Web search for the original posting (${data.model}, up to 5 searches). Runs once per job; the answer is kept.`}
        >
          {running
            ? 'Searching…'
            : `${data.aiDone ? 'Search again' : 'Find client'} · ~${cents(data.estimateUsd)}`}
        </Button>
        <button
          className="text-xs text-ink-3 hover:underline"
          disabled={agency.isPending}
          onClick={() => agency.mutate(false)}
          title={`${r.company} is the employer itself`}
        >
          Not an agency
        </button>
      </div>

      {lookup.result.clues.length > 0 && (
        <div>
          <div className="text-xs text-ink-3">What the email says about the client</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-2">
            {lookup.result.clues.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      {runs.map((x) => (
        <LiveRun key={x.id} run={x} showLabel />
      ))}

      {candidates.length > 0 ? (
        <div className="space-y-2">
          {candidates.map((c) => (
            <Candidate key={c.company} row={r} c={c} onDone={done} onChanged={onChanged} />
          ))}
        </div>
      ) : (
        <p className="text-ink-3">
          No likely client yet.{' '}
          {data.aiDone
            ? 'The web search found nothing credible.'
            : 'Find client searches the web for the original posting.'}
        </p>
      )}
      {lookup.result.notes && <p className="text-xs text-ink-3">{lookup.result.notes}</p>}

      <ManualClient row={r} onDone={done} />
      <ErrorText error={find.error ?? agency.error} />
    </div>
  );
}

/** One likely client: evidence, and what its own board shows. */
function Candidate({
  row: r,
  c,
  onDone,
  onChanged,
}: {
  row: ApplicationRow;
  c: ClientCandidate;
  onDone: (v: ClientView) => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const recheck = useMutation({
    mutationFn: (careersUrl?: string) =>
      api.recheckClient(r.id, { company: c.company, careersUrl: careersUrl || null }),
    onSuccess: onDone,
  });
  const dismiss = useMutation({
    mutationFn: () => api.dismissClient(r.id, c.company),
    onSuccess: onDone,
  });
  const adopt = useMutation({
    mutationFn: (postingUrl: string) =>
      api.adoptClientPosting(r.id, { url: postingUrl, company: c.company }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['client', r.id] });
      onChanged();
    },
  });
  const d = c.direct;
  return (
    <div className="rounded-md bg-surface-2/40 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{c.company}</span>
        <span className={cx('rounded px-1.5 py-0.5 text-xs', CONFIDENCE_TONE[c.confidence])}>
          {c.confidence}
        </span>
        <span className="text-xs text-ink-3">
          {c.via === 'ai' ? 'web search' : c.via === 'manual' ? 'you' : 'your tracker'}
        </span>
        <span className="flex-1" />
        <button
          className="text-xs text-ink-3 hover:underline"
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate()}
        >
          Not it
        </button>
      </div>
      {c.evidence.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-ink-2">
          {c.evidence.map((e) => (
            <li key={e.text}>
              {e.text}{' '}
              {e.url && (
                <a
                  href={e.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent hover:underline"
                >
                  source ↗
                </a>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 text-xs">
        {!d ? (
          <span className="text-ink-3">Their own board hasn't been checked.</span>
        ) : d.status === 'match' ? (
          <div className="space-y-1">
            <div className="font-medium text-good">Hiring directly:</div>
            {d.matches.map((m) => (
              <div key={m.url} className="flex flex-wrap items-center gap-2">
                <a
                  href={m.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent hover:underline"
                >
                  {m.title} ↗
                </a>
                {m.location && <span className="text-ink-3">{m.location}</span>}
                {m.copied != null && m.copied >= 0.15 && (
                  <span
                    className="text-good"
                    title="Share of the email's wording this posting repeats"
                  >
                    {Math.round(m.copied * 100)}% same wording
                  </span>
                )}
                {m.applicationId === r.id ? (
                  <span className="text-ink-3">(this job)</span>
                ) : (
                  r.status === 'Screening' && (
                    <Button
                      className="px-2 py-0.5 text-xs"
                      variant="primary"
                      disabled={adopt.isPending}
                      onClick={() => adopt.mutate(m.url)}
                      title={`Adds this posting to Screening under ${c.company} and passes ${r.company}'s lead as a duplicate`}
                    >
                      {m.applicationId
                        ? 'Already tracked · pass this one'
                        : 'Add direct & pass this'}
                    </Button>
                  )
                )}
              </div>
            ))}
          </div>
        ) : (
          <span className={d.status === 'error' ? 'text-warn' : 'text-ink-2'}>
            {d.status === 'none' ? 'Not posted on their own board. ' : ''}
            {d.note}
          </span>
        )}
        {d?.boardUrl && (
          <a
            href={d.boardUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-2 text-accent hover:underline"
          >
            board ↗
          </a>
        )}
      </div>

      <form
        className="mt-2 flex flex-wrap items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          recheck.mutate(url.trim() || undefined);
        }}
      >
        {(!d || d.status === 'no_board' || d.status === 'error') && (
          <Input
            className="w-72 py-0.5 text-xs"
            placeholder="Their careers page or a job posting address"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        )}
        <Button
          type="submit"
          variant="ghost"
          className="px-2 py-0.5 text-xs"
          disabled={recheck.isPending}
        >
          {recheck.isPending ? 'Checking…' : d ? 'Check again · free' : 'Check their board · free'}
        </Button>
      </form>
      <ErrorText error={recheck.error ?? dismiss.error ?? adopt.error} />
      {adopt.data && (
        <p className="mt-1 text-xs text-good">
          {adopt.data.existing ? 'Already in your tracker' : 'Added to Screening'} at{' '}
          {adopt.data.company}; this lead is passed.
        </p>
      )}
    </div>
  );
}

/** "I know the client": a name, and its careers page if you have it. Free. */
function ManualClient({
  row: r,
  onDone,
}: {
  row: ApplicationRow;
  onDone: (v: ClientView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [company, setCompany] = useState('');
  const [careersUrl, setCareersUrl] = useState('');
  const add = useMutation({
    mutationFn: () =>
      api.addClient(r.id, { company: company.trim(), careersUrl: careersUrl.trim() || null }),
    onSuccess: (v) => {
      onDone(v);
      setOpen(false);
      setCompany('');
      setCareersUrl('');
    },
  });
  if (!open)
    return (
      <button className="text-xs text-accent hover:underline" onClick={() => setOpen(true)}>
        I know the client
      </button>
    );
  return (
    <form
      className="flex flex-wrap items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (company.trim()) add.mutate();
      }}
    >
      <Input
        autoFocus
        className="w-44 py-0.5 text-xs"
        placeholder="Company"
        value={company}
        onChange={(e) => setCompany(e.target.value)}
      />
      <Input
        className="w-64 py-0.5 text-xs"
        placeholder="Careers page or posting (optional)"
        value={careersUrl}
        onChange={(e) => setCareersUrl(e.target.value)}
      />
      <Button
        type="submit"
        className="px-2 py-0.5 text-xs"
        disabled={add.isPending || !company.trim()}
      >
        {add.isPending ? 'Checking…' : 'Add & check their board'}
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="px-2 py-0.5 text-xs"
        onClick={() => setOpen(false)}
      >
        Cancel
      </Button>
      <ErrorText error={add.error} />
    </form>
  );
}
