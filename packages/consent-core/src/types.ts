/**
 * Shared consent + AI-governance types.
 *
 * This package is the single source of truth for HabitPilot's permission model.
 * Every surface (web, PWA, Tauri desktop, hosted gateway) imports these types
 * and the enforcement functions, so consent rules cannot drift between clients.
 *
 * Non-negotiable rule: a permission is granted only when an explicit, current,
 * unrevoked grant exists for the exact (category, provider, purpose) triple.
 * Absence of a grant is denial. Configuration is not consent.
 */

export type DataCategory =
  | "personal.profile"
  | "body.weight_goals"
  | "nutrition.meal_history"
  | "observations.eating"
  | "observations.posture_eye_screen"
  | "observations.breathing"
  | "lifestyle.sleep_hydration_activity"
  | "history.complete";

export type ProviderId =
  | "ollama"
  | "lmstudio"
  | "openai-compatible"
  | "deepseek"
  | "openai"
  | "anthropic"
  | "gemini";

/**
 * Where inference physically happens.
 * - device: model runs on the user's machine (Ollama, LM Studio).
 * - local-network: a server on the user's LAN (self-hosted OpenAI-compatible).
 * - remote: a third-party provider outside the user's control.
 *
 * Locality is descriptive, never an authorization. A device-local model still
 * needs explicit consent before it may read health data.
 */
export type ProviderLocality = "device" | "local-network" | "remote";

export type PurposeId =
  | "daily-coaching"
  | "habit-suggestions"
  | "nutrition-review"
  | "weight-trend-explanation"
  | "observation-review"
  | "goal-planning"
  | "general-assistant";

export type SensitivityLevel = "standard" | "sensitive" | "highly-sensitive";

export interface DataCategoryDefinition {
  readonly id: DataCategory;
  readonly label: string;
  readonly summary: string;
  readonly whyNeeded: string;
  readonly sensitivity: SensitivityLevel;
  /** Sensitive categories need a per-request confirmation in addition to a grant. */
  readonly requiresExplicitConfirmation: boolean;
  /** This category is historical by nature and is never transmitted automatically. */
  readonly historical: boolean;
}

export type ProviderCredentialMode =
  /** No credentials are used at all. */
  | "none"
  /** Credential is held by the OS secret store on the device. */
  | "device-secret-store"
  /** Credential lives only on the hosted gateway; the browser never sees it. */
  | "server-gateway";

export interface ProviderDefinition {
  readonly id: ProviderId;
  readonly label: string;
  readonly description: string;
  readonly defaultLocality: ProviderLocality;
  readonly credentialMode: ProviderCredentialMode;
  /** Can this provider be called directly from a device without a gateway? */
  readonly deviceCallable: boolean;
}

export interface PurposeDefinition {
  readonly id: PurposeId;
  readonly label: string;
  readonly description: string;
}

/** A provider the user has *configured*. Configuration alone grants nothing. */
export interface ProviderConfiguration {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly locality: ProviderLocality;
  /** Public endpoint URL. Never contains credentials. */
  readonly endpoint?: string;
  readonly configuredAt: string;
  readonly status: "active" | "disabled";
}

export interface ConsentGrant {
  readonly id: string;
  readonly category: DataCategory;
  readonly providerId: ProviderId;
  readonly purpose: PurposeId;
  /** Canonical endpoint/model/locality fingerprint at approval time. */
  readonly providerFingerprint: string;
  readonly policyVersion: string;
  /** ISO-8601 timestamp of user approval. */
  readonly grantedAt: string;
  readonly updatedAt: string;
  /** null while the grant is active. Timestamp once revoked. */
  readonly revokedAt: string | null;
}

export interface ExternalAccessSetting {
  readonly providerId: ProviderId;
  readonly enabled: boolean;
  readonly policyVersion: string;
  readonly updatedAt: string;
}

export type ConsentAuditAction =
  | "granted"
  | "revoked"
  | "external-access-enabled"
  | "external-access-disabled"
  | "policy-version-changed"
  | "ai-request-allowed"
  | "ai-request-blocked"
  | "sensor-access-enabled"
  | "sensor-access-disabled";

