import { getProviderDefinition } from "@habitpilot/consent-core";
import type { ProviderId, ProviderLocality } from "@habitpilot/consent-core";

export interface GatewayProviderRuntime {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly locality: ProviderLocality;
  /** Server-only. Must never appear in a response, log or config sent to clients. */
  readonly apiKey: string;
  readonly baseUrl: string;
}

export interface GatewayConfig {
  readonly port: number;
  readonly host: string;
  /** HMAC secret for session tokens. Minimum 32 characters. */
  readonly sessionSecret: string;
  /** Optional previous secret accepted during rotation. */
  readonly sessionSecretPrevious?: string;
  /** Null when no provider is configured server-side. */
  readonly provider: GatewayProviderRuntime | null;
  readonly allowedOrigins: readonly string[];
  readonly rateLimit: {
    readonly maxRequests: number;
    readonly consentMaxRequests: number;
    readonly windowMs: number;
  };
  readonly consentFile?: string;
}

const HOSTED_PROVIDERS: readonly ProviderId[] = [
  "openai",
  "deepseek",
  "anthropic",
  "gemini",
  "openai-compatible",
];

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isPrivateHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1") return true;
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  return false;
}

function detectLocality(providerId: ProviderId, baseUrl: string): ProviderLocality {
  try {
    const url = new URL(baseUrl);
    if (isPrivateHost(url.hostname)) return "local-network";
  } catch {
    // fall through to registry default
  }
  return providerId === "openai-compatible"
    ? "local-network"
    : getProviderDefinition(providerId).defaultLocality;
}

function defaultBaseUrl(providerId: ProviderId): string {
  switch (providerId) {
    case "openai":
      return "https://api.openai.com/v1";
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "anthropic":
      return "https://api.anthropic.com/v1";
    case "gemini":
      return "https://generativelanguage.googleapis.com/v1beta";
    default:
      return "";
  }
}

function readApiKey(env: NodeJS.ProcessEnv, providerId: ProviderId): string | undefined {
  const shared = env["HABITPILOT_AI_API_KEY"];
  if (shared && shared.trim().length > 0) return shared.trim();
  switch (providerId) {
    case "openai":
      return env["OPENAI_API_KEY"]?.trim();
    case "deepseek":
      return env["DEEPSEEK_API_KEY"]?.trim();
    case "anthropic":
      return env["ANTHROPIC_API_KEY"]?.trim();
    case "gemini":
      return env["GEMINI_API_KEY"]?.trim();
    default:
      return env["HABITPILOT_AI_API_KEY"]?.trim();
  }
}

/**
 * Loads gateway configuration from server-side environment variables only.
 * `VITE_*` variables are deliberately ignored: they are compiled into the
 * browser bundle and are not secret storage.
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const sessionSecret = env["HABITPILOT_SESSION_SECRET"] ?? "";
  if (sessionSecret.length < 32) {
    throw new Error(
      "HABITPILOT_SESSION_SECRET must be set to at least 32 characters on the server.",
    );
  }

  const providerIdRaw = env["HABITPILOT_AI_PROVIDER"]?.trim() as ProviderId | undefined;
  let provider: GatewayProviderRuntime | null = null;

  if (providerIdRaw) {
    if (!HOSTED_PROVIDERS.includes(providerIdRaw)) {
      throw new Error(`Unsupported server-side AI provider: ${providerIdRaw}`);
    }
    const apiKey = readApiKey(env, providerIdRaw);
    const baseUrl = env["HABITPILOT_AI_BASE_URL"]?.trim() || defaultBaseUrl(providerIdRaw);
    const model = env["HABITPILOT_AI_MODEL"]?.trim() || "";
    if (apiKey && model && baseUrl) {
      provider = {
        providerId: providerIdRaw,
        model,
        locality: detectLocality(providerIdRaw, baseUrl),
        apiKey,
        baseUrl,
      };
    }
  }

  const origins = (env["HABITPILOT_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    port: parsePositiveInt(env["HABITPILOT_GATEWAY_PORT"], 8787),
    host: env["HABITPILOT_GATEWAY_HOST"]?.trim() || "127.0.0.1",
    sessionSecret,
    ...(env["HABITPILOT_SESSION_SECRET_PREVIOUS"]?.trim().length &&
    (env["HABITPILOT_SESSION_SECRET_PREVIOUS"]?.trim().length ?? 0) >= 32
      ? { sessionSecretPrevious: env["HABITPILOT_SESSION_SECRET_PREVIOUS"]!.trim() }
      : {}),
    provider,
    allowedOrigins: origins,
    rateLimit: {
      maxRequests: parsePositiveInt(env["HABITPILOT_RATE_LIMIT_PER_MINUTE"], 20),
      consentMaxRequests: parsePositiveInt(
        env["HABITPILOT_CONSENT_RATE_LIMIT_PER_MINUTE"],
        120,
      ),
      windowMs: 60_000,
    },
    consentFile: env["HABITPILOT_CONSENT_FILE"]?.trim() || "./data/consent.json",
  };
}
