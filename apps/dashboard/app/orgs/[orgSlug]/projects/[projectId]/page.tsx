'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasRole, type Project } from '@/lib/api';
import { useOrgRole } from '@/components/session-provider';
import { EnvVarsPanel } from '@/components/env-vars-panel';
import { SourceUploadPanel } from '@/components/source-upload-panel';
import { ArtifactsPanel } from '@/components/artifacts-panel';
import { DeploymentsPanel } from '@/components/deployments-panel';
import { Button, ErrorNote, Field, Input, Panel } from '@/components/ui/primitives';

type SettingsForm = {
  name: string;
  rootDir: string;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  appPort: number;
  healthPath: string;
  healthTimeoutMs: number;
};

export default function ProjectPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
}) {
  const { orgSlug, projectId } = use(params);
  const role = useOrgRole(orgSlug);
  const canEdit = hasRole(role, 'member');
  const canDelete = hasRole(role, 'admin');
  const router = useRouter();
  const queryClient = useQueryClient();

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get<Project>(`/orgs/${orgSlug}/projects/${projectId}`),
  });

  const [form, setForm] = useState<SettingsForm | null>(null);

  // Seed the form once the project loads, and re-seed after a save so the
  // inputs always reflect what the server actually stored.
  useEffect(() => {
    if (!project.data) return;
    const p = project.data;
    setForm({
      name: p.name,
      rootDir: p.rootDir,
      installCommand: p.installCommand,
      buildCommand: p.buildCommand,
      startCommand: p.startCommand,
      appPort: p.appPort,
      healthPath: p.healthPath,
      healthTimeoutMs: p.healthTimeoutMs,
    });
  }, [project.data]);

  const save = useMutation({
    mutationFn: (patch: SettingsForm) =>
      api.patch<Project>(`/orgs/${orgSlug}/projects/${projectId}`, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(['project', projectId], updated);
      void queryClient.invalidateQueries({ queryKey: ['projects', orgSlug] });
    },
  });

  const destroy = useMutation({
    mutationFn: () => api.del<void>(`/orgs/${orgSlug}/projects/${projectId}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['projects', orgSlug] });
      router.push(`/orgs/${orgSlug}`);
    },
  });

  if (project.isPending) {
    return <p className="text-sm text-[#8b90a3]">Loading project…</p>;
  }
  if (project.error) return <ErrorNote error={project.error} />;
  if (!project.data || !form) return null;

  const set = <K extends keyof SettingsForm>(field: K, value: SettingsForm[K]) =>
    setForm((prev) => (prev ? { ...prev, [field]: value } : prev));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href={`/orgs/${orgSlug}`} className="text-xs text-[#8b90a3] hover:text-[#e6e8ef]">
            ← Projects
          </Link>
          <h1 className="mt-1 text-xl font-bold tracking-tight">{project.data.name}</h1>
          <p className="font-mono text-xs text-[#6e7387]">{project.data.slug}</p>
        </div>
        {canDelete && (
          <Button
            variant="danger"
            disabled={destroy.isPending}
            onClick={() => {
              if (confirm(`Delete “${project.data.name}”? This cannot be undone.`)) {
                destroy.mutate();
              }
            }}
          >
            Delete project
          </Button>
        )}
      </div>
      <ErrorNote error={destroy.error} />

      <Panel
        title="Build & runtime settings"
        description="Commands run with spawn(shell:false) — shell metacharacters are rejected."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(form);
          }}
          className="grid gap-4 sm:grid-cols-2"
        >
          <Field label="Name">
            <Input
              required
              disabled={!canEdit}
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>
          <Field label="Root directory" hint="Relative to the uploaded source.">
            <Input
              disabled={!canEdit}
              value={form.rootDir}
              onChange={(e) => set('rootDir', e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field label="Install command">
            <Input
              disabled={!canEdit}
              value={form.installCommand}
              onChange={(e) => set('installCommand', e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field label="Build command">
            <Input
              disabled={!canEdit}
              value={form.buildCommand}
              onChange={(e) => set('buildCommand', e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field label="Start command">
            <Input
              disabled={!canEdit}
              value={form.startCommand}
              onChange={(e) => set('startCommand', e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field label="App port" hint="Port the app listens on inside the container.">
            <Input
              type="number"
              min={1}
              max={65535}
              disabled={!canEdit}
              value={form.appPort}
              onChange={(e) => set('appPort', Number(e.target.value))}
            />
          </Field>
          <Field label="Health path">
            <Input
              disabled={!canEdit}
              value={form.healthPath}
              onChange={(e) => set('healthPath', e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field label="Health timeout (ms)">
            <Input
              type="number"
              min={1000}
              max={300000}
              step={1000}
              disabled={!canEdit}
              value={form.healthTimeoutMs}
              onChange={(e) => set('healthTimeoutMs', Number(e.target.value))}
            />
          </Field>

          <div className="sm:col-span-2">
            {canEdit ? (
              <div className="flex items-center gap-3">
                <Button type="submit" disabled={save.isPending}>
                  {save.isPending ? 'Saving…' : 'Save settings'}
                </Button>
                {save.isSuccess && !save.isPending && (
                  <span className="text-xs text-emerald-400">Saved</span>
                )}
              </div>
            ) : (
              <p className="text-xs text-[#6e7387]">
                You are a “{role}”. Editing settings requires the “member” role.
              </p>
            )}
            <ErrorNote error={save.error} />
          </div>
        </form>
      </Panel>

      <DeploymentsPanel orgSlug={orgSlug} projectId={projectId} canDeploy={canEdit} />
      <EnvVarsPanel orgSlug={orgSlug} projectId={projectId} canEdit={canEdit} />
      <SourceUploadPanel orgSlug={orgSlug} projectId={projectId} canUpload={canEdit} />
      <ArtifactsPanel orgSlug={orgSlug} projectId={projectId} canEdit={canEdit} />
    </div>
  );
}
