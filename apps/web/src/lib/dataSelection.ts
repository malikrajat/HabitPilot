import {
  DEFAULT_RECENT_WINDOW,
  type DataCategory,
  type HealthDataSnapshot,
} from "@habitpilot/consent-core";

/**
 * Client-side minimization for hosted requests: only the categories selected
 * for this request are placed in the body. The gateway still projects again
 * against its own consent records.
 */
export function selectSnapshotForCategories(
  snapshot: HealthDataSnapshot,
  categories: readonly DataCategory[],
): HealthDataSnapshot {
  const wanted = new Set(categories);
  // `history.complete` widens the record window for categories that are
  // separately approved. It never authorizes another category on its own.
  const has = (category: DataCategory) => wanted.has(category);
  const fullHistory = wanted.has("history.complete");
  const bound = <T extends { date: string }>(records: readonly T[]): readonly T[] => {
    if (fullHistory) return records;
    return [...records]
      .sort((left, right) => right.date.localeCompare(left.date))
      .slice(0, DEFAULT_RECENT_WINDOW)
      .sort((left, right) => left.date.localeCompare(right.date));
  };

  const observationSelection = snapshot.observations
    ? {
        ...(has("observations.eating") && snapshot.observations.eating
          ? { eating: bound(snapshot.observations.eating) }
          : {}),
        ...(has("observations.posture_eye_screen") && snapshot.observations.postureEyeScreen
          ? { postureEyeScreen: bound(snapshot.observations.postureEyeScreen) }
          : {}),
        ...(has("observations.breathing") && snapshot.observations.breathing
          ? { breathing: bound(snapshot.observations.breathing) }
          : {}),
      }
    : null;

  return {
    ...(has("personal.profile") && snapshot.profile ? { profile: snapshot.profile } : {}),
    ...(has("body.weight_goals") && snapshot.weight
      ? { weight: { ...snapshot.weight, entries: bound(snapshot.weight.entries) } }
      : {}),
    ...(has("nutrition.meal_history") && snapshot.nutrition
      ? { nutrition: { meals: bound(snapshot.nutrition.meals) } }
      : {}),
    ...(observationSelection && Object.keys(observationSelection).length > 0
      ? { observations: observationSelection }
      : {}),
    ...(has("lifestyle.sleep_hydration_activity") && snapshot.lifestyle
      ? { lifestyle: snapshot.lifestyle }
      : {}),
  };
}

export function countSelectedCategories(snapshot: HealthDataSnapshot): number {
  let count = 0;
  if (snapshot.profile) count += 1;
  if (snapshot.weight) count += 1;
  if (snapshot.nutrition) count += 1;
  if (snapshot.lifestyle) count += 1;
  if (snapshot.observations) count += Object.keys(snapshot.observations).length;
  return count;
}
