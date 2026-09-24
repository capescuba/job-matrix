import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.ts';
import { Button, Card, ErrorText, Field, Input, Select } from './ui.tsx';

const MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5 — best quality' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — cheaper, faster' },
];

/** Anthropic API key + model, saved to the local .env by the server. */
export function AiSettings() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const [key, setKey] = useState('');

  const save = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: (s) => {
      qc.setQueryData(['settings'], s);
      qc.invalidateQueries({ queryKey: ['profile'] });
      setKey('');
    },
  });

  return (
    <Card title="AI settings">
      <p className="mb-3 text-sm text-ink-2">
        Fit scoring uses the Anthropic API. Get a key at{' '}
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
      <Field label="Model" className="mt-3 max-w-sm">
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
