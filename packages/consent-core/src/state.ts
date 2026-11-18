import type {
  ConsentAuditAction,
  ConsentAuditEntry,
  ConsentAuditMetadata,
  ConsentGrant,
  ConsentState,
  ConsentStatus,
  ConsentStatusEntry,
  DataCategory,
  ExternalAccessSetting,
  ProviderId,
  PurposeId,
} from "./types.js";
import {
  CONSENT_POLICY_VERSION,
  getCategoryDefinition,
  getProviderDefinition,
  getPurposeDefinition,
  isDataCategory,
  isProviderId,
  isPurposeId,
} from "./taxonomy.js";

const MAX_AUDIT_ENTRIES = 1000;

export function createId(prefix: string): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return `${prefix}_${cryptoApi.randomUUID()}`;
  }
  const random = Math.random().toString(36).slice(2, 12);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

/** Default state: every permission off, no external access, empty audit log. */
export function createInitialConsentState(
  policyVersion: string = CONSENT_POLICY_VERSION,
): ConsentState {
  return {
    schemaVersion: 1,
    policyVersion,
    grants: [],
    externalAccess: [],
    auditLog: [],
  };
}

export interface ConsentMutationContext {
  readonly at: string;
  readonly policyVersion: string;
  readonly actor?: string;
}

function appendAudit(
  state: ConsentState,
  action: ConsentAuditAction,
  at: string,
  details: {
    category?: DataCategory;
    providerId?: ProviderId;
    purpose?: PurposeId;
    metadata?: ConsentAuditMetadata;
  },
): readonly ConsentAuditEntry[] {
  const entry: ConsentAuditEntry = {
    id: createId("audit"),
    at,
    action,
    policyVersion: state.policyVersion,
    ...(details.category ? { category: details.category } : {}),
    ...(details.providerId ? { providerId: details.providerId } : {}),
    ...(details.purpose ? { purpose: details.purpose } : {}),
    ...(details.metadata ? { metadata: details.metadata } : {}),
  };
  const next = [...state.auditLog, entry];
  return next.length > MAX_AUDIT_ENTRIES ? next.slice(next.length - MAX_AUDIT_ENTRIES) : next;
}

function validateTriple(
  category: DataCategory,
  providerId: ProviderId,
  purpose: PurposeId,
): void {
  if (!isDataCategory(category)) {
    throw new Error("A consent grant requires a known data category.");
  }
  if (!isProviderId(providerId)) {
    throw new Error("A consent grant requires a known provider.");
  }
  if (!isPurposeId(purpose)) {
    throw new Error("A consent grant requires a known purpose.");
  }
  // Touch the definitions so a mismatched registry fails loudly here.
  getCategoryDefinition(category);
  getProviderDefinition(providerId);
  getPurposeDefinition(purpose);
}

/**
 * Grant consent for exactly one (category, provider, purpose) triple.
 * Any previously active grant for the same triple is revoked first, so the
 * audit trail always reflects the user's most recent decision.
 */
export function applyGrant(
  state: ConsentState,
  input: {
    category: DataCategory;
    providerId: ProviderId;
    purpose: PurposeId;
    providerFingerprint: string;
    at: string;
    actor?: string;
    policyVersion?: string;
  },
): ConsentState {
  validateTriple(input.category, input.providerId, input.purpose);
  const policyVersion = input.policyVersion ?? state.policyVersion;

  const grants = state.grants.map((grant) =>
    grant.category === input.category &&
    grant.providerId === input.providerId &&
    grant.purpose === input.purpose &&
    grant.revokedAt === null
      ? { ...grant, revokedAt: input.at, updatedAt: input.at }
      : grant,
  );

  const newGrant: ConsentGrant = {
    id: createId("grant"),
    category: input.category,
    providerId: input.providerId,
    purpose: input.purpose,
    providerFingerprint: input.providerFingerprint,
    policyVersion,
    grantedAt: input.at,
    updatedAt: input.at,
    revokedAt: null,
  };

  const next: ConsentState = { ...state, grants: [...grants, newGrant] };
  return {
    ...next,
    auditLog: appendAudit(next, "granted", input.at, {
      category: input.category,
      providerId: input.providerId,
      purpose: input.purpose,
      metadata: {
        at: input.at,
        policyVersion,
        ...(input.actor ? { actor: input.actor } : {}),
      },
    }),
  };
}

