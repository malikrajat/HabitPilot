import type {
  AiTaskDefinition,
  DataCategory,
  DataCategoryDefinition,
  ProviderDefinition,
  ProviderId,
  ProviderLocality,
  PurposeDefinition,
  PurposeId,
} from "./types.js";

/**
 * Bump this whenever the meaning, scope or set of data categories changes.
 * Grants minted under an older version stop authorizing requests and must be
 * re-approved by the user. This is checked in `evaluateConsent`.
 */
export const CONSENT_POLICY_VERSION = "2026-11-18.2";

export const DATA_CATEGORY_DEFINITIONS: readonly DataCategoryDefinition[] = [
  {
    id: "personal.profile",
    label: "Personal profile",
    summary: "Age range, biological sex, height and general activity level.",
    whyNeeded: "Lets the model frame advice for your body and context instead of generic guidance.",
    sensitivity: "standard",
    requiresExplicitConfirmation: false,
    historical: false,
  },
  {
    id: "body.weight_goals",
    label: "Weight history and goals",
    summary: "Recent weight entries, goal weight and target date.",
    whyNeeded: "Needed to explain weight trends and adjust goal pacing.",
    sensitivity: "sensitive",
    requiresExplicitConfirmation: false,
    historical: true,
  },
  {
    id: "nutrition.meal_history",
    label: "Meal and nutrition history",
    summary: "Meals, calories, macros and eating durations.",
    whyNeeded: "Needed for nutrition review and meal-pattern feedback.",
    sensitivity: "sensitive",
    requiresExplicitConfirmation: false,
    historical: true,
  },
  {
    id: "observations.eating",
    label: "Eating and chewing observations",
    summary: "Derived eating sessions: duration, chewing pace, bite counts. No camera frames.",
    whyNeeded: "Needed to comment on eating pace and chewing behaviour.",
    sensitivity: "highly-sensitive",
    requiresExplicitConfirmation: true,
    historical: true,
  },
  {
    id: "observations.posture_eye_screen",
    label: "Posture, eye and screen observations",
    summary: "Derived posture breaks and screen-time observations. No camera frames.",
    whyNeeded: "Needed to comment on posture and screen-break patterns.",
    sensitivity: "highly-sensitive",
    requiresExplicitConfirmation: true,
    historical: true,
  },
  {
    id: "observations.breathing",
    label: "Breathing observations",
    summary: "Derived resting breathing summaries. No microphone recordings.",
    whyNeeded: "Needed to comment on breathing patterns you have chosen to track.",
    sensitivity: "highly-sensitive",
    requiresExplicitConfirmation: true,
    historical: true,
  },
  {
    id: "lifestyle.sleep_hydration_activity",
    label: "Sleep, hydration and activity",
    summary: "Sleep hours, water intake, steps and active minutes.",
    whyNeeded: "Needed for whole-day coaching across recovery and movement.",
    sensitivity: "sensitive",
    requiresExplicitConfirmation: false,
    historical: false,
  },
  {
    id: "history.complete",
    label: "Complete historical health data",
    summary: "Your full recorded history across every category above.",
    whyNeeded: "Only needed for long-range reviews that recent data cannot answer.",
    sensitivity: "highly-sensitive",
    requiresExplicitConfirmation: true,
    historical: true,
  },
];

