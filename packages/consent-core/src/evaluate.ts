import type {
  ConsentDecision,
  ConsentDecisionCode,
  ConsentState,
  DataCategory,
  ProviderConfiguration,
  ProviderId,
  PurposeId,
} from "./types.js";
import {
  MESSAGES,
  getAiTask,
  getCategoryDefinition,
  getProviderDefinition,
  getPurposeDefinition,
  isDataCategory,
  isPurposeId,
} from "./taxonomy.js";
import { getConsentStatus, isExternalAccessEnabled } from "./state.js";
import { providerFingerprint } from "./provider.js";

export interface ConsentEvaluationContext {
  readonly state: ConsentState;
  /** The active provider configuration, or null when none is configured. */
  readonly provider: ProviderConfiguration | null;
  readonly request: {
    readonly taskId: string;
    readonly purpose: PurposeId;
    readonly providerId: ProviderId;
    readonly requestedCategories: readonly DataCategory[];
    readonly confirmed?: boolean;
    readonly containsRawMedia?: boolean;
  };
  readonly now?: string;
}

interface DecisionSeed {
  readonly code: ConsentDecisionCode;
  readonly message: string;
  readonly grantedCategories: readonly DataCategory[];
  readonly missingCategories?: readonly DataCategory[];
  readonly outdatedCategories?: readonly DataCategory[];
  readonly changedCategories?: readonly DataCategory[];
  readonly disclosures?: readonly string[];
  readonly requiresConfirmation?: boolean;
  readonly confirmed?: boolean;
  readonly historyMode?: "recent" | "complete";
}

function buildDecision(
  seed: DecisionSeed,
  context: {
    state: ConsentState;
    provider: ProviderConfiguration | null;
    request: {
      taskId: string;
      purpose: PurposeId;
      providerId: ProviderId;
      requestedCategories: readonly DataCategory[];
    };
    evaluatedAt: string;
  },
): ConsentDecision {
  const { state, provider, request, evaluatedAt } = context;
  return {
    allowed: seed.code === "allowed",
    code: seed.code,
    message: seed.message,
    taskId: request.taskId,
    purpose: request.purpose,
    providerId: provider ? provider.providerId : request.providerId,
    providerLocality: provider ? provider.locality : null,
    policyVersion: state.policyVersion,
    requestedCategories: request.requestedCategories,
    grantedCategories: seed.grantedCategories,
    missingCategories: seed.missingCategories ?? [],
    outdatedCategories: seed.outdatedCategories ?? [],
    changedCategories: seed.changedCategories ?? [],
    disclosures: seed.disclosures ?? [],
    requiresConfirmation: seed.requiresConfirmation ?? false,
    confirmed: seed.confirmed ?? false,
    historyMode: seed.historyMode ?? "recent",
    evaluatedAt,
  };
}

export function buildDisclosures(input: {
  provider: ProviderConfiguration;
  categories: readonly DataCategory[];
  historyMode: "recent" | "complete";
  requiresConfirmation: boolean;
  viaGateway: boolean;
}): readonly string[] {
  const definition = getProviderDefinition(input.provider.providerId);
  const providerLabel = definition.label;
  const disclosures: string[] = [];

  if (input.provider.locality === "device") {
    disclosures.push(
      `${providerLabel} runs on this device. Approved data is processed locally and is not sent to a third-party provider.`,
    );
  } else if (input.provider.locality === "local-network") {
    disclosures.push(
      `${providerLabel} receives approved data over your local network. HabitPilot does not operate this endpoint; you or your network operator do.`,
    );
  } else {
    disclosures.push(
      `${providerLabel} is a remote third-party provider. Approved data leaves your device and is processed by that provider under its own terms.`,
    );
  }

  if (input.provider.locality !== "device") {
    disclosures.push(
      input.viaGateway
        ? "The HabitPilot gateway relays this request. The gateway enforces your consent independently and does not store the request body."
        : "This request is sent directly from your device to the configured endpoint. No HabitPilot server processes it.",
    );
  }

  disclosures.push(
    input.categories.length === 0
      ? "No personal data categories are included in this request."
      : `Included data categories: ${input.categories
          .map((category) => getCategoryDefinition(category).label)
          .join(", ")}. No other category is included.`,
  );

  disclosures.push(
    input.historyMode === "complete"
      ? "This request includes your complete historical health record because you selected the complete-history category."
      : "Only a bounded recent window of records is included; older history stays on your device.",
  );

  if (input.requiresConfirmation) {
    disclosures.push(
      "This request includes sensitive observations or complete history and needs your approval for this specific send.",
    );
  }

  disclosures.push(
    "You can revoke any permission at any time in Privacy & AI Settings; revocation stops future transmissions immediately.",
  );

  return disclosures;
}

/**
 * The single authorization gate for AI requests.
 *
 * Order mirrors the product requirement: task, required data, provider,
 * provider access, per-category consent, then explicit confirmation. Only an
 * "allowed" decision may proceed to payload construction.
 */
