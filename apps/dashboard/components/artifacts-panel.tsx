'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, downloadUrl, formatBytes, type StoredFile } from '@/lib/api';
import { Button, Empty, ErrorNote, Panel } from '@/components/ui/primitives';

/**
 * Artifacts are gzip objects produced on a worker thread. Each row shows both
 * sides of the compression and both checksums, so "download unpacked" can be
 * verified against the recorded original hash.
 */
export function ArtifactsPanel({
  orgSlug,
  projectId,
  canEdit,
}: {
  orgSlug: string;
  projectId: string;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const base = `/orgs/${orgSlug}/projects/${projectId}`;

  const artifacts = useQuery({
    queryKey: ['files', projectId, 'artifact'],
    queryFn: () => api.get<StoredFile[]>(`${base}/files?kind=artifact`),
  });

  const remove = useMutation({
    mutationFn: (fileId: string) => api.del<void>(`${base}/files/${fileId}`),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['files', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['storage', projectId] }),
      ]);
    },
  });

  return (
    <Panel
      title="Artifacts"
      description="gzip of a stored object, compressed in a worker_threads pool so the API event loop stays free. Downloads stream straight from disk."
    >
      <ErrorNote error={remove.error} />
      {artifacts.isPending ? (
        <Empty>Loading…</Empty>
      ) : artifacts.error ? (
        <ErrorNote error={artifacts.error} />
      ) : artifacts.data && artifacts.data.length > 0 ? (
        <ul className="divide-y divide-[#232734]">
          {artifacts.data.map((file) => {
            const original = file.uncompressedBytes ?? 0;
            const ratio = original > 0 ? file.sizeBytes / original : 0;
            return (
              <li key={file.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="truncate text-sm font-medium">{file.originalName ?? file.id}</p>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                      {(ratio * 100).toFixed(1)}% of {formatBytes(original)}
                    </span>
                    <a
                      href={downloadUrl(orgSlug, projectId, file.id)}
                      className="rounded-lg border border-[#2c3142] bg-[#171a24] px-2.5 py-1.5 text-xs font-medium text-[#e6e8ef] hover:border-[#3a4056]"
                    >
                      .gz ({formatBytes(file.sizeBytes)})
                    </a>
                    <a
                      href={downloadUrl(orgSlug, projectId, file.id, { decompress: true })}
                      className="rounded-lg border border-[#2c3142] bg-[#171a24] px-2.5 py-1.5 text-xs font-medium text-[#e6e8ef] hover:border-[#3a4056]"
                    >
                      Unpacked
                    </a>
                    {canEdit && (
                      <Button
                        variant="ghost"
                        className="px-2 py-1.5 text-xs"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (confirm('Delete this artifact?')) remove.mutate(file.id);
                        }}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                </div>
                <p className="mt-0.5 truncate font-mono text-[11px] text-[#575c70]">
                  gz sha256:{file.checksum?.slice(0, 16)}… · original sha256:
                  {file.uncompressedChecksum?.slice(0, 16)}… ·{' '}
                  {new Date(file.createdAt).toLocaleString()}
                </p>
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty>No artifacts yet — compress a source archive to create one.</Empty>
      )}
    </Panel>
  );
}
