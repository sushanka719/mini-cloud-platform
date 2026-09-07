'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  API_URL,
  api,
  downloadUrl,
  formatBytes,
  type ArtifactResult,
  type StoredFile,
  type StorageUsage,
} from '@/lib/api';
import { Button, Empty, ErrorNote, Panel } from '@/components/ui/primitives';

/**
 * Source objects: upload one, stream it back, or gzip it into an artifact.
 * Every button here maps to one streamed operation on the object store.
 */
export function SourceUploadPanel({
  orgSlug,
  projectId,
  canUpload,
}: {
  orgSlug: string;
  projectId: string;
  canUpload: boolean;
}) {
  const queryClient = useQueryClient();
  const base = `/orgs/${orgSlug}/projects/${projectId}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [lastArtifact, setLastArtifact] = useState<ArtifactResult | null>(null);

  const files = useQuery({
    queryKey: ['files', projectId, 'source'],
    queryFn: () => api.get<StoredFile[]>(`${base}/files?kind=source`),
  });

  const usage = useQuery({
    queryKey: ['storage', projectId],
    queryFn: () => api.get<StorageUsage>(`${base}/storage`),
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['files', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['storage', projectId] }),
    ]);
  };

  const upload = useMutation({
    mutationFn: (file: File) =>
      // XHR rather than fetch: it reports upload progress, which fetch still
      // cannot do in browsers. The body is streamed either way.
      new Promise<StoredFile>((resolve, reject) => {
        const form = new FormData();
        form.append('file', file);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_URL}${base}/source`);
        xhr.withCredentials = true;
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) setProgress(Math.round((event.loaded / event.total) * 100));
        };
        xhr.onload = () => {
          setProgress(null);
          try {
            const body: unknown = JSON.parse(xhr.responseText);
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve(body as StoredFile);
            } else {
              const err = body as { error?: { message?: string; code?: string } };
              reject(new Error(err.error?.message ?? `Upload failed (${xhr.status})`));
            }
          } catch {
            reject(new Error(`Upload failed (${xhr.status})`));
          }
        };
        xhr.onerror = () => {
          setProgress(null);
          reject(new Error('Network error during upload'));
        };
        xhr.send(form);
      }),
    onSuccess: async () => {
      setError(null);
      if (inputRef.current) inputRef.current.value = '';
      await refresh();
    },
    onError: (err) => setError(err),
  });

  const compress = useMutation({
    mutationFn: (fileId: string) =>
      api.post<ArtifactResult>(`${base}/files/${fileId}/compress`),
    onSuccess: async (result) => {
      setError(null);
      setLastArtifact(result);
      await refresh();
    },
    onError: (err) => setError(err),
  });

  const remove = useMutation({
    mutationFn: (fileId: string) => api.del<void>(`${base}/files/${fileId}`),
    onSuccess: refresh,
    onError: (err) => setError(err),
  });

  return (
    <Panel
      title="Source"
      description="Upload a .zip/.tar/.tgz archive. Streamed to the object store, size-capped and sha256-checksummed in one pass."
      actions={
        usage.data ? (
          <p className="text-right text-xs text-[#6e7387]">
            {usage.data.objectCount} object{usage.data.objectCount === 1 ? '' : 's'} ·{' '}
            {formatBytes(usage.data.totalBytes)}
            <br />
            <span className="font-mono text-[10px]">
              gzip pool {usage.data.compression.busy}/{usage.data.compression.poolSize} busy
              {usage.data.compression.queued > 0 && ` · ${usage.data.compression.queued} queued`}
            </span>
            {(usage.data.orphanCount > 0 || usage.data.missingCount > 0) && (
              <>
                <br />
                <span className="text-amber-400">
                  {usage.data.orphanCount > 0 && `${usage.data.orphanCount} orphaned`}
                  {usage.data.orphanCount > 0 && usage.data.missingCount > 0 && ' · '}
                  {usage.data.missingCount > 0 && `${usage.data.missingCount} missing`}
                </span>
              </>
            )}
          </p>
        ) : null
      }
    >
      {canUpload ? (
        <div className="mb-5 rounded-lg border border-dashed border-[#2c3142] bg-[#0d0f16] p-5 text-center">
          <input
            ref={inputRef}
            type="file"
            accept=".zip,.tar,.gz,.tgz"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload.mutate(file);
            }}
          />
          <Button
            variant="secondary"
            disabled={upload.isPending}
            onClick={() => inputRef.current?.click()}
          >
            {upload.isPending ? 'Uploading…' : 'Choose archive'}
          </Button>
          <p className="mt-2 text-xs text-[#6e7387]">.zip, .tar, .gz or .tgz — up to 50 MiB</p>

          {progress !== null && (
            <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-[#232734]">
              <div
                className="h-full bg-emerald-500 transition-[width]"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
        </div>
      ) : (
        <p className="mb-5 text-xs text-[#6e7387]">Uploading source requires the “member” role.</p>
      )}

      <ErrorNote error={error} />

      {lastArtifact && (
        <p className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          Compressed {formatBytes(lastArtifact.file.uncompressedBytes ?? 0)} →{' '}
          {formatBytes(lastArtifact.file.sizeBytes)} (
          {(lastArtifact.ratio * 100).toFixed(1)}% of original) in {lastArtifact.durationMs} ms on
          worker thread #{lastArtifact.threadId}. See Artifacts below.
        </p>
      )}

      {files.isPending ? (
        <Empty>Loading…</Empty>
      ) : files.error ? (
        <ErrorNote error={files.error} />
      ) : files.data && files.data.length > 0 ? (
        <ul className="divide-y divide-[#232734]">
          {files.data.map((file) => (
            <li key={file.id} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="truncate text-sm font-medium">{file.originalName ?? file.id}</p>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-[#6e7387]">{formatBytes(file.sizeBytes)}</span>
                  <a
                    href={downloadUrl(orgSlug, projectId, file.id)}
                    className="rounded-lg border border-[#2c3142] bg-[#171a24] px-2.5 py-1.5 text-xs font-medium text-[#e6e8ef] hover:border-[#3a4056]"
                  >
                    Download
                  </a>
                  {canUpload && (
                    <>
                      <Button
                        variant="secondary"
                        className="px-2.5 py-1.5 text-xs"
                        disabled={compress.isPending}
                        onClick={() => compress.mutate(file.id)}
                      >
                        {compress.isPending && compress.variables === file.id
                          ? 'Gzipping…'
                          : 'Compress'}
                      </Button>
                      <Button
                        variant="ghost"
                        className="px-2 py-1.5 text-xs"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (confirm('Delete this object from the store?')) remove.mutate(file.id);
                        }}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <p className="mt-0.5 truncate font-mono text-[11px] text-[#575c70]">
                sha256:{file.checksum?.slice(0, 32)}… · {new Date(file.createdAt).toLocaleString()}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No source uploaded yet.</Empty>
      )}
    </Panel>
  );
}