/** Revoke a grant. Omitting `purpose` revokes that category for every purpose/provider combination given. */
export function applyRevoke(
  state: ConsentState,
  input: {
    category: DataCategory;
    providerId: ProviderId;
    purpose?: PurposeId;
    at: string;
    actor?: string;
  },
): ConsentState {
  if (!isDataCategory(input.category)) {
    throw new Error("Cannot revoke an unknown data category.");
  }
  if (!isProviderId(input.providerId)) {
    throw new Error("Cannot revoke consent for an unknown provider.");
  }
  if (input.purpose !== undefined && !isPurposeId(input.purpose)) {
    throw new Error("Cannot revoke consent for an unknown purpose.");
  }

  let touched = 0;
  const grants = state.grants.map((grant) => {
    const matches =
      grant.category === input.category &&
      grant.providerId === input.providerId &&
      grant.revokedAt === null &&
      (input.purpose === undefined || grant.purpose === input.purpose);
    if (!matches) return grant;
    touched += 1;
    return { ...grant, revokedAt: input.at, updatedAt: input.at };
  });

  if (touched === 0) return state;

  const next: ConsentState = { ...state, grants };
  return {
    ...next,
    auditLog: appendAudit(next, "revoked", input.at, {
      category: input.category,
      providerId: input.providerId,
      ...(input.purpose ? { purpose: input.purpose } : {}),
      metadata: {
        at: input.at,
        revokedGrants: touched,
        ...(input.actor ? { actor: input.actor } : {}),
      },
    }),
  };
}

/** Revoke every active grant, for every provider and purpose. */
export function applyRevokeAll(
  state: ConsentState,
  input: { at: string; actor?: string },
): ConsentState {
  if (!state.grants.some((grant) => grant.revokedAt === null)) return state;
  const grants = state.grants.map((grant) =>
    grant.revokedAt === null ? { ...grant, revokedAt: input.at, updatedAt: input.at } : grant,
  );
  const next: ConsentState = { ...state, grants };
  return {
    ...next,
    auditLog: appendAudit(next, "revoked", input.at, {
      metadata: {
        at: input.at,
        scope: "all",
        ...(input.actor ? { actor: input.actor } : {}),
      },
    }),
  };
}

export function applyExternalAccess(
  state: ConsentState,
  input: {
    providerId: ProviderId;
    enabled: boolean;
    at: string;
    actor?: string;
  },
): ConsentState {
  if (!isProviderId(input.providerId)) {
    throw new Error("External access requires a known provider.");
  }
  const others = state.externalAccess.filter(
    (setting) => setting.providerId !== input.providerId,
  );
  const setting: ExternalAccessSetting = {
    providerId: input.providerId,
    enabled: input.enabled,
    policyVersion: state.policyVersion,
    updatedAt: input.at,
  };
  const next: ConsentState = { ...state, externalAccess: [...others, setting] };
  return {
    ...next,
    auditLog: appendAudit(
      next,
      input.enabled ? "external-access-enabled" : "external-access-disabled",
      input.at,
      {
        providerId: input.providerId,
        metadata: {
          at: input.at,
          ...(input.actor ? { actor: input.actor } : {}),
        },
      },
    ),
  };
}

export function isExternalAccessEnabled(
  state: ConsentState,
  providerId: ProviderId,
): boolean {
  const setting = state.externalAccess.find((item) => item.providerId === providerId);
  return setting?.enabled === true && setting.policyVersion === state.policyVersion;
}

