/**
 * A failure attributable to one pipeline stage.
 *
 * The `code` is what lands in `deployments.error_code` and gets rendered in the
 * dashboard, so it is a stable, greppable identifier (`INSTALL_FAILED`,
 * `ARCHIVE_TOO_LARGE`) rather than prose. The message is safe to show a user:
 * it may name a command or an exit code, never a host path or a secret.
 */
export class StageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly options: { retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'StageError';
  }

  /** True when trying again could plausibly succeed (Phase 8 reads this). */
  get retryable(): boolean {
    return this.options.retryable ?? false;
  }
}
