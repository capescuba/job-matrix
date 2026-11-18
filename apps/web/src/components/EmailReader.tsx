import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, type MailReading } from '../api.ts';
import { Button, ErrorText } from './ui.tsx';

type Address = MailReading['from'];

const who = (a: Address) =>
  a.name && a.address ? `${a.name} <${a.address}>` : a.name || a.address;
const list = (xs: Address[]) => xs.map(who).filter(Boolean).join(', ');
const kb = (n: number) =>
  n < 1024 * 1024
    ? `${Math.max(1, Math.round(n / 1024))} KB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Pictures the email loads from the web (and so tell the sender it was opened). */
const REMOTE = /<img[^>]+src\s*=\s*["']?\s*(https?:)?\/\/|url\(\s*["']?\s*(https?:)?\/\//i;

/**
 * The email as a page of its own, in a frame that runs none of its scripts and can't reach the
 * app. Web images stay off until asked for; links open in a new tab.
 */
function emailDoc(html: string, images: boolean) {
  const web = images ? ' https: http:' : '';
  const csp = `default-src 'none'; img-src data:${web}; style-src 'unsafe-inline'${web}; font-src data:${web}`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank">
<style>html{background:#fff;color:#1f2328;font:14px/1.5 system-ui,sans-serif}body{margin:16px;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>
</head><body>${html}</body></html>`;
}

/** The email an Outlook link names, read in a drawer on the right. */
export function EmailReader({
  link,
  subject,
  onClose,
}: {
  link: string;
  /** Shown while the email loads. */
  subject?: string | null;
  onClose: () => void;
}) {
  const [images, setImages] = useState(false);
  const queryClient = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ['email', link],
    queryFn: () => api.readEmail(link),
    staleTime: 5 * 60_000,
    retry: false,
  });
  // Found again after Outlook moved it: the pages behind still hold its old link.
  const moved = !!data?.webLink && data.webLink !== link;
  useEffect(() => {
    if (moved) void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'email' });
  }, [moved, queryClient]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const html = data?.body.type === 'html' ? data.body.content : null;
  const hasRemote = useMemo(() => (html ? REMOTE.test(html) : false), [html]);
  const outlook = data?.webLink ?? link;

  // A portal: the drawer sits on the page, not inside the card that opened it.
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onMouseDown={onClose}>
      <aside
        className="flex h-full w-full max-w-3xl flex-col border-l border-border bg-surface shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
        aria-label="Email"
      >
        <header className="space-y-1 border-b border-border px-4 py-3">
          <div className="flex items-start gap-2">
            <h2 className="flex-1 font-semibold">{data?.subject || subject || '(no subject)'}</h2>
            <Button variant="ghost" onClick={onClose} aria-label="Close">
              ✕
            </Button>
          </div>
          {data && (
            <div className="space-y-0.5 text-xs text-ink-2">
              <p>
                <span className="text-ink-3">From</span> {who(data.from)}
              </p>
              {data.to.length > 0 && (
                <p>
                  <span className="text-ink-3">To</span> {list(data.to)}
                </p>
              )}
              {data.cc.length > 0 && (
                <p>
                  <span className="text-ink-3">Cc</span> {list(data.cc)}
                </p>
              )}
              <p className="text-ink-3">
                {new Date(data.receivedAt).toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3 pt-1 text-xs">
            {hasRemote && (
              <button className="text-ink-3 hover:text-accent" onClick={() => setImages(!images)}>
                {images ? 'Hide web images' : 'Show web images'}
              </button>
            )}
            {outlook && (
              <a
                href={outlook}
                target="_blank"
                rel="noreferrer"
                className="text-ink-3 hover:text-accent"
              >
                Open in Outlook ↗
              </a>
            )}
          </div>
          {data && data.attachments.length > 0 && (
            <p className="text-xs text-ink-3">
              📎 {data.attachments.map((a) => `${a.name} (${kb(a.size)})`).join(', ')} — download in
              Outlook
            </p>
          )}
        </header>
        <div className="min-h-0 flex-1">
          {isLoading && <p className="p-4 text-sm text-ink-3">Opening the email…</p>}
          {error && (
            <div className="p-4">
              <ErrorText error={error} />
            </div>
          )}
          {html !== null && (
            <iframe
              title="Email"
              className="h-full w-full bg-white"
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
              srcDoc={emailDoc(html, images)}
            />
          )}
          {data?.body.type === 'text' && (
            <p className="h-full overflow-y-auto p-4 text-sm whitespace-pre-wrap text-ink">
              {data.body.content}
            </p>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

/**
 * A link-style button that opens the email in the reader: for the Outlook links on the Email,
 * Screening and job pages.
 */
export function ReadEmailButton({
  link,
  subject,
  children = 'Read email',
  className = 'text-ink-3 hover:text-accent',
  title,
}: {
  link: string;
  subject?: string | null;
  children?: ReactNode;
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button type="button" className={className} title={title} onClick={() => setOpen(true)}>
        {children}
      </button>
      {open && <EmailReader link={link} subject={subject} onClose={close} />}
    </>
  );
}
