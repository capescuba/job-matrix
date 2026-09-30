import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type ProfileResponse } from '../api.ts';
import { AiSettings } from '../components/AiSettings.tsx';
import { CareerProfileCard } from '../components/CareerProfileCard.tsx';
import { LinkedInCard } from '../components/LinkedInCard.tsx';
import { CriteriaEditor } from '../components/CriteriaEditor.tsx';
import { Button, Card, ErrorText, Input, cx } from '../components/ui.tsx';

const TABS = [
  ['about', 'About you'],
  ['criteria', 'Criteria'],
  ['settings', 'Settings'],
] as const;
type Tab = (typeof TABS)[number][0];

/**
 * Who you are (resume, LinkedIn, career profile), what you want (criteria) and how the AI is
 * set up, one tab each.
 */
export default function ProfilePage() {
  const { data, error } = useQuery({ queryKey: ['profile'], queryFn: api.getProfile });
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.find(([key]) => key === params.get('tab'))?.[0] ?? 'about';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold">Profile</h1>
        <div className="flex rounded-md border border-border p-0.5">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              onClick={() => setParams(key === 'about' ? {} : { tab: key })}
              className={cx(
                'rounded px-3 py-1 text-sm',
                tab === key ? 'bg-surface-2 font-medium' : 'text-ink-2',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <ErrorText error={error} />

      {tab === 'about' && (
        <>
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <Resumes resumes={data?.resumes} />
            <LinkedInCard summary={data?.linkedin} />
          </div>
          <CareerProfileCard />
        </>
      )}
      {tab === 'criteria' && <CriteriaEditor profile={data?.profile} />}
      {tab === 'settings' && (
        <div className="max-w-2xl">
          <AiSettings />
        </div>
      )}
    </div>
  );
}

/** Uploaded resumes; the default one is what fit scoring reads. */
function Resumes({ resumes }: { resumes: ProfileResponse['resumes'] | undefined }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState('');
  const [preview, setPreview] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['profile'] });

  const upload = useMutation({
    mutationFn: (file: File) => api.uploadResume(label || file.name.replace(/\.\w+$/, ''), file),
    onSuccess: () => {
      setLabel('');
      if (fileRef.current) fileRef.current.value = '';
      refresh();
    },
  });
  const makeDefault = useMutation({ mutationFn: api.setDefaultResume, onSuccess: refresh });
  const remove = useMutation({ mutationFn: api.deleteResume, onSuccess: refresh });
  const previewQuery = useQuery({
    queryKey: ['resume', preview],
    queryFn: () => api.getResume(preview!),
    enabled: preview != null,
  });

  return (
    <Card title="Resumes">
      <ul className="divide-y divide-border text-sm">
        {resumes?.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span>
              <span className="font-medium">{r.label}</span>
              {r.isDefault && (
                <span
                  className="ml-2 rounded-full border border-accent/40 px-2 py-0.5 text-xs text-accent"
                  title="Used for fit scoring"
                >
                  Default
                </span>
              )}
              <span className="ml-2 text-xs text-ink-3">{r.createdAt.slice(0, 10)}</span>
            </span>
            <span className="flex gap-1">
              <Button variant="ghost" onClick={() => setPreview(preview === r.id ? null : r.id)}>
                {preview === r.id ? 'Hide' : 'View'}
              </Button>
              {!r.isDefault && (
                <Button variant="ghost" onClick={() => makeDefault.mutate(r.id)}>
                  Make default
                </Button>
              )}
              <Button
                variant="danger"
                onClick={() =>
                  confirm(`Delete "${r.label}"? Fit scores made with it are deleted too.`) &&
                  remove.mutate(r.id)
                }
              >
                Delete
              </Button>
            </span>
          </li>
        ))}
        {resumes?.length === 0 && <li className="py-1.5 text-ink-3">No resume uploaded yet.</li>}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input
          className="min-w-40 flex-1"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label for a new resume (optional)"
          aria-label="Label for a new resume"
        />
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.docx,.txt,.md"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])}
        />
        <Button
          disabled={upload.isPending}
          onClick={() => fileRef.current?.click()}
          title="PDF, DOCX, TXT or MD"
        >
          {upload.isPending ? 'Uploading…' : 'Upload'}
        </Button>
      </div>
      <ErrorText error={upload.error} />
      {preview != null && (
        <pre className="mt-4 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface-2 p-3 text-xs">
          {previewQuery.data?.rawText ?? 'Loading…'}
        </pre>
      )}
    </Card>
  );
}
