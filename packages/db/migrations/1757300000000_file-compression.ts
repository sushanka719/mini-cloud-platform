import type { MigrationBuilder } from 'node-pg-migrate';

export const shorthands: undefined = undefined;

/**
 * Phase 3. Compression metadata on the object-store index.
 *
 * An artifact is a gzip of something we already stored, so a row needs to say
 * what it was made from and what the bytes look like on both sides of the
 * compression — otherwise the only way to know an artifact's plain size or
 * verify a decompressed download is to gunzip it again.
 *
 * All four columns are nullable additions: existing `source` rows keep NULLs
 * and no data migration is needed.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('files', {
    // The source/log row this artifact was derived from. SET NULL rather than
    // CASCADE: deleting a source should not silently delete a built artifact.
    parent_file_id: { type: 'uuid', references: 'files(id)', onDelete: 'SET NULL' },
    // NULL = the object is stored as-is. 'gzip' = size_bytes/checksum describe
    // the compressed bytes and uncompressed_* describe the original.
    compression: { type: 'text' },
    uncompressed_bytes: { type: 'bigint' },
    uncompressed_checksum: { type: 'text' },
  });

  pgm.addConstraint('files', 'files_compression_check', {
    check: "compression IS NULL OR compression IN ('gzip')",
  });
  // A compressed row must describe both sides, an uncompressed row neither.
  pgm.addConstraint('files', 'files_compression_metadata_check', {
    check: `(compression IS NULL AND uncompressed_bytes IS NULL AND uncompressed_checksum IS NULL)
            OR (compression IS NOT NULL AND uncompressed_bytes IS NOT NULL)`,
  });
  pgm.createIndex('files', 'parent_file_id');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('files', 'parent_file_id', { ifExists: true });
  pgm.dropConstraint('files', 'files_compression_metadata_check', { ifExists: true });
  pgm.dropConstraint('files', 'files_compression_check', { ifExists: true });
  pgm.dropColumns('files', [
    'parent_file_id',
    'compression',
    'uncompressed_bytes',
    'uncompressed_checksum',
  ]);
}
