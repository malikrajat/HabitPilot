import type { LifestyleDay } from "@habitpilot/health-analytics";
import type { HabitRecord, HealthDataSnapshot, MealEntry } from "@habitpilot/consent-core";

/** Everything the local-first app stores in IndexedDB. */
export interface LocalHealthData {
  readonly snapshot: HealthDataSnapshot;
  readonly heightCm: number;
  readonly lifestyleDays: readonly LifestyleDay[];
  readonly meals: readonly MealEntry[];
  readonly eatingSessions: readonly {
    readonly date: string;
    readonly durationMinutes: number;
  }[];
  readonly habits: readonly HabitRecord[];
}

export function describeStorage(): string {
  return "Health data and consent records stay in this browser's IndexedDB.";
}
