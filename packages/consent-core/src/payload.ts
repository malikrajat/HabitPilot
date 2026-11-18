import type {
  AiPayload,
  ConsentDecision,
  DataCategory,
  HealthDataSnapshot,
  JsonValue,
  MealEntry,
  ObservationRecord,
  PayloadSection,
  WeightEntry,
} from "./types.js";

export const DEFAULT_RECENT_WINDOW = 14;

const CONCRETE_CATEGORIES: readonly DataCategory[] = [
  "personal.profile",
  "body.weight_goals",
  "nutrition.meal_history",
  "observations.eating",
  "observations.posture_eye_screen",
  "observations.breathing",
  "lifestyle.sleep_hydration_activity",
];

function recent<T extends { date: string }>(
  records: readonly T[],
  windowSize: number,
): readonly T[] {
  if (!Number.isFinite(windowSize)) {
    return [...records].sort((a, b) => a.date.localeCompare(b.date));
  }
  return [...records]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, windowSize)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function compact<T extends Record<string, unknown>>(value: T): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    out[key] = entry as JsonValue;
  }
  return out;
}

function weightEntries(entries: readonly WeightEntry[]): JsonValue[] {
  return entries.map((entry) => ({ date: entry.date, kg: entry.kg }));
}

function mealEntries(meals: readonly MealEntry[]): JsonValue[] {
  return meals.map((meal) =>
    compact({
      date: meal.date,
      label: meal.label,
      kcal: meal.kcal,
      proteinG: meal.proteinG,
      carbsG: meal.carbsG,
      fatG: meal.fatG,
      durationMinutes: meal.durationMinutes,
    }),
  );
}

function observationEntries(records: readonly ObservationRecord[]): JsonValue[] {
  return records.map((record) =>
    compact({
      date: record.date,
      summary: record.summary,
      durationMinutes: record.durationMinutes,
      metrics: record.metrics ? compact({ ...record.metrics }) : undefined,
      confidence: record.confidence,
    }),
  );
}

/**
 * Builds the minimal payload for an already-authorized request.
 *
 * - Throws when the decision is not `allowed`; payload construction must never
 *   precede authorization.
 * - Only explicitly granted categories are projected. Category A never leaks in
 *   because category B was approved.
 * - `history.complete` widens the record window for categories that are
 *   separately approved; it does not authorize any category on its own.
 */
