/**
 * Domain error. `message` is safe to return to a client; `cause` never is —
 * the API error handler logs it and drops it from the response.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, cause?: unknown) =>
  new AppError(code, 400, message, cause);
export const unauthorized = (message = 'Authentication required', cause?: unknown) =>
  new AppError('UNAUTHORIZED', 401, message, cause);
export const forbidden = (message = 'You do not have access to this resource', cause?: unknown) =>
  new AppError('FORBIDDEN', 403, message, cause);
export const notFound = (code: string, message: string, cause?: unknown) =>
  new AppError(code, 404, message, cause);
export const conflict = (code: string, message: string, cause?: unknown) =>
  new AppError(code, 409, message, cause);
export const serviceUnavailable = (code: string, message: string, cause?: unknown) =>
  new AppError(code, 503, message, cause);

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
