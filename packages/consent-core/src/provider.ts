import type { ProviderConfiguration } from "./types.js";

/**
 * Consent is scoped to the exact provider configuration, not just its ID.
 * Changing the endpoint, model or locality must invalidate old approvals.
 *
 * The canonical value is hashed so provider endpoints are not copied into
 * consent exports or returned to browser clients. 64-bit FNV-1a is sufficient
 * for accidental-change detection in this local metadata context.
 */
export function providerFingerprint(provider: ProviderConfiguration): string {
  const endpoint = (provider.endpoint ?? "").trim().toLowerCase().replace(/\/+$/, "");
  const canonical = [
    provider.providerId,
    provider.locality,
    provider.model.trim(),
    endpoint,
  ].join("|");

  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= BigInt(canonical.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}