export function buildMinimalPayload(
  decision: ConsentDecision,
  snapshot: HealthDataSnapshot,
  options: { now?: string; recentWindow?: number } = {},
): AiPayload {
  if (!decision.allowed) {
    throw new Error(
      `Refusing to build an AI payload for a blocked request (${decision.code}).`,
    );
  }

  const completeHistory = decision.grantedCategories.includes("history.complete");
  const providerId = decision.providerId;
  if (!providerId) {
    throw new Error("Refusing to build an AI payload without a resolved provider.");
  }
  const concrete = decision.grantedCategories.filter((category) =>
    CONCRETE_CATEGORIES.includes(category),
  );
  const windowSize = completeHistory
    ? Number.POSITIVE_INFINITY
    : options.recentWindow ?? DEFAULT_RECENT_WINDOW;

  const sections: PayloadSection[] = [];

  for (const category of concrete) {
    switch (category) {
      case "personal.profile": {
        if (!snapshot.profile) break;
        const fields = compact({
          ageRange: snapshot.profile.ageRange,
          biologicalSex: snapshot.profile.biologicalSex,
          heightCm: snapshot.profile.heightCm,
          activityLevel: snapshot.profile.activityLevel,
        });
        if (Object.keys(fields).length === 0) break;
        sections.push({ category, fields, recordCount: 1 });
        break;
      }
      case "body.weight_goals": {
        const entries = weightEntries(recent(snapshot.weight?.entries ?? [], windowSize));
        const fields = compact({
          entries,
          goalWeightKg: snapshot.weight?.goal?.targetWeightKg,
          targetDate: snapshot.weight?.goal?.targetDate,
        });
        if (Object.keys(fields).length === 0 || (entries.length === 0 && !fields["goalWeightKg"])) {
          break;
        }
        sections.push({ category, fields, recordCount: entries.length });
        break;
      }
      case "nutrition.meal_history": {
        const meals = mealEntries(recent(snapshot.nutrition?.meals ?? [], windowSize));
        if (meals.length === 0) break;
        sections.push({ category, fields: { meals }, recordCount: meals.length });
        break;
      }
      case "observations.eating": {
        const records = observationEntries(
          recent(snapshot.observations?.eating ?? [], windowSize),
        );
        if (records.length === 0) break;
        sections.push({ category, fields: { observations: records }, recordCount: records.length });
        break;
      }
      case "observations.posture_eye_screen": {
        const records = observationEntries(
          recent(snapshot.observations?.postureEyeScreen ?? [], windowSize),
        );
        if (records.length === 0) break;
        sections.push({ category, fields: { observations: records }, recordCount: records.length });
        break;
      }
      case "observations.breathing": {
        const records = observationEntries(
          recent(snapshot.observations?.breathing ?? [], windowSize),
        );
        if (records.length === 0) break;
        sections.push({ category, fields: { observations: records }, recordCount: records.length });
        break;
      }
      case "lifestyle.sleep_hydration_activity": {
        if (!snapshot.lifestyle) break;
        const fields = compact({
          sleepHours: snapshot.lifestyle.sleepHours,
          hydrationMl: snapshot.lifestyle.hydrationMl,
          steps: snapshot.lifestyle.steps,
          activeMinutes: snapshot.lifestyle.activeMinutes,
        });
        if (Object.keys(fields).length === 0) break;
        sections.push({ category, fields, recordCount: 1 });
        break;
      }
      case "history.complete":
        break;
      default:
        break;
    }
  }

  const totalRecords = sections.reduce((sum, section) => sum + section.recordCount, 0);
  const serialized = JSON.stringify(sections);

  return {
    taskId: decision.taskId,
    purpose: decision.purpose,
    providerId,
    policyVersion: decision.policyVersion,
    generatedAt: options.now ?? new Date().toISOString(),
    historyMode: completeHistory ? "complete" : "recent",
    sections,
    totalRecords,
    estimatedBytes: new TextEncoder().encode(serialized).length,
  };
}

const RAW_CAPTURE_KEY_PATTERN =
  /(frame|image|video|webcam|camera|audio|recording|microphone|pcm|waveform|biometric|faceembedding|voiceprint)/i;

export interface RawCaptureFinding {
  readonly path: string;
  readonly reason: "binary-value" | "suspicious-key" | "data-url";
}

/**
 * Defense in depth: even though the payload builder never emits media, scan the
 * outgoing object before transmission and refuse binary captures or data URLs.
 */
export function findRawCapture(
  value: unknown,
  path = "$",
  seen: WeakSet<object> = new WeakSet(),
): RawCaptureFinding[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") {
    if (/^data:(image|video|audio)\//i.test(value) || /^blob:/i.test(value)) {
      return [{ path, reason: "data-url" }];
    }
    return [];
  }
  if (typeof value !== "object") return [];
  if (
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer ||
    (typeof Blob !== "undefined" && value instanceof Blob)
  ) {
    return [{ path, reason: "binary-value" }];
  }
  if (seen.has(value)) return [];
  seen.add(value);

  const findings: RawCaptureFinding[] = [];
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      findings.push(...findRawCapture(entry, `${path}[${index}]`, seen));
    });
    return findings;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    const nested = findRawCapture(entry, childPath, seen);
    findings.push(...nested);
    const alreadyFlagged = nested.some((finding) => finding.path === childPath);
    if (!alreadyFlagged && RAW_CAPTURE_KEY_PATTERN.test(key)) {
      if (entry !== undefined && entry !== null && !isEmptyContainer(entry)) {
        findings.push({ path: childPath, reason: "suspicious-key" });
      }
    }
  }
  return findings;
}

function isEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object" && value !== null) return Object.keys(value).length === 0;
  return false;
}

export interface PayloadDescription {
  readonly categories: readonly DataCategory[];
  readonly recordCount: number;
  readonly estimatedBytes: number;
  readonly historyMode: "recent" | "complete";
}

/** Metadata-only description for disclosure UIs and audit records. */
export function describePayload(payload: AiPayload): PayloadDescription {
  return {
    categories: payload.sections.map((section) => section.category),
    recordCount: payload.totalRecords,
    estimatedBytes: payload.estimatedBytes,
    historyMode: payload.historyMode,
  };
}
