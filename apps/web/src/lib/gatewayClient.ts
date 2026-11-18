import type {
  ConsentDecision,
  ConsentState,
  DataCategory,
  HealthDataSnapshot,
  ProviderId,
  ProviderLocality,
  PurposeId,
  TransmissionRecord,
} from "@habitpilot/consent-core";

export interface GatewayProviderInfo {
  readonly configured: boolean;
  readonly providerId?: ProviderId;
  readonly providerLabel?: string;
  readonly model?: string;
  readonly locality?: ProviderLocality;
  readonly providerFingerprint?: string;
}

export interface GatewayResult {
  readonly text: string;
  readonly model?: string;
  readonly transmission: TransmissionRecord;
}

export interface GatewayAuthorizeResult {
  readonly approvalToken: string;
  readonly expiresAt: string;
  readonly decision: ConsentDecision;
}

export class GatewayError extends Error {
  readonly code: string;
  readonly status: number;
  readonly missingCategories: readonly DataCategory[];
  readonly outdatedCategories: readonly DataCategory[];
  readonly changedCategories: readonly DataCategory[];
  readonly disclosures: readonly string[];
  readonly retryable: boolean;

  constructor(input: {
    code: string;
    message: string;
    status: number;
    missingCategories?: readonly DataCategory[];
    outdatedCategories?: readonly DataCategory[];
    changedCategories?: readonly DataCategory[];
    disclosures?: readonly string[];
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = "GatewayError";
    this.code = input.code;
    this.status = input.status;
    this.missingCategories = input.missingCategories ?? [];
    this.outdatedCategories = input.outdatedCategories ?? [];
    this.changedCategories = input.changedCategories ?? [];
    this.disclosures = input.disclosures ?? [];
    this.retryable = input.retryable ?? false;
  }
}

/**
 * Talks to the hosted AI gateway. The session token lives in memory only and
 * is never written to IndexedDB, localStorage or the URL.
 */
export class GatewayClient {
  readonly baseUrl: string;
  readonly #token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.#token = token;
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { "content-type": "application/json" } : {}),
          authorization: `Bearer ${this.#token}`,
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(35_000),
      });
    } catch {
      throw new GatewayError({
        code: "network-error",
        message:
          "The AI gateway could not be reached. Hosted AI is unavailable, so no request was sent.",
        status: 0,
        retryable: true,
      });
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      const error = (body as { error?: Record<string, unknown> } | null)?.error;
      throw new GatewayError({
        code: typeof error?.["code"] === "string" ? error["code"] : "gateway-error",
        message:
          typeof error?.["message"] === "string"
            ? error["message"]
            : "The AI gateway refused the request.",
        status: response.status,
        missingCategories: (error?.["missingCategories"] as DataCategory[] | undefined) ?? [],
        outdatedCategories: (error?.["outdatedCategories"] as DataCategory[] | undefined) ?? [],
        changedCategories: (error?.["changedCategories"] as DataCategory[] | undefined) ?? [],
        disclosures: (error?.["disclosures"] as string[] | undefined) ?? [],
        retryable: error?.["retryable"] === true,
      });
    }

    return body as T;
  }

  async providerInfo(): Promise<GatewayProviderInfo> {
    return this.#request<GatewayProviderInfo>("/v1/ai/provider");
  }

  async consentState(): Promise<ConsentState> {
    const body = await this.#request<{
      policyVersion: string;
      grants: ConsentState["grants"];
      externalAccess: ConsentState["externalAccess"];
      auditLog: ConsentState["auditLog"];
    }>("/v1/consent");
    return {
      schemaVersion: 1,
      policyVersion: body.policyVersion,
      grants: body.grants,
      externalAccess: body.externalAccess,
      auditLog: body.auditLog,
    };
  }

  async grant(category: DataCategory, purpose: PurposeId): Promise<void> {
    await this.#request("/v1/consent/grant", {
      method: "POST",
      body: JSON.stringify({ category, purpose }),
    });
  }

  async revoke(category: DataCategory, purpose: PurposeId): Promise<void> {
    await this.#request("/v1/consent/revoke", {
      method: "POST",
      body: JSON.stringify({ category, purpose }),
    });
  }

  async revokeAll(): Promise<void> {
    await this.#request("/v1/consent/revoke-all", { method: "POST" });
  }

  async setExternalAccess(enabled: boolean): Promise<void> {
    await this.#request("/v1/consent/external-access", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    });
  }

  /**
   * Metadata-only authorization. No health data is sent; the gateway returns a
   * short-lived, single-use token plus the disclosure/decision metadata.
   */
  async authorize(input: {
    taskId: string;
    purpose: PurposeId;
    categories: readonly DataCategory[];
    confirmed: boolean;
    containsRawMedia?: boolean;
  }): Promise<GatewayAuthorizeResult> {
    return this.#request<GatewayAuthorizeResult>("/v1/ai/authorize", {
      method: "POST",
      body: JSON.stringify({
        taskId: input.taskId,
        purpose: input.purpose,
        requestedCategories: input.categories,
        confirmed: input.confirmed,
        containsRawMedia: input.containsRawMedia === true,
      }),
    });
  }

  async complete(input: {
    approvalToken: string;
    taskId: string;
    purpose: PurposeId;
    categories: readonly DataCategory[];
    data: HealthDataSnapshot;
  }): Promise<GatewayResult> {
    return this.#request<GatewayResult>("/v1/ai/complete", {
      method: "POST",
      body: JSON.stringify({
        approvalToken: input.approvalToken,
        taskId: input.taskId,
        purpose: input.purpose,
        requestedCategories: input.categories,
        data: input.data,
      }),
    });
  }
}
