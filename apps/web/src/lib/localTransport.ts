import type {
  AiTransport,
  AiTransportRequest,
  AiTransportResponse,
  ProviderConfiguration,
} from "@habitpilot/consent-core";
import { assessEndpoint } from "./providerSelection.js";

const SYSTEM_PROMPT = [
  "You are HabitPilot, a supportive habit and wellness assistant.",
  "Use only the JSON data supplied in this request. Never invent data.",
  "Do not diagnose medical conditions and never present estimates as medical facts.",
  "Keep the answer concise and practical.",
].join(" ");

export function defaultEndpointFor(providerId: ProviderConfiguration["providerId"]): string {
  switch (providerId) {
    case "ollama":
      return "http://127.0.0.1:11434";
    case "lmstudio":
      return "http://127.0.0.1:1234";
    default:
      return "";
  }
}

function buildUserMessage(request: AiTransportRequest): string {
  return [
    `Task: ${request.taskId}`,
    `Purpose: ${request.purpose}`,
    `Approved data (JSON): ${JSON.stringify(request.payload.sections)}`,
  ].join("\n");
}

/** Shared prompt construction for local and desktop transports. */
export function buildProviderPrompt(request: AiTransportRequest): {
  system: string;
  user: string;
} {
  return { system: SYSTEM_PROMPT, user: buildUserMessage(request) };
}

function readChatCompletions(body: unknown): string | null {
  const record = body as {
    choices?: Array<{ message?: { content?: unknown } }>;
  } | null;
  const content = record?.choices?.[0]?.message?.content;
  return typeof content === "string" && content.trim().length > 0 ? content : null;
}

/**
 * Calls a model that runs on the user's device or local network. This
 * transport intentionally supports no authentication headers: browser-side
 * provider credentials are never supported. Endpoints that require a key must
 * be used through the desktop app or a hosted gateway.
 */
export class LocalHttpTransport implements AiTransport {
  readonly #provider: ProviderConfiguration;

  constructor(provider: ProviderConfiguration) {
    this.#provider = provider;
  }

  async send(request: AiTransportRequest): Promise<AiTransportResponse> {
    const endpoint = (this.#provider.endpoint ?? defaultEndpointFor(this.#provider.providerId))
      .replace(/\/$/, "");
    if (!endpoint) {
      throw new Error("No local endpoint is configured.");
    }
    const assessment = assessEndpoint(endpoint);
    if (!assessment) {
      throw new Error("The local endpoint is not a valid http(s) URL.");
    }
    if (assessment.locality === "remote") {
      throw new Error(
        "Browser-side local transport cannot call a remote endpoint. Use the secure gateway.",
      );
    }

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(request) },
    ];

    if (this.#provider.providerId === "ollama") {
      const response = await fetch(`${endpoint}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.#provider.model,
          messages,
          stream: false,
          options: { temperature: 0.4 },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error("The local model rejected the request.");
      const body = (await response.json()) as { message?: { content?: unknown } };
      const text = typeof body.message?.content === "string" ? body.message.content : null;
      if (!text) throw new Error("The local model returned an empty response.");
      return { text, model: this.#provider.model };
    }

    const response = await fetch(`${endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.#provider.model,
        messages,
        temperature: 0.4,
        max_tokens: 700,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error("The local model rejected the request.");
    const text = readChatCompletions(await response.json());
    if (!text) throw new Error("The local model returned an empty response.");
    return { text, model: this.#provider.model };
  }
}
