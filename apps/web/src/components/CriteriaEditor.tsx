import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ProfileListKey } from '@jm/shared';
import { api, type ProfileResponse } from '../api.ts';
import { Button, Card, ErrorText, Field, Input, Textarea } from './ui.tsx';

const SECTIONS: { key: ProfileListKey; label: string; hint: string; rows: number }[] = [
  {
    key: 'mustHaves',
    label: 'Must-haves',
    hint: 'Filters: a job that clearly fails one shows "Fails: …" whatever its score.',
    rows: 5,
  },
  {
    key: 'dealBreakers',
    label: 'Deal-breakers',
    hint: 'Filters: a job that triggers one is marked as failing.',
    rows: 6,
  },
  {
    key: 'strongPluses',
    label: 'Strong pluses',
    hint: 'Raise the upside and skills scores.',
    rows: 5,
  },
  { key: 'niceToHaves', label: 'Nice-to-haves', hint: 'Small bumps to upside.', rows: 3 },
  {
    key: 'knownGaps',
    label: 'Known gaps',
    hint: "Score down, don't auto-reject. Tracked across jobs on the Dashboard.",
    rows: 3,
  },
];

type Form = Record<ProfileListKey | 'goals' | 'minBase', string>;

const toForm = (p: ProfileResponse['profile'] | undefined): Form => ({
  goals: p?.goals ?? '',
  minBase: p?.minBase ? String(p.minBase) : '',
  mustHaves: p?.mustHaves ?? '',
  dealBreakers: p?.dealBreakers ?? '',
  strongPluses: p?.strongPluses ?? '',
  niceToHaves: p?.niceToHaves ?? '',
  knownGaps: p?.knownGaps ?? '',
});

/** Background, target and the criteria the fit scoring applies — one criterion per line. */
export function CriteriaEditor({ profile }: { profile: ProfileResponse['profile'] | undefined }) {
  const qc = useQueryClient();
  const [f, setF] = useState<Form>(() => toForm(profile));
  useEffect(() => setF(toForm(profile)), [profile]);
  const dirty = JSON.stringify(f) !== JSON.stringify(toForm(profile));

  const save = useMutation({
    mutationFn: () =>
      api.updateProfile({
        ...f,
        minBase: f.minBase.trim() ? Number(f.minBase.replace(/[^\d]/g, '')) : null,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profile'] }),
  });
  const set = (k: keyof Form) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));

  return (
    <Card
      title="Goals & criteria"
      actions={
        <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      }
    >
      <p className="mb-3 text-sm text-ink-2">
        Used by every fit assessment. Changing these means jobs get re-scored the next time you
        score them.
      </p>
      <div className="grid gap-4 md:grid-cols-[1fr_12rem]">
        <Field label="Background & target roles">
          <Textarea rows={6} value={f.goals} onChange={set('goals')} />
        </Field>
        <Field label="Minimum base salary (USD)">
          <Input
            inputMode="numeric"
            value={f.minBase}
            onChange={set('minBase')}
            placeholder="200000"
          />
          <span className="mt-1 block text-xs text-ink-3">
            Checked against the posted range. Unlisted ranges are flagged.
          </span>
        </Field>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {SECTIONS.map((s) => (
          <Field key={s.key} label={s.label}>
            <Textarea rows={s.rows} value={f[s.key]} onChange={set(s.key)} />
            <span className="mt-1 block text-xs text-ink-3">{s.hint}</span>
          </Field>
        ))}
      </div>
      <ErrorText error={save.error} />
    </Card>
  );
}
