import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Button, Card, ErrorText, Textarea } from './ui.tsx';

const money = (usd: number | null | undefined) =>
  usd == null ? '' : usd < 1 ? `~${Math.round(usd * 100)}¢` : `~$${usd.toFixed(2)}`;

/**
 * The career profile: a detailed inventory built from your resume + LinkedIn (one AI call, only
 * when you press Build), which fit scoring reads next to the resume. You can edit it.
 */
export function CareerProfileCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['career-profile'], queryFn: api.careerProfile });
  const [draft, setDraft] = useState('');
  useEffect(() => setDraft(data?.careerProfile ?? ''), [data?.careerProfile]);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['career-profile'] });
    qc.invalidateQueries({ queryKey: ['profile'] });
    qc.invalidateQueries({ queryKey: ['usage'] });
  };

  const build = useMutation({ mutationFn: api.buildCareerProfile, onSuccess: refresh });
  const save = useMutation({
    mutationFn: () => api.updateProfile({ careerProfile: draft.trim() || null }),
    onSuccess: refresh,
  });
  const rescore = useMutation({
    mutationFn: api.rescoreStale,
    onSuccess: (s) => {
      qc.setQueryData(['fitBatch'], s);
      refresh();
    },
  });
  const { data: batch } = useQuery({
    queryKey: ['fitBatch'],
    queryFn: api.scoreAllStatus,
    refetchInterval: (q) => (q.state.data?.running ? 1500 : false),
  });
  useEffect(() => {
    if (batch && !batch.running) refresh();
  }, [batch?.running]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return null;
  const dirty = draft.trim() !== (data.careerProfile ?? '').trim();
  const canBuild = data.hasResume || data.hasLinkedIn;
  return (
    <Card
      title="Career profile"
      actions={
        <Button
          variant={data.careerProfile ? 'secondary' : 'primary'}
          disabled={!canBuild || build.isPending}
          onClick={() =>
            (!data.careerProfile ||
              confirm(
                'Rebuild the career profile from your resume and LinkedIn? Your edits to the current one are replaced.',
              )) &&
            build.mutate()
          }
        >
          {build.isPending
            ? 'Building… (about a minute)'
            : `${data.careerProfile ? 'Rebuild' : 'Build career profile'} · ${money(data.buildUsd)}`}
        </Button>
      }
    >
      <p className="mb-3 text-sm text-ink-2">
        An inventory of your career built from your resume
        {data.hasLinkedIn ? ' and LinkedIn profile' : ''}.{' '}
        <span
          className="cursor-help underline decoration-dotted"
          title="Every role with its scope, programs, numbers and skills. Fit scoring reads it next to your resume, and application answers use it too. It is built only when you press the button, and you can edit it freely."
        >
          What is it for?
        </span>
      </p>
      {!data.hasLinkedIn && (
        <p className="mb-2 text-sm text-warn">
          Import your LinkedIn profile first for the full detail.
        </p>
      )}
      {data.linkedinNewer && data.careerProfile && (
        <p className="mb-2 text-sm text-warn">
          Your LinkedIn import is newer than this profile — rebuild to include it.
        </p>
      )}
      <ErrorText error={build.error} />

      {data.careerProfile != null && (
        <>
          <Textarea
            rows={18}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="font-mono text-xs"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate()}
            >
              Save edits
            </Button>
            {dirty && (
              <Button variant="ghost" onClick={() => setDraft(data.careerProfile ?? '')}>
                Undo edits
              </Button>
            )}
            {data.builtAt && (
              <span className="text-xs text-ink-3">
                Built{' '}
                {new Date(data.builtAt).toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </span>
            )}
          </div>
          <ErrorText error={save.error} />
        </>
      )}

      {batch?.running ? (
        <p className="mt-3 text-sm text-accent">
          Re-scoring… {batch.done} of {batch.total} done
        </p>
      ) : (
        data.careerProfile &&
        data.staleJobs > 0 &&
        !dirty && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 p-2 text-sm">
            <span>
              {data.staleJobs} open job{data.staleJobs === 1 ? ' was' : 's were'} scored before your
              current profile.
            </span>
            <Button
              onClick={() =>
                confirm(
                  `Re-score ${data.staleJobs} open job${data.staleJobs === 1 ? '' : 's'} with your career profile? About ${money(data.rescoreUsd)} in total.`,
                ) && rescore.mutate()
              }
              disabled={rescore.isPending}
            >
              Re-score them · {money(data.rescoreUsd)}
            </Button>
          </div>
        )
      )}
      <ErrorText error={rescore.error} />
    </Card>
  );
}
