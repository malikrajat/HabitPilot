import type { ProviderConfiguration, ProviderId } from "@habitpilot/consent-core";

export type EndpointLocality = "device" | "local-network" | "remote";

export interface EndpointAssessment {
  readonly locality: EndpointLocality;
  readonly hostname: string;
  readonly protocol: "http:" | "https:";
}

function isPrivateIpv4(hostname: string): boolean {
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  if (/^169\.254\./.test(hostname)) return true;
  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  return /^f[cd][0-9a-f]{2}:/.test(hostname) || /^fe[89ab][0-9a-f]:/.test(hostname);
}

/**
 * Classifies an endpoint without trusting the provider definition. This is the
 * guard that stops a browser-side "local" provider from silently pointing at a
 * remote host.
 */
export function assessEndpoint(raw: string): EndpointAssessment | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const hostname = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!hostname) return null;

  if (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    hostname === "127.0.0.1" ||
    /^127\./.test(hostname)
  ) {
    return { locality: "device", hostname, protocol: url.protocol };
  }
  if (
    isPrivateIpv4(hostname) ||
    isPrivateIpv6(hostname) ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".lan")
  ) {
    return { locality: "local-network", hostname, protocol: url.protocol };
  }
  return { locality: "remote", hostname, protocol: url.protocol };
}

/**
 * Returns the exact preferred provider, or null. It never falls back to a
 * different provider when a preference exists.
 */
export function selectActiveProvider(
  providers: readonly ProviderConfiguration[],
  preferredProviderId?: ProviderId,
): ProviderConfiguration | null {
  if (preferredProviderId) {
    return providers.find((provider) => provider.providerId === preferredProviderId) ?? null;
  }
  return providers[0] ?? null;
}
