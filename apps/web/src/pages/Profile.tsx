import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '../api.ts';
import { AiSettings } from '../components/AiSettings.tsx';
import { CriteriaEditor } from '../components/CriteriaEditor.tsx';
import { Button, Card, ErrorText, Field, Input } from '../components/ui.tsx';

export default function ProfilePage() {
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ['profile'], queryFn: api.getProfile });
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
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Profile</h1>
      <ErrorText error={error} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Resumes">
          <p className="mb-3 text-sm text-ink-2">
            The default resume is used for fit scoring. PDF, DOCX, TXT or MD.
          </p>
          <ul className="mb-4 divide-y divide-border text-sm">
            {data?.resumes.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium">{r.label}</span>
                  {r.isDefault && (
                    <span className="ml-2 rounded-full border border-accent/40 px-2 py-0.5 text-xs text-accent">
                      Default
                    </span>
                  )}
                  <span className="ml-2 text-xs text-ink-3">
                    {r.chars.toLocaleString()} chars · {r.createdAt.slice(0, 10)}
                  </span>
                </span>
                <span className="flex gap-1">
                  <Button
                    variant="ghost"
                    onClick={() => setPreview(preview === r.id ? null : r.id)}
                  >
                    {preview === r.id ? 'Hide' : 'View text'}
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
            {data?.resumes.length === 0 && (
              <li className="py-2 text-ink-3">No resume uploaded yet.</li>
            )}
          </ul>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Label (optional)" className="flex-1">
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. TPM – infra focus"
              />
            </Field>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.docx,.txt,.md"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])}
            />
            <Button
              variant="primary"
              disabled={upload.isPending}
              onClick={() => fileRef.current?.click()}
            >
              {upload.isPending ? 'Uploading…' : 'Upload resume'}
            </Button>
          </div>
          <ErrorText error={upload.error} />
          {preview != null && (
            <pre className="mt-4 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface-2 p-3 text-xs">
              {previewQuery.data?.rawText ?? 'Loading…'}
            </pre>
          )}
        </Card>
        <AiSettings />
      </div>
      <CriteriaEditor profile={data?.profile} />
    </div>
  );
}
