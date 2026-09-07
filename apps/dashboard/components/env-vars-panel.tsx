'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type EnvVar } from '@/lib/api';
import { Button, Empty, ErrorNote, Field, Input, Panel } from '@/components/ui/primitives';

/** Parses a pasted `.env` block. Comments and blank lines are skipped. */
function parseDotenv(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes, the way a shell would.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out.push({ key, value });
  }
  return out;
}

export function EnvVarsPanel({
  orgSlug,
  projectId,
  canEdit,
}: {
  orgSlug: string;
  projectId: string;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const base = `/orgs/${orgSlug}/projects/${projectId}/env`;

  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [isSecret, setIsSecret] = useState(true);
  const [bulk, setBulk] = useState('');
  const [showBulk, setShowBulk] = useState(false);

  const vars = useQuery({
    queryKey: ['env', projectId],
    queryFn: () => api.get<EnvVar[]>(base),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['env', projectId] });

  const upsert = useMutation({
    mutationFn: () => api.put<EnvVar>(base, { key, value, isSecret }),
    onSuccess: async () => {
      setKey('');
      setValue('');
      await invalidate();
    },
  });

  const bulkSet = useMutation({
    mutationFn: () => {
      const parsed = parseDotenv(bulk);
      if (parsed.length === 0) throw new Error('Nothing to import — expected KEY=value lines');
      // A pasted .env is almost always credentials; default them to secret.
      return api.put<EnvVar[]>(`${base}/bulk`, {
        vars: parsed.map((v) => ({ ...v, isSecret: true })),
      });
    },
    onSuccess: async () => {
      setBulk('');
      setShowBulk(false);
      await invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (varKey: string) => api.del<void>(`${base}/${encodeURIComponent(varKey)}`),
    onSuccess: invalidate,
  });

  return (
    <Panel
      title="Environment variables"
      description="Encrypted at rest with AES-256-GCM. Secret values are never returned by the API."
      actions={
        canEdit ? (
          <Button variant="secondary" onClick={() => setShowBulk((v) => !v)}>
            {showBulk ? 'Cancel import' : 'Paste .env'}
          </Button>
        ) : null
      }
    >
      {canEdit && showBulk && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            bulkSet.mutate();
          }}
          className="mb-5 rounded-lg border border-[#232734] bg-[#0d0f16] p-4"
        >
          <Field label="Paste a .env block" hint="Every imported value is stored as a secret.">
            <textarea
              rows={5}
              value={bulk}
              onChange={(e) => setBulk(e.target.value)}
              placeholder={'DATABASE_URL=postgres://…\nAPI_TOKEN=abc123'}
              className="w-full rounded-lg border border-[#2c3142] bg-[#0d0f16] px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500/60"
            />
          </Field>
          <div className="mt-3 flex items-center gap-3">
            <Button type="submit" disabled={bulkSet.isPending}>
              {bulkSet.isPending ? 'Importing…' : `Import ${parseDotenv(bulk).length} var(s)`}
            </Button>
          </div>
          <ErrorNote error={bulkSet.error} />
        </form>
      )}

      {canEdit && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            upsert.mutate();
          }}
          className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-[#232734] bg-[#0d0f16] p-4"
        >
          <div className="w-52">
            <Field label="Key">
              <Input
                required
                value={key}
                onChange={(e) => setKey(e.target.value.toUpperCase())}
                placeholder="DATABASE_URL"
                className="font-mono"
              />
            </Field>
          </div>
          <div className="min-w-56 flex-1">
            <Field label="Value">
              <Input
                required
                type={isSecret ? 'password' : 'text'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="value"
                className="font-mono"
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 pb-2 text-xs text-[#8b90a3]">
            <input
              type="checkbox"
              checked={isSecret}
              onChange={(e) => setIsSecret(e.target.checked)}
              className="accent-emerald-500"
            />
            Secret
          </label>
          <Button type="submit" disabled={upsert.isPending}>
            {upsert.isPending ? 'Saving…' : 'Set'}
          </Button>
          <div className="w-full">
            <ErrorNote error={upsert.error} />
          </div>
        </form>
      )}

      {vars.isPending ? (
        <Empty>Loading…</Empty>
      ) : vars.error ? (
        <ErrorNote error={vars.error} />
      ) : vars.data && vars.data.length > 0 ? (
        <ul className="divide-y divide-[#232734]">
          {vars.data.map((envVar) => (
            <li key={envVar.id} className="flex items-center gap-3 py-2.5">
              <code className="w-52 shrink-0 truncate font-mono text-xs text-[#e6e8ef]">
                {envVar.key}
              </code>
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-[#8b90a3]">
                {envVar.isSecret ? (
                  <span title={`${envVar.valueLength} characters, hidden`}>
                    {'•'.repeat(Math.min(envVar.valueLength, 24))}{' '}
                    <span className="text-[#575c70]">({envVar.valueLength})</span>
                  </span>
                ) : (
                  envVar.value
                )}
              </code>
              {envVar.isSecret && (
                <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">
                  secret
                </span>
              )}
              {canEdit && (
                <Button
                  variant="ghost"
                  className="shrink-0 px-2 py-1 text-xs"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(envVar.key)}
                >
                  Delete
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No environment variables set.</Empty>
      )}

      <ErrorNote error={remove.error} />
    </Panel>
  );
}