/** Audit metadata must never contain health data or payload content. */
export type ConsentAuditMetadata = Record<string, string | number | boolean>;

export interface ConsentAuditEntry {
  readonly id: string;
  readonly at: string;
  readonly action: ConsentAuditAction;
  readonly policyVersion: string;
  readonly category?: DataCategory;
  readonly providerId?: ProviderId;
  readonly purpose?: PurposeId;
  readonly metadata?: ConsentAuditMetadata;
}

export interface ConsentState {
  readonly schemaVersion: 1;
  readonly policyVersion: string;
  readonly grants: readonly ConsentGrant[];
  readonly externalAccess: readonly ExternalAccessSetting[];
  readonly auditLog: readonly ConsentAuditEntry[];
}

export type ConsentStatus =
  | "granted"
  | "not-granted"
  | "policy-outdated"
  | "provider-changed"
  | "revoked";

export interface ConsentStatusEntry {
  readonly category: DataCategory;
  readonly providerId: ProviderId;
  readonly purpose: PurposeId;
  readonly status: ConsentStatus;
  readonly grant: ConsentGrant | null;
}

export interface AiTaskDefinition {
  readonly id: string;
  readonly label: string;
  readonly purpose: PurposeId;
  /** Every category this task may ever request. The caller must ask for a subset. */
  readonly allowedCategories: readonly DataCategory[];
  /** Categories that must be included for the feature to be meaningful. */
  readonly requiredCategories: readonly DataCategory[];
  /** Minimum number of requested categories (0 = optional context). */
  readonly minimumCategories: number;
  /** Hard server-side ceiling: tasks can never request outside this list. */
  readonly requiresExplicitConfirmation: boolean;
  readonly description: string;
}

export interface AiRequestDescriptor {
  readonly taskId: string;
  readonly purpose: PurposeId;
  readonly providerId: ProviderId;
  readonly requestedCategories: readonly DataCategory[];
  /** Set only when the user approved the disclosure for this exact request. */
  readonly confirmed?: boolean;
  /** Guard flag: any camera/mic/biometric capture must be blocked outright. */
  readonly containsRawMedia?: boolean;
}

export type ConsentDecisionCode =
  | "allowed"
  | "no-provider"
  | "provider-disabled"
  | "external-access-disabled"
  | "consent-missing"
  | "confirmation-required"
  | "raw-media-blocked"
  | "unknown-task"
  | "purpose-mismatch"
  | "category-not-allowed"
  | "required-data-missing"
  | "invalid-request";

export interface ConsentDecision {
  readonly allowed: boolean;
  readonly code: ConsentDecisionCode;
  /** Safe, user-facing message. Contains no personal data. */
  readonly message: string;
  readonly taskId: string;
  readonly purpose: PurposeId;
  readonly providerId: ProviderId | null;
  readonly providerLocality: ProviderLocality | null;
  readonly policyVersion: string;
  readonly requestedCategories: readonly DataCategory[];
  readonly grantedCategories: readonly DataCategory[];
  readonly missingCategories: readonly DataCategory[];
  readonly outdatedCategories: readonly DataCategory[];
  readonly changedCategories: readonly DataCategory[];
  readonly disclosures: readonly string[];
  readonly requiresConfirmation: boolean;
  readonly confirmed: boolean;
  readonly historyMode: "recent" | "complete";
  readonly evaluatedAt: string;
}

export interface ProviderConfigurationInput {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly locality?: ProviderLocality;
  readonly endpoint?: string;
  readonly status?: "active" | "disabled";
}

export type HealthTrendDirection = "down" | "up" | "flat" | "unknown";

export interface WeightEntry {
  readonly date: string;
  readonly kg: number;
}

export interface GoalDefinition {
  readonly targetWeightKg: number;
  readonly targetDate?: string;
}

export interface MealEntry {
  readonly date: string;
  readonly label: string;
  readonly kcal: number;
  readonly proteinG?: number;
  readonly carbsG?: number;
  readonly fatG?: number;
  readonly durationMinutes?: number;
}

