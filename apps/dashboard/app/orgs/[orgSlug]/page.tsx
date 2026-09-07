'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasRole, type Project } from '@/lib/api';
import { useOrgRole } from '@/components/session-provider';
import { Button, Empty, ErrorNote, Field, Input, Panel } from '@/components/ui/primitives';

export default function ProjectsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const role = useOrgRole(orgSlug);
  const canCreate = hasRole(role, 'member');
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');

  const projects = useQuery({
    queryKey: ['projects', orgSlug],
    queryFn: () => api.get<Project[]>(`/orgs/${orgSlug}/projects`),
  });

  const create = useMutation({
    mutationFn: (projectName: string) =>
      api.post<Project>(`/orgs/${orgSlug}/projects`, { name: projectName }),
    onSuccess: async () => {
      setName('');
      setShowForm(false);
      await queryClient.invalidateQueries({ queryKey: ['projects', orgSlug] });
    },
  });

  return (
    <div className="space-y-6">
      <Panel
        title="Projects"
        description="Each project is a deployable app: its source, build commands and env."
        actions={
          canCreate ? (
            <Button onClick={() => setShowForm((v) => !v)} variant={showForm ? 'secondary' : 'primary'}>
              {showForm ? 'Cancel' : 'New project'}
            </Button>
          ) : (
            // Say why the button is missing rather than silently hiding it.
            <span className="text-xs text-[#6e7387]">Requires the “member” role</span>
          )
        }
      >
        {showForm && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(name);
            }}
            className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-[#232734] bg-[#0d0f16] p-4"
          >
            <div className="min-w-56 flex-1">
              <Field label="Project name" hint="The slug is derived automatically.">
                <Input
                  autoFocus
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Sample App"
                />
              </Field>
            </div>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create'}
            </Button>
            <div className="w-full">
              <ErrorNote error={create.error} />
            </div>
          </form>
        )}

        {projects.isPending ? (
          <Empty>Loading projects…</Empty>
        ) : projects.error ? (
          <ErrorNote error={projects.error} />
        ) : projects.data && projects.data.length > 0 ? (
          <ul className="divide-y divide-[#232734]">
            {projects.data.map((project) => (
              <li key={project.id}>
                <Link
                  href={`/orgs/${orgSlug}/projects/${project.id}`}
                  className="flex items-center justify-between gap-4 py-3 transition-colors hover:text-emerald-300"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{project.name}</p>
                    <p className="truncate font-mono text-xs text-[#6e7387]">
                      {project.slug} · port {project.appPort} · {project.healthPath}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-[#6e7387]">
                    {new Date(project.createdAt).toLocaleDateString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No projects yet. {canCreate ? 'Create one to get started.' : ''}</Empty>
        )}
      </Panel>
    </div>
  );
}
