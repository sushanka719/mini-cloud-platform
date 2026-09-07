'use client';

import { use, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasRole, type OrgMemberView, type OrgRole } from '@/lib/api';
import { useOrgRole, useSession } from '@/components/session-provider';
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

export default function MembersPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const { session } = useSession();
  const role = useOrgRole(orgSlug);
  const canManage = hasRole(role, 'admin');
  const queryClient = useQueryClient();

  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState<OrgRole>('viewer');

  const members = useQuery({
    queryKey: ['members', orgSlug],
    queryFn: () => api.get<OrgMemberView[]>(`/orgs/${orgSlug}/members`),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['members', orgSlug] });

  const add = useMutation({
    mutationFn: () => api.post<OrgMemberView>(`/orgs/${orgSlug}/members`, { email, role: newRole }),
    onSuccess: async () => {
      setEmail('');
      await invalidate();
    },
  });

  const changeRole = useMutation({
    mutationFn: (input: { userId: string; role: OrgRole }) =>
      api.patch<OrgMemberView>(`/orgs/${orgSlug}/members/${input.userId}`, { role: input.role }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (userId: string) => api.del<void>(`/orgs/${orgSlug}/members/${userId}`),
    onSuccess: invalidate,
  });

  return (
    <div className="space-y-6">
      <Panel
        title="Members"
        description="Roles are enforced by the API; this view mirrors them."
      >
        {canManage && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
            className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-[#232734] bg-[#0d0f16] p-4"
          >
            <div className="min-w-56 flex-1">
              <Field label="Add an existing user by email">
                <Input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="teammate@example.com"
                />
              </Field>
            </div>
            <div className="w-36">
              <Field label="Role">
                <Select value={newRole} onChange={(e) => setNewRole(e.target.value as OrgRole)}>
                  {ASSIGNABLE.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button type="submit" disabled={add.isPending}>
              {add.isPending ? 'Adding…' : 'Add member'}
            </Button>
            <div className="w-full">
              <ErrorNote error={add.error} />
            </div>
          </form>
        )}

        {members.isPending ? (
          <Empty>Loading members…</Empty>
        ) : members.error ? (
          <ErrorNote error={members.error} />
        ) : (
          <ul className="divide-y divide-[#232734]">
            {(members.data ?? []).map((member) => {
              const isSelf = member.userId === session?.user.id;
              // Owners are managed by owners only; the API enforces the same rule.
              const editable = canManage && member.role !== 'owner';
              return (
                <li key={member.userId} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {member.name}
                      {isSelf && <span className="ml-2 text-xs text-[#6e7387]">(you)</span>}
                    </p>
                    <p className="truncate text-xs text-[#6e7387]">{member.email}</p>
                  </div>

                  {editable ? (
                    // Width lives on the wrapper: the Select's own w-full and a
                    // w-32 prop are the same Tailwind specificity, so the
                    // override is not reliable.
                    <div className="w-32 shrink-0">
                      <Select
                        value={member.role}
                        disabled={changeRole.isPending}
                        onChange={(e) =>
                          changeRole.mutate({
                            userId: member.userId,
                            role: e.target.value as OrgRole,
                          })
                        }
                      >
                        {ASSIGNABLE.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                    </div>
                  ) : (
                    <RoleBadge role={member.role} />
                  )}

                  {editable && (
                    <Button
                      variant="danger"
                      className="shrink-0"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(member.userId)}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <ErrorNote error={changeRole.error ?? remove.error} />

        {!canManage && (
          <p className="mt-4 text-xs text-[#6e7387]">
            You are a “{role}”. Adding, removing or re-roling members requires “admin”.
          </p>
        )}
      </Panel>
    </div>
  );
}