const categoryById = new Map<DataCategory, DataCategoryDefinition>(
  DATA_CATEGORY_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export const DATA_CATEGORIES: readonly DataCategory[] = DATA_CATEGORY_DEFINITIONS.map(
  (definition) => definition.id,
);

export function getCategoryDefinition(category: DataCategory): DataCategoryDefinition {
  const definition = categoryById.get(category);
  if (!definition) {
    throw new Error(`Unknown data category: ${String(category)}`);
  }
  return definition;
}

export function isDataCategory(value: unknown): value is DataCategory {
  return typeof value === "string" && categoryById.has(value as DataCategory);
}

export const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    id: "ollama",
    label: "Ollama (local)",
    description: "Runs on this device. No data leaves your machine, but consent is still required.",
    defaultLocality: "device",
    credentialMode: "none",
    deviceCallable: true,
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    description: "Runs on this device. No data leaves your machine, but consent is still required.",
    defaultLocality: "device",
    credentialMode: "none",
    deviceCallable: true,
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible endpoint",
    description: "A self-hosted or local-network endpoint you operate. Requires explicit access approval.",
    defaultLocality: "local-network",
    credentialMode: "device-secret-store",
    deviceCallable: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    description: "Remote third-party provider. Credentials stay on the server/OS secret store.",
    defaultLocality: "remote",
    credentialMode: "server-gateway",
    deviceCallable: false,
  },
  {
    id: "openai",
    label: "OpenAI",
    description: "Remote third-party provider. Credentials stay on the server/OS secret store.",
    defaultLocality: "remote",
    credentialMode: "server-gateway",
    deviceCallable: false,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    description: "Remote third-party provider. Credentials stay on the server/OS secret store.",
    defaultLocality: "remote",
    credentialMode: "server-gateway",
    deviceCallable: false,
  },
  {
    id: "gemini",
    label: "Google Gemini",
    description: "Remote third-party provider. Credentials stay on the server/OS secret store.",
    defaultLocality: "remote",
    credentialMode: "server-gateway",
    deviceCallable: false,
  },
];

