import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../config.ts';

export interface VerifiedUserToken {
  clerkUserId: string;
  clerkOrgId: string | undefined;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function jwksSet(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) {
    if (!config.clerk.jwksUrl) {
      throw new Error('CLERK_JWKS_URL is not configured; cannot verify end-user tokens.');
    }
    jwks = createRemoteJWKSet(new URL(config.clerk.jwksUrl));
  }
  return jwks;
}

/**
 * Verifies a caller-supplied Clerk session token directly, for callers that
 * cannot hold a server-side secret (Section 3.3: mobile).
 *
 * This is a different question from appAuth. appAuth proves WHICH APP is
 * calling; this proves WHO the request is for. A trusted-server app like
 * core-web still only needs the former, since its own backend already
 * verified the person before calling Core API, and the browser never holds
 * Core API's key. A mobile app has no equivalent server, so anything it
 * ships is extractable, and the app key alone cannot be trusted to vouch for
 * an arbitrary clerk_user_id the way it can for a trusted server. Verifying
 * the person's own token here closes that gap regardless of whether the app
 * key leaks: an attacker would still need a live, valid session token for
 * the specific person they want to act as.
 *
 * Returns null when no token was presented, so callers fall back to the
 * existing app-trusted clerk_user_id parameter (core-web's path, unchanged).
 * Throws when a token was presented but failed verification; callers must
 * turn that into a 401 rather than silently falling back, since silently
 * ignoring a bad token would let a caller downgrade itself out of the check.
 */
export async function verifyUserToken(token: string | null): Promise<VerifiedUserToken | null> {
  if (!token) return null;
  if (!config.clerk.issuer) {
    throw new Error('CLERK_ISSUER is not configured; cannot verify end-user tokens.');
  }

  const { payload } = await jwtVerify(token, jwksSet(), {
    issuer: config.clerk.issuer,
    clockTolerance: 5,
  });

  const sub = payload.sub;
  if (!sub) throw new Error('token has no sub claim');

  const orgId = payload['org_id'];
  return {
    clerkUserId: sub,
    clerkOrgId: typeof orgId === 'string' ? orgId : undefined,
  };
}

/** Extracts the raw token from the dedicated end-user token header. */
export function extractUserToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const [scheme, token] = headerValue.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}