export function evaluateConsent(context: ConsentEvaluationContext): ConsentDecision {
  const { state, provider, request } = context;
  const evaluatedAt = context.now ?? new Date().toISOString();
  const requestedCategories = [...new Set(request.requestedCategories)];
  const normalizedRequest = { ...request, requestedCategories } as const;

  const decisionContext = {
    state,
    provider,
    request: normalizedRequest,
    evaluatedAt,
  };

  const deny = (
    code: ConsentDecisionCode,
    message: string,
    extras: Omit<DecisionSeed, "code" | "message" | "grantedCategories"> & {
      grantedCategories?: readonly DataCategory[];
    } = {},
  ): ConsentDecision =>
    buildDecision({ code, message, grantedCategories: [], ...extras }, decisionContext);

  const task = getAiTask(request.taskId);
  if (!task) {
    return deny("unknown-task", MESSAGES.unknownTask);
  }

  if (!isPurposeId(request.purpose) || !getPurposeDefinition(request.purpose)) {
    return deny("invalid-request", MESSAGES.invalidRequest);
  }

  if (task.purpose !== request.purpose) {
    return deny("purpose-mismatch", MESSAGES.purposeMismatch);
  }

  if (!requestedCategories.every((category) => isDataCategory(category))) {
    return deny("invalid-request", MESSAGES.invalidRequest);
  }

  const disallowed = requestedCategories.filter(
    (category) => !task.allowedCategories.includes(category),
  );
  if (disallowed.length > 0) {
    return deny("category-not-allowed", MESSAGES.categoryNotAllowed, {
      missingCategories: disallowed,
    });
  }

  const missingRequired = task.requiredCategories.filter(
    (category) => !requestedCategories.includes(category),
  );
  const minimumCategories = task.minimumCategories;
  if (missingRequired.length > 0 || requestedCategories.length < minimumCategories) {
    const requiredMessage =
      task.requiredCategories.length > 0
        ? `This AI feature requires these data categories: ${task.requiredCategories
            .map((category) => getCategoryDefinition(category).label)
            .join(", ")}. Select and approve them before sending.`
        : MESSAGES.requiredDataMissing;
    return deny("required-data-missing", requiredMessage);
  }

  if (request.containsRawMedia) {
    return deny("raw-media-blocked", MESSAGES.rawMediaBlocked);
  }

  if (!provider) {
    return deny("no-provider", MESSAGES.noProvider);
  }

  if (provider.status !== "active") {
    return deny("provider-disabled", MESSAGES.providerDisabled);
  }

  const requiresExternalAccess = provider.locality !== "device";
  if (requiresExternalAccess && !isExternalAccessEnabled(state, provider.providerId)) {
    return deny("external-access-disabled", MESSAGES.externalAccessDisabled);
  }

  const requiresConfirmation =
    task.requiresExplicitConfirmation ||
    requestedCategories.some(
      (category) => getCategoryDefinition(category).requiresExplicitConfirmation,
    );

  const grantedCategories: DataCategory[] = [];
  const missingCategories: DataCategory[] = [];
  const outdatedCategories: DataCategory[] = [];
  const changedCategories: DataCategory[] = [];
  const fingerprint = providerFingerprint(provider);

  for (const category of requestedCategories) {
    const status = getConsentStatus(
      state,
      category,
      provider.providerId,
      request.purpose,
      fingerprint,
    );
    if (status.status === "granted") {
      grantedCategories.push(category);
    } else {
      missingCategories.push(category);
      if (status.status === "policy-outdated") outdatedCategories.push(category);
      if (status.status === "provider-changed") changedCategories.push(category);
    }
  }

  const historyMode: "recent" | "complete" = requestedCategories.includes("history.complete")
    ? "complete"
    : "recent";
  const confirmed = request.confirmed === true;

  const disclosures = buildDisclosures({
    provider,
    categories: requestedCategories,
    historyMode,
    requiresConfirmation,
    viaGateway: provider.locality !== "device",
  });

  if (missingCategories.length > 0) {
    return deny("consent-missing", MESSAGES.consentMissing, {
      grantedCategories,
      missingCategories,
      outdatedCategories,
      changedCategories,
      disclosures,
      requiresConfirmation,
      confirmed,
      historyMode,
    });
  }

  if (requiresConfirmation && !confirmed) {
    return deny("confirmation-required", MESSAGES.confirmationRequired, {
      grantedCategories,
      missingCategories: [],
      outdatedCategories,
      changedCategories,
      disclosures,
      requiresConfirmation: true,
      confirmed: false,
      historyMode,
    });
  }

  return buildDecision(
    {
      code: "allowed",
      message: "Consent verified.",
      grantedCategories,
      missingCategories: [],
      outdatedCategories: [],
      changedCategories: [],
      disclosures,
      requiresConfirmation,
      confirmed,
      historyMode,
    },
    decisionContext,
  );
}

/**
 * Pick the provider to use. When a preferred provider is named and is not
 * configured, this returns null rather than silently switching to another one.
 */
export function resolveActiveProvider(
  providers: readonly ProviderConfiguration[],
  preferredProviderId?: ProviderId,
): ProviderConfiguration | null {
  if (preferredProviderId) {
    return providers.find((provider) => provider.providerId === preferredProviderId) ?? null;
  }
  return (
    providers.find((provider) => provider.status === "active") ?? providers[0] ?? null
  );
}