const providerById = new Map<ProviderId, ProviderDefinition>(
  PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export const PROVIDER_IDS: readonly ProviderId[] = PROVIDER_DEFINITIONS.map(
  (definition) => definition.id,
);

export function getProviderDefinition(providerId: ProviderId): ProviderDefinition {
  const definition = providerById.get(providerId);
  if (!definition) {
    throw new Error(`Unknown AI provider: ${String(providerId)}`);
  }
  return definition;
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && providerById.has(value as ProviderId);
}

export const PURPOSE_DEFINITIONS: readonly PurposeDefinition[] = [
  {
    id: "daily-coaching",
    label: "Daily coaching",
    description: "Turn today's numbers into a short, actionable summary.",
  },
  {
    id: "habit-suggestions",
    label: "Habit suggestions",
    description: "Suggest realistic habit adjustments based on recent completion.",
  },
  {
    id: "nutrition-review",
    label: "Nutrition review",
    description: "Review meals and eating patterns for practical feedback.",
  },
  {
    id: "weight-trend-explanation",
    label: "Weight trend explanation",
    description: "Explain a computed weight trend in plain language.",
  },
  {
    id: "observation-review",
    label: "Observation review",
    description: "Review opted-in eating, posture, screen or breathing observations.",
  },
  {
    id: "goal-planning",
    label: "Goal planning",
    description: "Break a goal into steps using your profile and progress.",
  },
  {
    id: "general-assistant",
    label: "General assistant",
    description: "Answer a free-form question, optionally with consented context.",
  },
];

const purposeById = new Map<PurposeId, PurposeDefinition>(
  PURPOSE_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export const PURPOSE_IDS: readonly PurposeId[] = PURPOSE_DEFINITIONS.map(
  (definition) => definition.id,
);

export function getPurposeDefinition(purpose: PurposeId): PurposeDefinition {
  const definition = purposeById.get(purpose);
  if (!definition) {
    throw new Error(`Unknown purpose: ${String(purpose)}`);
  }
  return definition;
}

export function isPurposeId(value: unknown): value is PurposeId {
  return typeof value === "string" && purposeById.has(value as PurposeId);
}

/**
 * Task registry. The server and clients both validate requests against these
 * ceilings, so a compromised client cannot ask a coaching task for the
 * complete historical record.
 */
export const AI_TASKS: readonly AiTaskDefinition[] = [
  {
    id: "daily-summary",
    label: "Daily summary",
    purpose: "daily-coaching",
    allowedCategories: [
      "personal.profile",
      "body.weight_goals",
      "nutrition.meal_history",
      "lifestyle.sleep_hydration_activity",
    ],
    requiredCategories: ["body.weight_goals"],
    minimumCategories: 1,
    requiresExplicitConfirmation: false,
    description: "A short recap of today with one or two concrete next steps.",
  },
  {
    id: "weight-trend-explainer",
    label: "Weight trend explainer",
    purpose: "weight-trend-explanation",
    allowedCategories: ["personal.profile", "body.weight_goals", "lifestyle.sleep_hydration_activity"],
    requiredCategories: ["body.weight_goals"],
    minimumCategories: 1,
    requiresExplicitConfirmation: false,
    description: "Explains a trend that HabitPilot already calculated deterministically.",
  },
  {
    id: "meal-review",
    label: "Meal review",
    purpose: "nutrition-review",
    allowedCategories: ["nutrition.meal_history", "body.weight_goals", "personal.profile"],
    requiredCategories: ["nutrition.meal_history"],
    minimumCategories: 1,
    requiresExplicitConfirmation: false,
    description: "Reviews recent meals for balance and timing.",
  },
  {
    id: "habit-suggestions",
    label: "Habit suggestions",
    purpose: "habit-suggestions",
    allowedCategories: ["lifestyle.sleep_hydration_activity", "nutrition.meal_history"],
    requiredCategories: ["lifestyle.sleep_hydration_activity"],
    minimumCategories: 1,
    requiresExplicitConfirmation: false,
    description: "Proposes small habit changes grounded in recent completion.",
  },
  {
    id: "observation-review",
    label: "Observation review",
    purpose: "observation-review",
    allowedCategories: [
      "observations.eating",
      "observations.posture_eye_screen",
      "observations.breathing",
    ],
    requiredCategories: [],
    minimumCategories: 1,
    requiresExplicitConfirmation: true,
    description: "Reviews opted-in derived observations. Raw captures are never sent.",
  },
  {
    id: "goal-plan",
    label: "Goal plan",
    purpose: "goal-planning",
    allowedCategories: ["personal.profile", "body.weight_goals", "lifestyle.sleep_hydration_activity"],
    requiredCategories: ["body.weight_goals"],
    minimumCategories: 1,
    requiresExplicitConfirmation: false,
    description: "Turns a goal and deadline into a staged plan.",
  },
  {
    id: "general-assistant",
    label: "General assistant",
    purpose: "general-assistant",
    allowedCategories: DATA_CATEGORIES,
    requiredCategories: [],
    minimumCategories: 0,
    requiresExplicitConfirmation: false,
    description: "Free-form assistant. Each category must be approved individually.",
  },
];

const taskById = new Map<string, AiTaskDefinition>(
  AI_TASKS.map((definition) => [definition.id, definition]),
);

export function getAiTask(taskId: string): AiTaskDefinition | null {
  return taskById.get(taskId) ?? null;
}

export const MESSAGES = {
  consentMissing:
    "AI data-sharing permission is not enabled. Visit Privacy & AI Settings to configure your preferences.",
  noProvider: "No AI provider is configured. Configure a provider in AI Settings.",
  providerDisabled: "The configured AI provider is disabled. Enable it in AI Settings.",
  externalAccessDisabled:
    "External provider access is not enabled for this provider. Enable it in Privacy & AI Settings before sending.",
  confirmationRequired:
    "This request needs your explicit approval for the selected sensitive categories before anything is shared.",
  rawMediaBlocked:
    "Raw camera frames, microphone recordings, video or biometric captures are never sent to an AI provider.",
  unknownTask: "This AI feature is not registered, so the request was blocked.",
  purposeMismatch: "The stated purpose does not match the feature making the request.",
  categoryNotAllowed: "The requested data includes categories this feature is not allowed to use.",
  requiredDataMissing:
    "This AI feature needs specific data categories. Select the categories it requires before sending.",
  invalidRequest: "The AI request is incomplete or malformed.",
} as const;

export function resolveLocality(
  providerId: ProviderId,
  declared?: ProviderLocality,
): ProviderLocality {
  return declared ?? getProviderDefinition(providerId).defaultLocality;
}
