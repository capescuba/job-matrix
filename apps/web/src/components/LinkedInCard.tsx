import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, type LinkedInSummary } from '../api.ts';
import { Button, Card, ErrorText, Input } from './ui.tsx';

/** The Chrome extension's fixed ID (its manifest key), which accepts messages from this app. */
const EXTENSION_ID = 'keiamknmppkefljklkaceniaafephpcf';

type ChromeRuntime = {
  sendMessage: (id: string, msg: unknown, cb: (r: unknown) => void) => void;
  lastError?: { message?: string };
};
const runtime = () =>
  (window as unknown as { chrome?: { runtime?: ChromeRuntime } }).chrome?.runtime;

/** Asks the extension; null when it isn't installed (or is an older version without this). */
function toExtension<T>(msg: unknown): Promise<T | null> {
  const rt = runtime();
  if (!rt?.sendMessage) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      rt.sendMessage(EXTENSION_ID, msg, (r) => resolve(rt.lastError ? null : ((r as T) ?? null)));
    } catch {
      resolve(null);
    }
  });
}

const kb = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

/**
 * Your LinkedIn profile: its address, and an import done by the Chrome extension in your
 * signed-in Chrome (LinkedIn won't show the full profile to the Job Matrix server).
 */
export function LinkedInCard({ summary }: { summary: LinkedInSummary | undefined }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState(summary?.url ?? '');
  const [showText, setShowText] = useState(false);
  const [extension, setExtension] = useState<'checking' | 'ok' | 'missing'>('checking');
  useEffect(() => setUrl(summary?.url ?? ''), [summary?.url]);
  useEffect(() => {
    toExtension<{ ok: boolean }>({ type: 'jm-ping' }).then((r) =>
      setExtension(r?.ok ? 'ok' : 'missing'),
    );
  }, []);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['profile'] });
    qc.invalidateQueries({ queryKey: ['career-profile'] });
    qc.invalidateQueries({ queryKey: ['linkedin-text'] });
  };

  const saveUrl = useMutation({
    mutationFn: () => api.setLinkedInUrl(url.trim() || null),
    onSuccess: refresh,
  });
  const importIt = useMutation({
    mutationFn: async () => {
      const saved = await api.setLinkedInUrl(url.trim());
      const r = await toExtension<{ ok: boolean; error?: string }>({
        type: 'jm-import-linkedin',
        url: saved.url,
      });
      if (!r)
        throw new Error(
          'The Job Matrix Chrome extension didn’t answer. Reload it in chrome://extensions and try again.',
        );
      if (!r.ok) throw new Error(r.error || 'The import failed.');
    },
    onSettled: refresh,
  });
  const clear = useMutation({ mutationFn: api.clearLinkedIn, onSuccess: refresh });
  const text = useQuery({
    queryKey: ['linkedin-text'],
    queryFn: api.linkedinText,
    enabled: showText,
  });

  const imported = summary?.importedAt;
  return (
    <Card title="LinkedIn profile">
      <p className="mb-3 text-sm text-ink-2">
        Your LinkedIn profile has far more detail than a resume. Job Matrix reads it through the
        Chrome extension, in your signed-in Chrome: a tab opens, pages through your profile (about,
        every role in full, projects, skills, certifications, recommendations) and closes.
      </p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          importIt.mutate();
        }}
      >
        <Input
          className="min-w-64 flex-1"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => url.trim() !== (summary?.url ?? '') && saveUrl.mutate()}
          placeholder="https://www.linkedin.com/in/your-name/"
        />
        <Button
          type="submit"
          variant="primary"
          disabled={!url.trim() || importIt.isPending || extension !== 'ok'}
        >
          {importIt.isPending
            ? 'Importing… (see the new tab)'
            : imported
              ? 'Import again'
              : 'Import from LinkedIn'}
        </Button>
      </form>
      {extension === 'missing' && (
        <p className="mt-2 text-sm text-warn">
          The Chrome extension isn’t reachable from here. Reload it in chrome://extensions (it needs
          version 0.2 or later), then refresh this page.
        </p>
      )}
      <ErrorText error={importIt.error ?? saveUrl.error ?? clear.error} />

      {imported && summary && (
        <div className="mt-3 space-y-2 text-sm">
          <p className="text-ink-2">
            Imported{' '}
            {new Date(imported).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}{' '}
            · {kb(summary.chars)} characters
          </p>
          <div className="flex flex-wrap gap-1.5">
            {summary.sections.map((s) => (
              <span
                key={s.key}
                className={`rounded-full border px-2 py-0.5 text-xs ${s.chars ? 'border-border text-ink-2' : 'border-border/50 text-ink-3 line-through'}`}
                title={
                  s.chars
                    ? `${s.chars.toLocaleString()} characters`
                    : 'Not on your profile (or not read)'
                }
              >
                {s.label} {s.chars ? kb(s.chars) : ''}
              </span>
            ))}
          </div>
          <div className="flex gap-1">
            <Button variant="ghost" onClick={() => setShowText(!showText)}>
              {showText ? 'Hide text' : 'View text'}
            </Button>
            <Button
              variant="danger"
              onClick={() => confirm('Remove the imported LinkedIn text?') && clear.mutate()}
            >
              Remove
            </Button>
          </div>
          {showText && (
            <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface-2 p-3 text-xs">
              {text.data?.text ?? 'Loading…'}
            </pre>
          )}
        </div>
      )}
    </Card>
  );
}
