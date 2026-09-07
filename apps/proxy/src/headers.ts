import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

/**
 * Header hygiene — the part of a reverse proxy that is easy to get wrong and
 * invisible when you do.
 *
 * RFC 9110 §7.6.1 splits headers into *end-to-end* (belong to the message and
 * must be forwarded) and *hop-by-hop* (describe this one TCP connection and
 * must not be). Forwarding a hop-by-hop header re-uses a statement about the
 * browser↔proxy connection as if it were about the proxy↔API one, and the
 * failures that causes are specific: a forwarded `transfer-encoding: chunked`
 * alongside Node's own framing produces a body the upstream cannot parse, and
 * a forwarded `connection: close` tears down a keep-alive socket the pool
 * still believes in.
 */

/** The fixed list. `upgrade` is handled separately by the upgrade path. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * `Connection: X, Y` *nominates* X and Y as hop-by-hop for this connection, so
 * the list is not only the fixed one above. Skipping this is the subtle half of
 * the bug: a client that sends `Connection: close, X-Custom` expects X-Custom
 * to end at the first hop.
 */
function nominatedByConnection(headers: IncomingHttpHeaders): Set<string> {
  const raw = headers.connection;
  if (!raw) return new Set();
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  return new Set(
    value
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0 && token !== 'close' && token !== 'keep-alive'),
  );
}

export type ForwardedFor = {
  /** The socket address the request arrived from, or null if it is gone. */
  remoteAddress: string | null;
  /** The `Host` the client asked for, so the upstream can build absolute URLs. */
  host: string | undefined;
  port: number;
  proto: 'http' | 'https';
};

/**
 * Headers to send upstream: the client's, minus hop-by-hop, plus the
 * `X-Forwarded-*` set.
 *
 * `x-forwarded-for` is *appended to*, not overwritten. The header is a chain,
 * and a proxy that replaces it destroys whatever a proxy in front of it
 * recorded — which for us matters because the API's rate limiter keys on the
 * client identity and would otherwise see one address (the proxy's) for every
 * request in the fleet.
 */
export function buildUpstreamHeaders(
  request: IncomingMessage,
  forwarded: ForwardedFor,
): IncomingHttpHeaders {
  const drop = new Set([...HOP_BY_HOP, ...nominatedByConnection(request.headers)]);
  const headers: IncomingHttpHeaders = {};

  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (drop.has(name.toLowerCase())) continue;
    headers[name] = value;
  }

  const existing = request.headers['x-forwarded-for'];
  const chain = Array.isArray(existing) ? existing.join(', ') : existing;
  const client = forwarded.remoteAddress;
  headers['x-forwarded-for'] = chain && client ? `${chain}, ${client}` : (chain ?? client ?? '');
  headers['x-forwarded-proto'] = forwarded.proto;
  headers['x-forwarded-port'] = String(forwarded.port);
  if (forwarded.host !== undefined) headers['x-forwarded-host'] = forwarded.host;

  return headers;
}

/** Response headers to send back to the client: the upstream's, minus hop-by-hop. */
export function buildClientHeaders(response: IncomingMessage): IncomingHttpHeaders {
  const drop = new Set([...HOP_BY_HOP, ...nominatedByConnection(response.headers)]);
  const headers: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    if (drop.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  return headers;
}

/**
 * Whether a request may safely be re-sent to a different upstream after a
 * failure to *connect*.
 *
 * The condition is not idempotency in the HTTP sense — it is whether we have
 * handed any of the body over yet. Nothing was sent, so nothing was executed,
 * so re-sending cannot duplicate an effect: a POST that never reached a replica
 * is exactly as un-run as a GET that never did. Once a single byte of the body
 * is in flight, all bets are off and the client gets the error.
 */
export function bodyMayStillBeUnsent(request: IncomingMessage): boolean {
  // `readableDidRead` flips the moment anything reads from the stream, which is
  // the honest signal here — cheaper and more direct than tracking bytes.
  return !request.readableDidRead;
}
