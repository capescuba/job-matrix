import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { REMOTE_TYPES, STATUSES, type QuickAddInput } from '@jm/shared';
import { api } from '../api.ts';
import { Button, ErrorText, Field, Input, Modal, Select, Textarea } from './ui.tsx';

const empty = {
  company: '',
  title: '',
  url: '',
  location: '',
  remoteType: '',
  status: 'Saved',
  descriptionText: '',
};

export function QuickAdd({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState(empty);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const create = useMutation({
    mutationFn: (input: QuickAddInput) => api.createApplication(input),
    onSuccess: ({ id }) => {
      qc.invalidateQueries({ queryKey: ['applications'] });
      setForm(empty);
      onClose();
      navigate(`/applications/${id}`);
    },
  });

  // Pre-fills empty fields (and the description) from the posting URL.
  const fetchPosting = useMutation({
    mutationFn: () => api.fetchJob(form.url),
    onSuccess: (r) =>
      setForm((f) => ({
        ...f,
        title: f.title || r.title || '',
        location: f.location || r.location || '',
        remoteType: f.remoteType || r.remoteType || '',
        descriptionText: r.descriptionText,
      })),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({
      ...form,
      remoteType: (form.remoteType || null) as QuickAddInput['remoteType'],
      status: form.status as QuickAddInput['status'],
    });
  };

  return (
    <Modal open={open} onClose={onClose} title="Add job">
      <form onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label="Company *">
          <Input required autoFocus value={form.company} onChange={set('company')} />
        </Field>
        <Field label="Title *">
          <Input
            required
            value={form.title}
            onChange={set('title')}
            placeholder="Senior Technical Program Manager"
          />
        </Field>
        <Field label="Job URL" className="col-span-2">
          <div className="flex gap-2">
            <Input type="url" value={form.url} onChange={set('url')} placeholder="https://…" />
            <Button
              type="button"
              disabled={!form.url.trim() || fetchPosting.isPending}
              onClick={() => fetchPosting.mutate()}
              title="Fill the details and description from this link"
            >
              {fetchPosting.isPending ? 'Fetching…' : 'Fetch'}
            </Button>
          </div>
          <ErrorText error={fetchPosting.error} />
        </Field>
        <Field label="Location">
          <Input value={form.location} onChange={set('location')} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Remote">
            <Select value={form.remoteType} onChange={set('remoteType')}>
              <option value="">—</option>
              {REMOTE_TYPES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select value={form.status} onChange={set('status')}>
              {STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Field
          label="Job description (paste the full text — used for fit scoring)"
          className="col-span-2"
        >
          <Textarea rows={10} value={form.descriptionText} onChange={set('descriptionText')} />
        </Field>
        <div className="col-span-2 flex items-center justify-end gap-2">
          <ErrorText error={create.error} />
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            Add
          </Button>
        </div>
      </form>
    </Modal>
  );
}
