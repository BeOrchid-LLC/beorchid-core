import type { Context, MiddlewareHandler, Next } from 'hono';
import { extractUserToken, verifyUserToken } from '../services/user-token.ts';

/**
 * Verifies the caller's own Clerk session token directly (Section 3.3: mobile).
 *
 * Distinct from appAuth: appAuth trusts a shared secret to identify WHICH APP
 * is calling. This has no shared secret at all — mobile has nowhere safe to
 * hold one, any key in the bundle is extractable by anyone who downloads the
 * app. Every fact this middleware establishes comes from a signature Core API
 * verified itself against Clerk's own JWKS, never from anything the client
 * merely asserted. Routes behind this middleware fix their calling app in
 * code (see routes/mobile.ts) rather than reading it from the request.
 */
export interface VerifiedUser {
  clerkUserId: string;
  clerkOrgId: string | undefined;
}

declare module 'hono' {
  interface ContextVariableMap {
    verifiedUser: VerifiedUser;
  }
}

export const clerkAuth: MiddlewareHandler = async (c: Context, next: Next) => {
  const token = extractUserToken(c.req.header('authorization'));
  if (!token) {
    return c.json({ error: 'missing session token' }, 401);
  }

  let verified;
  try {
    verified = await verifyUserToken(token);
  } catch {
    return c.json({ error: 'invalid session token' }, 401);
  }
  if (!verified) {
    return c.json({ error: 'missing session token' }, 401);
  }

  c.set('verifiedUser', verified);
  await next();
};
