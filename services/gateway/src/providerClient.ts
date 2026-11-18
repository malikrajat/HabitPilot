import type {
  AiPayload,
  AiTaskDefinition,
  AiTransportResponse,
  PurposeId,
} from "@habitpilot/consent-core";
import type { GatewayProviderRuntime } from "./config.js";

export interface ProviderInvocationInput {
  readonly runtime: GatewayProviderRuntime;
  readonly task: AiTaskDefinition;
  readonly purpose: PurposeId;
  readonly payload: AiPayload;
}

export type ProviderInvoker = (
  input: ProviderInvocationInput,
) => Promise<AiTransportResponse>;

export class ProviderError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

const PROVIDER_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT = [
  "You are HabitPilot, a supportive habit and wellness assistant.",
  "Use only the JSON data supplied in this request. Never invent data, and never imply you can see anything else.",
  "Do not diagnose medical conditions, and never present an estimate or projection as a medical fact.",
  "Keep the answer concise, practical and non-judgemental. Do not ask for more personal data.",
].join(" ");

function buildUserMessage(input: ProviderInvocationInput): string {
  return [
    `Task: ${input.task.label}`,
    `Purpose: ${input.purpose}`,
    `Approved data (JSON): ${JSON.stringify(input.payload.sections)}`,
  ].join("\n");
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    throw new ProviderError("The AI provider could not be reached.");
  }

  if (!response.ok) {
    // Deliberately discard the upstream body: it may echo personal data.
    throw new ProviderError(`The AI provider rejected the request (status ${response.status}).`);
  }

  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ProviderError("The AI provider returned an unreadable response.");
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function pickNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseOpenAiStyle(raw: unknown, model: string): AiTransportResponse {
  const record = asRecord(raw);
  const choices = record?.["choices"];
  const first = Array.isArray(choices) ? asRecord(choices[0]) : null;
  const message = asRecord(first?.["message"]);
  const text = pickString(message?.["content"]) ?? pickString(first?.["text"]);
  if (!text) throw new ProviderError("The AI provider returned an empty response.");
  const usage = asRecord(record?.["usage"]);
  return {
    text,
    model: pickString(record?.["model"]) ?? model,
    ...(usage
      ? {
          usage: {
            ...(pickNumber(usage["prompt_tokens"]) !== undefined
              ? { inputTokens: pickNumber(usage["prompt_tokens"]) }
              : {}),
            ...(pickNumber(usage["completion_tokens"]) !== undefined
              ? { outputTokens: pickNumber(usage["completion_tokens"]) }
              : {}),
          },
        }
      : {}),
  };
}

function parseAnthropic(raw: unknown, model: string): AiTransportResponse {
  const record = asRecord(raw);
  const content = record?.["content"];
  if (!Array.isArray(content)) throw new ProviderError("The AI provider returned an empty response.");
  const text = content
    .map((part) => pickString(asRecord(part)?.["text"]))
    .filter((part): part is string => Boolean(part))
    .join("\n");
  if (!text) throw new ProviderError("The AI provider returned an empty response.");
  const usage = asRecord(record?.["usage"]);
  return {
    text,
    model: pickString(record?.["model"]) ?? model,
    ...(usage
      ? {
          usage: {
            ...(pickNumber(usage["input_tokens"]) !== undefined
              ? { inputTokens: pickNumber(usage["input_tokens"]) }
              : {}),
            ...(pickNumber(usage["output_tokens"]) !== undefined
              ? { outputTokens: pickNumber(usage["output_tokens"]) }
              : {}),
          },
        }
      : {}),
  };
}

function parseGemini(raw: unknown, model: string): AiTransportResponse {
  const record = asRecord(raw);
  const candidates = record?.["candidates"];
  const first = Array.isArray(candidates) ? asRecord(candidates[0]) : null;
  const content = asRecord(first?.["content"]);
  const parts = content?.["parts"];
  if (!Array.isArray(parts)) throw new ProviderError("The AI provider returned an empty response.");
  const text = parts
    .map((part) => pickString(asRecord(part)?.["text"]))
    .filter((part): part is string => Boolean(part))
    .join("\n");
  if (!text) throw new ProviderError("The AI provider returned an empty response.");
  const usage = asRecord(record?.["usageMetadata"]);
  return {
    text,
    model,
    ...(usage
      ? {
          usage: {
            ...(pickNumber(usage["promptTokenCount"]) !== undefined
              ? { inputTokens: pickNumber(usage["promptTokenCount"]) }
              : {}),
            ...(pickNumber(usage["candidatesTokenCount"]) !== undefined
              ? { outputTokens: pickNumber(usage["candidatesTokenCount"]) }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * Server-side provider adapters. Credentials are read from the runtime config
 * and never logged, returned, or embedded in prompts.
 */
export function createHttpProviderInvoker(): ProviderInvoker {
  return async (input) => {
    const { runtime } = input;
    const userMessage = buildUserMessage(input);
    const baseUrl = runtime.baseUrl.replace(/\/$/, "");

    switch (runtime.providerId) {
      case "anthropic": {
        const raw = await postJson(
          `${baseUrl}/messages`,
          {
            "x-api-key": runtime.apiKey,
            "anthropic-version": "2023-06-01",
          },
          {
            model: runtime.model,
            max_tokens: 700,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: userMessage }],
          },
        );
        return parseAnthropic(raw, runtime.model);
      }
      case "gemini": {
        const raw = await postJson(
          `${baseUrl}/models/${encodeURIComponent(runtime.model)}:generateContent`,
          { "x-goog-api-key": runtime.apiKey },
          {
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: "user", parts: [{ text: userMessage }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 700 },
          },
        );
        return parseGemini(raw, runtime.model);
      }
      default: {
        const raw = await postJson(
          `${baseUrl}/chat/completions`,
          { authorization: `Bearer ${runtime.apiKey}` },
          {
            model: runtime.model,
            temperature: 0.4,
            max_tokens: 700,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userMessage },
            ],
          },
        );
        return parseOpenAiStyle(raw, runtime.model);
      }
    }
  };
}
