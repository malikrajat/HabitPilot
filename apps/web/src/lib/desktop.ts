import type {
  AiTransport,
  AiTransportRequest,
  AiTransportResponse,
  ProviderConfiguration,
  ProviderId,
} from "@habitpilot/consent-core";
import { buildProviderPrompt } from "./localTransport.js";

/**
 * Desktop-only bridge. Provider calls, local state and credentials are handled
 * by the Rust process. No command returns a stored credential.
 */
export function isDesktopRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(command, args);
}

export async function desktopRead<T>(key: string): Promise<T | null> {
  const raw = await invoke<string | null>("state_load", { key });
  return raw ? (JSON.parse(raw) as T) : null;
}

export async function desktopWrite(key: string, value: unknown): Promise<void> {
  await invoke("state_save", { key, json: JSON.stringify(value) });
}

export async function desktopSecretStatus(providerId: ProviderId): Promise<boolean> {
  return invoke<boolean>("secret_status", { providerId });
}

export async function desktopSetSecret(providerId: ProviderId, secret: string): Promise<void> {
  await invoke("secret_set", { providerId, secret });
}

export async function desktopDeleteSecret(providerId: ProviderId): Promise<void> {
  await invoke("secret_delete", { providerId });
}

export async function desktopCredentialBackend(): Promise<string> {
  return invoke<string>("credential_backend");
}

export interface DesktopInfo {
  readonly version: string;
  readonly platform: string;
  readonly dataDir: string;
  readonly databasePath: string;
  readonly credentialBackend: string;
  readonly aiProxy: boolean;
}

export async function desktopInfo(): Promise<DesktopInfo> {
  return invoke<DesktopInfo>("desktop_info");
}

export async function openDataFolder(): Promise<void> {
  await invoke("open_data_folder");
}

export async function desktopAiReady(providerId: ProviderId): Promise<boolean> {
  return invoke<boolean>("desktop_ai_ready", { providerId });
}

export function defaultRemoteEndpoint(providerId: ProviderId): string {
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

interface DesktopAiResponse {
  readonly text: string;
  readonly model: string;
}

/** Calls the Rust proxy, which attaches the OS-stored credential. */
export class DesktopHttpTransport implements AiTransport {
  readonly #provider: ProviderConfiguration;

  constructor(provider: ProviderConfiguration) {
    this.#provider = provider;
  }

  async send(request: AiTransportRequest): Promise<AiTransportResponse> {
    const prompt = buildProviderPrompt(request);
    const endpoint =
      this.#provider.endpoint ??
      (this.#provider.locality === "remote" ? "" : "http://127.0.0.1:11434");
    if (!endpoint) throw new Error("No endpoint is configured for this provider.");

    const result = await invoke<DesktopAiResponse>("ai_complete", {
      request: {
        providerId: this.#provider.providerId,
        model: this.#provider.model,
        endpoint,
        systemPrompt: prompt.system,
        userContent: prompt.user,
      },
    });
    return { text: result.text, model: result.model };
  }
}
