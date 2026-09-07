import { env, isProduction } from '@forge/config';
import type { FastifyReply } from 'fastify';

/**
 * One place that knows how the session cookie is shaped.
 *
 * `sameSite: 'lax'` is enough here: the dashboard (localhost:3000) and the API
 * (localhost:4000) differ only by port, and ports don't affect same-site — so
 * the cookie is sent on same-site XHR while still being withheld from a real
 * cross-site request. CORS with `credentials: true` covers the cross-origin
 * half.
 */
const baseCookieOptions = {
  httpOnly: true, // never readable from JS — XSS can't exfiltrate the session
  sameSite: 'lax',
  path: '/',
  secure: env.SESSION_COOKIE_SECURE || isProduction,
} as const;

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  void reply.setCookie(env.SESSION_COOKIE_NAME, token, {
    ...baseCookieOptions,
    expires: expiresAt,
    maxAge: env.SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  // Same attributes as when it was set, otherwise the browser keeps the old one.
  void reply.clearCookie(env.SESSION_COOKIE_NAME, baseCookieOptions);
}
