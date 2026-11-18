import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export interface SessionClaims {
  readonly sub: string;
  /** Unix epoch seconds. */
  readonly exp: number;
  /** Unix epoch seconds. */
  readonly iat?: number;
  /** Unique token id, used for revocation/rotation. */
  readonly jti?: string;
  readonly scopes?: readonly string[];
}

/** In-memory revocation registry. Production deployments persist this. */
export class SessionRegistry {
  readonly #revoked = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  revoke(jti: string, expSeconds: number): void {
    this.#prune();
    this.#revoked.set(jti, expSeconds * 1000);
  }

  isRevoked(jti: string | undefined): boolean {
    if (!jti) return false;
    this.#prune();
    return this.#revoked.has(jti);
  }

  #prune(): void {
    const now = this.#now();
    for (const [jti, expiresAt] of this.#revoked) {
      if (expiresAt <= now) this.#revoked.delete(jti);
    }
  }
}

function encode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Issues a short-lived bearer token. Production deployments replace this with their IdP. */
export function issueSessionToken(claims: SessionClaims, secret: string): string {
  if (!claims.sub || claims.sub.length > 200) {
    throw new Error("Session token requires a valid subject.");
  }
  if (!Number.isFinite(claims.exp)) {
    throw new Error("Session token requires an expiry.");
  }
  const body = encode({
    ...claims,
    jti: claims.jti ?? randomUUID(),
    iat: claims.iat ?? Math.floor(Date.now() / 1000),
  });
  return `${body}.${signature(body, secret)}`;
}

export function verifySessionToken(
  token: string,
  secret: string,
  nowMs: number = Date.now(),
): SessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, provided] = parts;
  if (!body || !provided) return null;

  const expected = signature(body, secret);
  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionClaims;
  } catch {
    return null;
  }
  if (typeof claims.sub !== "string" || claims.sub.length === 0) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= nowMs) return null;
  if (typeof claims.iat === "number" && claims.iat * 1000 > nowMs + 60_000) return null;
  if (claims.jti !== undefined && typeof claims.jti !== "string") return null;
  return claims;
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}