/** The most recent grant for a triple, regardless of validity. */
export function findLatestGrant(
  state: ConsentState,
  category: DataCategory,
  providerId: ProviderId,
  purpose: PurposeId,
): ConsentGrant | null {
  let latest: ConsentGrant | null = null;
  for (const grant of state.grants) {
    if (
      grant.category !== category ||
      grant.providerId !== providerId ||
      grant.purpose !== purpose
    ) {
      continue;
    }
    if (!latest || grant.updatedAt >= latest.updatedAt) latest = grant;
  }
  return latest;
}

export function getConsentStatus(
  state: ConsentState,
  category: DataCategory,
  providerId: ProviderId,
  purpose: PurposeId,
  providerFingerprint?: string,
): ConsentStatusEntry {
  const grant = findLatestGrant(state, category, providerId, purpose);
  let status: ConsentStatus;
  if (!grant) status = "not-granted";
  else if (grant.revokedAt !== null) status = "revoked";
  else if (grant.policyVersion !== state.policyVersion) status = "policy-outdated";
  else if (
    providerFingerprint !== undefined &&
    grant.providerFingerprint !== providerFingerprint
  ) {
    status = "provider-changed";
  } else status = "granted";

  return { category, providerId, purpose, status, grant };
}

/** True only for a live, current-policy grant. Absence or staleness means denied. */
export function hasValidConsent(
  state: ConsentState,
  category: DataCategory,
  providerId: ProviderId,
  purpose: PurposeId,
  providerFingerprint?: string,
): boolean {
  return (
    getConsentStatus(state, category, providerId, purpose, providerFingerprint).status ===
    "granted"
  );
}

export function listValidConsent(
  state: ConsentState,
  providerId: ProviderId,
  purpose: PurposeId,
  categories: readonly DataCategory[] = [],
  providerFingerprint?: string,
): readonly DataCategory[] {
  const pool = categories.length > 0 ? categories : state.grants.map((grant) => grant.category);
  return [...new Set(pool)].filter((category) =>
    hasValidConsent(state, category, providerId, purpose, providerFingerprint),
  );
}

export function applySensorAccess(
  state: ConsentState,
  input: {
    sensor: "camera" | "microphone";
    enabled: boolean;
    at: string;
    actor?: string;
  },
): ConsentState {
  const next: ConsentState = state;
  return {
    ...next,
    auditLog: appendAudit(
      next,
      input.enabled ? "sensor-access-enabled" : "sensor-access-disabled",
      input.at,
      {
        metadata: {
          sensor: input.sensor,
          ...(input.actor ? { actor: input.actor } : {}),
        },
      },
    ),
  };
}

export function recordPolicyVersionChange(
  state: ConsentState,
  at: string,
  actor?: string,
  version: string = CONSENT_POLICY_VERSION,
): ConsentState {
  const next: ConsentState = { ...state, policyVersion: version };
  return {
    ...next,
    auditLog: appendAudit(next, "policy-version-changed", at, {
      metadata: {
        at,
        from: state.policyVersion,
        to: version,
        ...(actor ? { actor } : {}),
      },
    }),
  };
}

/** Metadata-only audit for an AI attempt. Never pass payload data here. */
export function appendAiAttemptAudit(
  state: ConsentState,
  input: {
    allowed: boolean;
    at: string;
    taskId: string;
    providerId: ProviderId | null;
    purpose: PurposeId;
    categories: readonly DataCategory[];
    categoriesGranted: readonly DataCategory[];
    code: string;
  },
): ConsentState {
  const categoryLabel = input.categories.join(",");
  const grantedLabel = input.categoriesGranted.join(",");
  const next: ConsentState = state;
  return {
    ...next,
    auditLog: appendAudit(next, input.allowed ? "ai-request-allowed" : "ai-request-blocked", input.at, {
      ...(input.providerId ? { providerId: input.providerId } : {}),
      purpose: input.purpose,
      metadata: {
        at: input.at,
        taskId: input.taskId,
        code: input.code,
        requestedCategories: categoryLabel,
        grantedCategories: grantedLabel,
      },
    }),
  };
}
