import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.ts';
import { Button, Card, ErrorText, Field, Input, Select } from './ui.tsx';

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — best quality' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — fast, about half the cost' },
  { id: 'claude-opus-5', label: 'Claude Opus 5 — previous, costs more' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — previous Sonnet' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — cheapest, fast' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — older, weakest' },
];

const cents = (usd: number) => (usd < 1 ? `${Math.round(usd * 100)}¢` : `$${usd.toFixed(2)}`);

/** Anthropic API key + model, saved to the local .env by the server. */
export function AiSettings() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const { data: usage } = useQuery({ queryKey: ['usage'], queryFn: api.usage });
  const [key, setKey] = useState('');

  const save = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: (s) => {
      qc.setQueryData(['settings'], s);
      qc.invalidateQueries({ queryKey: ['profile'] });
      qc.invalidateQueries({ queryKey: ['usage'] });
      setKey('');
    },
  });

  return (
    <Card title="AI settings">
      <p className="mb-3 text-sm text-ink-2">
        Fit scoring and company research use the Anthropic API. Get a key at{' '}
        <a
          href="https://console.anthropic.com/settings/keys"
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
        >
          console.anthropic.com
        </a>
        . It&apos;s stored only on this PC.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ anthropicApiKey: key.trim() });
        }}
      >
        <Field
          label={data?.apiKeyHint ? `API key (saved: ${data.apiKeyHint})` : 'API key'}
          className="min-w-64 flex-1"
        >
          <Input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={data?.apiKeyHint ? 'Paste a new key to replace it' : 'sk-ant-…'}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={!key.trim() || save.isPending}>
          Save key
        </Button>
        {data?.apiKeyHint && (
          <Button
            type="button"
            variant="danger"
            onClick={() =>
              confirm('Remove the saved API key?') && save.mutate({ anthropicApiKey: null })
            }
          >
            Remove
          </Button>
        )}
      </form>
      <Field label="Fit scoring model" className="mt-3 max-w-sm">
        <Select
          value={data?.model ?? ''}
          onChange={(e) => save.mutate({ aiModel: e.target.value })}
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          {data && !MODELS.some((m) => m.id === data.model) && (
            <option value={data.model}>{data.model}</option>
          )}
        </Select>
      </Field>
      <Field label="Company research model" className="mt-3 max-w-sm">
        <Select
          value={data?.researchModelSet ? data.researchModel : ''}
          onChange={(e) => save.mutate({ aiResearchModel: e.target.value || null })}
        >
          <option value="">Same as fit scoring</option>
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          {data?.researchModelSet && !MODELS.some((m) => m.id === data.researchModel) && (
            <option value={data.researchModel}>{data.researchModel}</option>
          )}
        </Select>
      </Field>
      {usage && (
        <p className="mt-1 max-w-sm text-xs text-ink-3">
          Web research reads a lot, so it costs several times a fit score: about{' '}
          {cents(usage.forecast.researchPerCallUsd)} per company with{' '}
          {usage.forecast.researchModelLabel}. Each company is researched once; only Refresh redoes
          it.
        </p>
      )}
      <Field label="Email model (Ask AI on an unclear email)" className="mt-3 max-w-sm">
        <Select
          value={data?.emailModel ?? ''}
          onChange={(e) => save.mutate({ aiEmailModel: e.target.value })}
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          {data && !MODELS.some((m) => m.id === data.emailModel) && (
            <option value={data.emailModel}>{data.emailModel}</option>
          )}
        </Select>
      </Field>
      <p className="mt-1 max-w-sm text-xs text-ink-3">
        Only used when you press Ask AI on the Email page. Reading one email is a small job, so the
        cheapest model is plenty.
      </p>
      <Field label="Interview coach model (live hints during a call)" className="mt-3 max-w-sm">
        <Select
          value={data?.coachModel ?? ''}
          onChange={(e) => save.mutate({ aiCoachModel: e.target.value })}
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          {data && !MODELS.some((m) => m.id === data.coachModel) && (
            <option value={data.coachModel}>{data.coachModel}</option>
          )}
        </Select>
      </Field>
      <p className="mt-1 max-w-sm text-xs text-ink-3">
        Runs after each thing the interviewer says, so it needs to be quick. Sonnet 5.5 costs about
        15–25¢ for an hour-long call.
      </p>
      {data && (
        <p className="mt-1 max-w-sm text-xs text-ink-3">
          Audio engine (records and transcribes calls on this PC):{' '}
          {data.audioEngine.installed ? (
            'installed.'
          ) : (
            <>
              not installed. Run <code>scripts\install-audio-engine.ps1</code> once.
            </>
          )}
        </p>
      )}
      <Field label="Speed vs. depth" className="mt-3 max-w-sm">
        <Select
          value={data?.effort ?? 'low'}
          onChange={(e) =>
            save.mutate({ aiEffort: e.target.value as NonNullable<typeof data>['effort'] })
          }
        >
          <option value="low">Fast — quick, cheaper (recommended)</option>
          <option value="medium">Balanced</option>
          <option value="high">Thorough — slowest, most expensive</option>
        </Select>
      </Field>
      <ErrorText error={save.error} />
    </Card>
  );
}
