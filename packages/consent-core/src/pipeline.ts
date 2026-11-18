import type {
  AiError,
  AiPayload,
  AiRequestInput,
  AiRequestResult,
  AiTransport,
  AiTransportResponse,
  ConsentDecision,
  DataCategory,
  ProviderConfiguration,
  TransmissionRecord,
} from "./types.js";
import type { ConsentService } from "./ledger.js";
import { createId } from "./state.js";
import { evaluateConsent, resolveActiveProvider } from "./evaluate.js";
import { buildMinimalPayload, describePayload, findRawCapture } from "./payload.js";
import type { PayloadDescription } from "./payload.js";

export interface AiRequestPipelineOptions {
  readonly consent: ConsentService;
  /** Active provider configurations. Never contains credentials. */
  readonly providers: () =>
    | readonly ProviderConfiguration[]
    | Promise<readonly ProviderConfiguration[]>;
  readonly transport: AiTransport;
  readonly now?: () => string;
  readonly requestIdFactory?: () => string;
  readonly onTransmission?: (record: TransmissionRecord) => void | Promise<void>;
}

export interface AiPreview {
  readonly decision: ConsentDecision;
  /** Present only when the request is allowed. */
  readonly payload: AiPayload | null;
  readonly description: PayloadDescription | null;
}

function decisionToError(decision: ConsentDecision): AiError {
  return {
    code: decision.code,
    message: decision.message,
    missingCategories: decision.missingCategories,
    outdatedCategories: decision.outdatedCategories,
    disclosures: decision.disclosures,
    retryable: false,
  };
}

/**
 * The only sanctioned path for AI calls.
 *
 * No feature may call a provider transport directly: `complete()` evaluates
 * consent, builds a minimized payload, blocks raw captures, audits metadata,
 * and only then transmits. A blocked decision never touches the transport.
 */
export class AiRequestPipeline {
  readonly #options: AiRequestPipelineOptions;

  constructor(options: AiRequestPipelineOptions) {
    this.#options = options;
  }

  #now(): string {
    return this.#options.now ? this.#options.now() : new Date().toISOString();
  }

  async #resolve(input: AiRequestInput): Promise<{
    provider: ProviderConfiguration | null;
    decision: ConsentDecision;
  }> {
    const state = await this.#options.consent.getState();
    const providers = await this.#options.providers();
    const provider = resolveActiveProvider(providers, input.providerId);
    const decision = evaluateConsent({
      state,
      provider,
      now: this.#now(),
      request: {
        taskId: input.taskId,
        purpose: input.purpose,
        providerId: input.providerId,
        requestedCategories: input.requestedCategories,
        ...(input.confirmed !== undefined ? { confirmed: input.confirmed } : {}),
        ...(input.containsRawMedia !== undefined
          ? { containsRawMedia: input.containsRawMedia }
          : {}),
      },
    });
    return { provider, decision };
  }

  /**
   * Non-transmitting preview used by disclosure and confirmation screens.
   * Does not audit and never calls a provider.
   */
  async preview(input: AiRequestInput): Promise<AiPreview> {
    const { decision } = await this.#resolve(input);
    if (!decision.allowed) {
      return { decision, payload: null, description: null };
    }
    const payload = buildMinimalPayload(decision, input.data, {
      now: this.#now(),
    });
    return { decision, payload, description: describePayload(payload) };
  }

  async complete(input: AiRequestInput): Promise<AiRequestResult> {
    const { provider, decision } = await this.#resolve(input);

    if (!decision.allowed || !provider) {
      await this.#options.consent.recordAttempt({
        decision,
        allowed: false,
        code: decision.code,
      });
      return { ok: false, error: decisionToError(decision), decision };
    }

    const payload = buildMinimalPayload(decision, input.data, { now: this.#now() });

    const rawFindings = findRawCapture(payload.sections);
    if (rawFindings.length > 0) {
      const error: AiError = {
        code: "payload-rejected",
        message:
          "The request payload contained raw capture data and was blocked before transmission.",
        retryable: false,
      };
      await this.#options.consent.recordAttempt({
        decision,
        allowed: false,
        code: "payload-rejected",
      });
      return { ok: false, error, decision };
    }

    const requestId = this.#options.requestIdFactory
      ? this.#options.requestIdFactory()
      : createId("airq");
    const startedAt = this.#now();

    let response: AiTransportResponse;
    try {
      response = await this.#options.transport.send({
        requestId,
        taskId: input.taskId,
        purpose: input.purpose,
        provider,
        payload,
        disclosures: decision.disclosures,
        policyVersion: decision.policyVersion,
      });
    } catch (cause) {
      const error: AiError = {
        code: "transport-failed",
        message:
          "The AI request could not be completed. No data was retried automatically.",
        retryable: true,
      };
      await this.#options.consent.recordAttempt({
        decision,
        allowed: false,
        code: "transport-failed",
      });
      void cause;
      return { ok: false, error, decision };
    }

    await this.#options.consent.recordAttempt({
      decision,
      allowed: true,
      code: "allowed",
    });

    const transmission: TransmissionRecord = {
      requestId,
      at: startedAt,
      taskId: input.taskId,
      purpose: input.purpose,
      providerId: provider.providerId,
      providerLocality: provider.locality,
      categories: decision.grantedCategories.filter(
        (category): category is DataCategory => category !== "history.complete",
      ),
      policyVersion: decision.policyVersion,
      estimatedBytes: payload.estimatedBytes,
      historyMode: payload.historyMode,
    };

    await this.#options.onTransmission?.(transmission);

    return {
      ok: true,
      text: response.text,
      ...(response.model ? { model: response.model } : {}),
      transmission,
    };
  }
}
