import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.ts';
import { Button, Card } from './ui.tsx';

/** Answers drafted by the Chrome extension's application helper for this job's form. */
export function ApplicationAnswers({ applicationId }: { applicationId: number }) {
  const qc = useQueryClient();
  const { data = [] } = useQuery({
    queryKey: ['answers', applicationId],
    queryFn: () => api.listAnswers(applicationId),
  });
  const remove = useMutation({
    mutationFn: api.deleteAnswer,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['answers', applicationId] }),
  });
  const [copied, setCopied] = useState<number | null>(null);
  if (!data.length) return null;
  return (
    <Card title={`Application answers (${data.length})`} className="mt-4">
      <ul className="space-y-4 text-sm">
        {data.map((a) => (
          <li key={a.id}>
            <div className="font-medium">{a.question}</div>
            <p className="mt-1 whitespace-pre-wrap text-ink-2">{a.answer}</p>
            <div className="mt-1 flex items-center gap-2 text-xs text-ink-3">
              <span>{new Date(a.createdAt).toLocaleDateString()}</span>
              <Button
                variant="ghost"
                className="px-1.5 py-0.5 text-xs"
                onClick={() => navigator.clipboard.writeText(a.answer).then(() => setCopied(a.id))}
              >
                {copied === a.id ? 'Copied' : 'Copy'}
              </Button>
              <Button
                variant="ghost"
                className="px-1.5 py-0.5 text-xs text-ink-3"
                onClick={() => confirm('Delete this saved answer?') && remove.mutate(a.id)}
              >
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
