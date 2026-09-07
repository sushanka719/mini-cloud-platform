import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import { isAppError } from '@forge/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

type ErrorBody = {
  error: { code: string; message: string; details?: unknown };
  requestId: string;
};

function send(reply: FastifyReply, status: number, body: ErrorBody): FastifyReply {
  return reply.status(status).send(body);
}

/**
 * The single place errors become responses. Internals (stack, cause, driver
 * messages) are logged and never returned — see CLAUDE.md §8 / CONVENTIONS §5.
 */
async function errorHandlerPlugin(app: FastifyInstance): Promise<void> {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    return send(reply, 404, {
      error: { code: 'ROUTE_NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
      requestId: request.id,
    });
  });

  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;

    if (hasZodFastifySchemaValidationErrors(error)) {
      request.log.info({ err: error, validation: error.validation }, 'request validation failed');
      return send(reply, 400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.validation.map((issue) => ({
            path: issue.params.issue.path.join('.'),
            message: issue.params.issue.message,
          })),
        },
        requestId,
      });
    }

    if (isResponseSerializationError(error)) {
      // Our own bug: the handler returned something the response schema rejects.
      request.log.error({ err: error }, 'response serialization failed');
      return send(reply, 500, {
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        requestId,
      });
    }

    if (isAppError(error)) {
      const level = error.statusCode >= 500 ? 'error' : 'warn';
      request.log[level]({ err: error, cause: error.cause, code: error.code }, error.message);
      return send(reply, error.statusCode, {
        error: { code: error.code, message: error.message },
        requestId,
      });
    }

    if (error instanceof ZodError) {
      request.log.warn({ err: error }, 'unhandled zod error');
      return send(reply, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'Invalid input' },
        requestId,
      });
    }

    // Fastify types this callback's error as unknown under the Zod type provider;
    // everything above has been narrowed, so this is the plain-Error tail.
    const fallback = error as { statusCode?: number; code?: string; message?: string };
    const status = fallback.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
      return send(reply, status, {
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        requestId,
      });
    }

    // 4xx raised by Fastify itself (rate limit, payload too large, bad JSON...).
    request.log.warn({ err: error }, 'client error');
    return send(reply, status, {
      error: {
        code: fallback.code ?? 'BAD_REQUEST',
        message: fallback.message ?? 'Bad request',
      },
      requestId,
    });
  });
}

export default fp(errorHandlerPlugin, { name: 'error-handler' });
