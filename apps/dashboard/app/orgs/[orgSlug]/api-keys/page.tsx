'use client';

import { use, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasRole, type ApiKeyView, type CreatedApiKey, type OrgRole } from '@/lib/api';
import { useOrgRole } from '@/components/session-provider';
import {
  Button,
  Empty,
  ErrorNote,
  Field,
  Input,
  Panel,
  RoleBadge,
  Select,
} from '@/components/ui/primitives';

const ASSIGNABLE: OrgRole[] = ['viewer', 'member', 'admin'];

export default function ApiKeysPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const role = useOrgRole(orgSlug);
  const canManage = hasRole(role, 'admin');
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [keyRole, setKeyRole] = useState<OrgRole>('member');
  /** Held in memory only, and only until the page is left. */
  const [justCreated, setJustCreated] = useState<CreatedApiKey | null>(null);

  const keys = useQuery({
    queryKey: ['api-keys', orgSlug],
    queryFn: () => api.get<ApiKeyView[]>(`/orgs/${orgSlug}/api-keys`),
    enabled: canManage,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<CreatedApiKey>(`/orgs/${orgSlug}/api-keys`, { name, role: keyRole }),
    onSuccess: async (created) => {
      setJustCreated(created);
      setName('');
      await queryClient.invalidateQueries({ queryKey: ['api-keys', orgSlug] });
    },
  });

  const revoke = useMutation({
    mutationFn: (keyId: string) => api.del<ApiKeyView>(`/orgs/${orgSlug}/api-keys/${keyId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['api-keys', orgSlug] }),
  });

  if (!canManage) {
    return (
      <Panel title="API keys">
        <Empty>
          You are a “{role}”. Viewing and managing API keys requires the “admin” role.
        </Empty>
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      {justCreated && (
        <Panel
          className="border-emerald-500/40"
          title="Copy your new API key now"
          description="This is the only time it is shown. Only a hash is stored."
          actions={
            <Button variant="secondary" onClick={() => setJustCreated(null)}>
              Done
            </Button>
          }
        >
          <code className="block break-all rounded-lg border border-[#2c3142] bg-[#0d0f16] p-3 font-mono text-sm text-emerald-300">
            {justCreated.key}
          </code>
          <p className="mt-3 text-xs text-[#8b90a3]">
            Use it as <code className="text-[#e6e8ef]">Authorization: Bearer &lt;key&gt;</code>. It
            acts with the <RoleBadge role={justCreated.role} /> role in this organization.
          </p>
        </Panel>
      )}

      <Panel title="API keys" description="Programmatic access for CI and the CLI.">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
          className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-[#232734] bg-[#0d0f16] p-4"
        >
          <div className="min-w-56 flex-1">
            <Field label="Key name">
              <Input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="ci-deploy"
              />
            </Field>
          </div>
          <div className="w-36">
            <Field label="Role" hint="Cannot exceed your own.">
              <Select value={keyRole} onChange={(e) => setKeyRole(e.target.value as OrgRole)}>
                {ASSIGNABLE.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create key'}
          </Button>
          <div className="w-full">
            <ErrorNote error={create.error} />
          </div>
        </form>

        {keys.isPending ? (
          <Empty>Loading keys…</Empty>
        ) : keys.error ? (
          <ErrorNote error={keys.error} />
        ) : keys.data && keys.data.length > 0 ? (
          <ul className="divide-y divide-[#232734]">
            {keys.data.map((key) => (
              <li key={key.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {key.name}
                    {key.revokedAt && (
                      <span className="ml-2 text-xs text-red-400">revoked</span>
                    )}
                  </p>
                  <p className="truncate font-mono text-xs text-[#6e7387]">
                    {key.prefix}… · last used{' '}
                    {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'never'}
                  </p>
                </div>
                <RoleBadge role={key.role} />
                {!key.revokedAt && (
                  <Button
                    variant="danger"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(key.id)}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No API keys yet.</Empty>
        )}

        <ErrorNote error={revoke.error} />
      </Panel>
    </div>
  );
}