export interface ObservationRecord {
  readonly date: string;
  /** Human-readable summary derived from an on-device sensor. Never raw media. */
  readonly summary: string;
  readonly durationMinutes?: number;
  readonly metrics?: Readonly<Record<string, number>>;
  readonly confidence?: number;
}

export interface LifestyleSnapshot {
  readonly sleepHours?: number;
  readonly hydrationMl?: number;
  readonly steps?: number;
  readonly activeMinutes?: number;
}

export interface HabitRecord {
  readonly id: string;
  readonly name: string;
  readonly completedDates: readonly string[];
  readonly targetPerWeek: number;
}

/**
 * Everything the app may know locally. The payload builder projects this down
 * to the consented categories only; nothing else leaves the device.
 */
export interface HealthDataSnapshot {
  readonly profile?: {
    readonly ageRange?: string;
    readonly biologicalSex?: string;
    readonly heightCm?: number;
    readonly activityLevel?: string;
  };
  readonly weight?: {
    readonly entries: readonly WeightEntry[];
    readonly goal?: GoalDefinition;
  };
  readonly nutrition?: {
    readonly meals: readonly MealEntry[];
  };
  readonly observations?: {
    readonly eating?: readonly ObservationRecord[];
    readonly postureEyeScreen?: readonly ObservationRecord[];
    readonly breathing?: readonly ObservationRecord[];
  };
  readonly lifestyle?: LifestyleSnapshot;
  readonly habits?: readonly HabitRecord[];
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface PayloadSection {
  readonly category: DataCategory;
  readonly fields: Record<string, JsonValue>;
  readonly recordCount: number;
}

export interface AiPayload {
  readonly taskId: string;
  readonly purpose: PurposeId;
  readonly providerId: ProviderId;
  readonly policyVersion: string;
  readonly generatedAt: string;
  readonly historyMode: "recent" | "complete";
  readonly sections: readonly PayloadSection[];
  readonly totalRecords: number;
  readonly estimatedBytes: number;
}

export interface AiTransportRequest {
  readonly requestId: string;
  readonly taskId: string;
  readonly purpose: PurposeId;
  readonly provider: ProviderConfiguration;
  readonly payload: AiPayload;
  readonly disclosures: readonly string[];
  readonly policyVersion: string;
}

export interface AiTransportResponse {
  readonly text: string;
  readonly model?: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  };
}

export interface AiTransport {
  send(request: AiTransportRequest): Promise<AiTransportResponse>;
}

export type AiErrorCode =
  | ConsentDecisionCode
  | "transport-failed"
  | "payload-rejected";

export interface AiError {
  readonly code: AiErrorCode;
  readonly message: string;
  readonly missingCategories?: readonly DataCategory[];
  readonly outdatedCategories?: readonly DataCategory[];
  readonly disclosures?: readonly string[];
  readonly retryable?: boolean;
  readonly status?: number;
}

export interface TransmissionRecord {
  readonly requestId: string;
  readonly at: string;
  readonly taskId: string;
  readonly purpose: PurposeId;
  readonly providerId: ProviderId;
  readonly providerLocality: ProviderLocality;
  readonly categories: readonly DataCategory[];
  readonly policyVersion: string;
  readonly estimatedBytes: number;
  readonly historyMode: "recent" | "complete";
}

export type AiRequestResult =
  | {
      readonly ok: true;
      readonly text: string;
      readonly model?: string;
      readonly transmission: TransmissionRecord;
    }
  | {
      readonly ok: false;
      readonly error: AiError;
      readonly decision: ConsentDecision;
    };

export interface AiRequestInput {
  readonly taskId: string;
  readonly purpose: PurposeId;
  readonly providerId: ProviderId;
  readonly requestedCategories: readonly DataCategory[];
  readonly data: HealthDataSnapshot;
  readonly confirmed?: boolean;
  readonly containsRawMedia?: boolean;
  /** Hosted mode only: single-use token issued by /v1/ai/authorize. */
  readonly approvalToken?: string;
}
