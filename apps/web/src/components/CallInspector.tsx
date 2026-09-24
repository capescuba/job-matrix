import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { MODEL_PRICING } from '@jm/shared';
import { api } from '../api.ts';
import { Button, ErrorText, Modal, cx } from './ui.tsx';

type Tab = 'system' | 'prompt' | 'thinking' | 'response' | 'raw';

interface RequestBody {
  model?: string;
  system?: string;
  messages?: { role: string; content: string }[];
  output_config?: unknown;
  [k: string]: unknown;
}

const pretty = (s: string | null | undefined) => {
  if (!s) return '';
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
};

/** The exact request sent to the model and what came back, for one logged call. */
export function CallInspector({ usageId, onClose }: { usageId: number; onClose: () => void }) {
  const { data, error } = useQuery({
    queryKey: ['call', usageId],
    queryFn: () => api.getCall(usageId),
  });
  const [tab, setTab] = useState<Tab>('prompt');
  const [copied, setCopied] = useState(false);

  const req = (data?.requestJson ?? {}) as RequestBody;
  const prompt = req.messages?.map((m) => m.content).join('\n\n') ?? '';
  const { system: _s, messages: _m, ...params } = req;
  const content: Record<Tab, string> = {
    system: req.system ?? '',
    prompt,
    thinking: data?.thinkingText || '(No thinking summary was returned for this call.)',
    response: pretty(data?.responseText),
    raw: JSON.stringify(data?.requestJson ?? null, null, 2),
  };
  const tabs: { key: Tab; label: string }[] = [
    { key: 'prompt', label: 'Prompt' },
    { key: 'system', label: 'System prompt' },
    { key: 'thinking', label: 'Thinking' },
    { key: 'response', label: 'Response' },
    { key: 'raw', label: 'Raw request' },
  ];

  return (
    <Modal open onClose={onClose} title="AI request">
      <ErrorText error={error} />
      {data && (
        <>
          <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <Meta label="Model" value={MODEL_PRICING[data.model]?.label ?? data.model} />
            <Meta
              label="Duration"
              value={data.durationMs ? `${(data.durationMs / 1000).toFixed(1)}s` : '—'}
            />
            <Meta
              label="Tokens"
              value={`${(data.inputTokens + data.cacheReadTokens + data.cacheWriteTokens).toLocaleString()} in · ${data.outputTokens.toLocaleString()} out`}
            />
            <Meta label="Cost" value={data.costUsd != null ? `$${data.costUsd.toFixed(3)}` : '—'} />
            <Meta label="When" value={new Date(data.at).toLocaleString()} />
            <Meta label="Stop reason" value={data.stopReason ?? '—'} />
            <Meta
              label="Settings"
              value={[
                ...Object.entries(params)
                  .filter(([k]) => k !== 'output_config' && k !== 'model')
                  .map(
                    ([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`,
                  ),
                `effort: ${(req.output_config as { effort?: string } | undefined)?.effort ?? 'default'}`,
              ].join(', ')}
            />
            {data.error && <Meta label="Error" value={data.error} bad />}
          </dl>
          {!data.requestJson ? (
            <p className="text-sm text-ink-3">
              This call was made before request logging was added.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1 border-b border-border">
                {tabs.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setTab(t.key)}
                    className={cx(
                      '-mb-px border-b-2 px-2.5 py-1.5 text-sm',
                      tab === t.key
                        ? 'border-accent font-medium text-ink'
                        : 'border-transparent text-ink-2 hover:text-ink',
                    )}
                  >
                    {t.label}
                  </button>
                ))}
                <Button
                  variant="ghost"
                  className="ml-auto px-2 py-0.5 text-xs"
                  onClick={() => {
                    void navigator.clipboard.writeText(content[tab]).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    });
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <pre
                className={cx(
                  'mt-2 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-3 text-xs leading-relaxed',
                  (tab === 'response' || tab === 'raw') && 'font-mono',
                )}
              >
                {content[tab]}
              </pre>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

function Meta({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-3">{label}</dt>
      <dd className={cx('truncate', bad ? 'text-bad' : 'text-ink')} title={value}>
        {value}
      </dd>
    </div>
  );
}
