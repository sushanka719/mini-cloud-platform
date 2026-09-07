import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Echoes the request id back on every response so a browser network tab entry
 * can be matched to a log line. Fastify generates the id (see buildApp).
 */
async function requestContextPlugin(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
  });
}

export default fp(requestContextPlugin, { name: 'request-context' });
