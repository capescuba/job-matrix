import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.ts';
import { Button, Card, ErrorText, Input } from './ui.tsx';

/**
 * Other names the company goes by — a new owner after an acquisition, a parent brand, an old
 * name — so emails and job pages that use them match this company.
 */
export function CompanyAliases({
  companyId,
  companyName,
}: {
  companyId: number;
  companyName: string;
}) {
  const qc = useQueryClient();
  const [alias, setAlias] = useState('');
  const { data: aliases = [] } = useQuery({
    queryKey: ['aliases', companyId],
    queryFn: () => api.aliases(companyId),
  });
  const done = () => {
    qc.invalidateQueries({ queryKey: ['aliases', companyId] });
    qc.invalidateQueries({ queryKey: ['email-updates'] });
    qc.invalidateQueries({ queryKey: ['mail-status'] });
  };
  const add = useMutation({
    mutationFn: () => api.addAlias(companyId, alias.trim()),
    onSuccess: () => {
      setAlias('');
      done();
    },
  });
  const remove = useMutation({ mutationFn: api.removeAlias, onSuccess: done });

  return (
    <Card title="Also known as" className="mt-4">
      <p className="mb-2 text-xs text-ink-3">
        Other names {companyName} goes by (a new owner, a parent brand, an old name). Emails and job
        pages that use them are matched to {companyName}.
      </p>
      {aliases.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {aliases.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-sm"
            >
              {a.alias}
              <button
                className="text-ink-3 hover:text-bad"
                aria-label={`Remove ${a.alias}`}
                onClick={() => remove.mutate(a.id)}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (alias.trim()) add.mutate();
        }}
      >
        <Input
          className="max-w-xs"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          placeholder="e.g. SpaceXAI"
        />
        <Button type="submit" disabled={!alias.trim() || add.isPending}>
          Add
        </Button>
      </form>
      <ErrorText error={add.error ?? remove.error} />
    </Card>
  );
}
