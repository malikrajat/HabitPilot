import type {
  DailySummary,
  WeightPoint,
  WeeklySummary,
} from "./types.js";
import { addDays, mean, round } from "./dates.js";
import { computeBmi, computeWeightTrend, latestWeight, weightChangeOverDays } from "./body.js";
import { buildReminders, type ReminderInput } from "./reminders.js";
import type { HabitLike } from "./habits.js";
import { weeklyHabitSummary } from "./habits.js";
import { eatingDurationTrend, type EatingSession } from "./eating.js";

export interface MealLike {
  readonly date: string;
  readonly kcal: number;
  readonly durationMinutes?: number;
}

export interface DailySummaryInput {
  readonly date: string;
  readonly weightEntries: readonly WeightPoint[];
  readonly heightCm?: number;
  readonly goal?: { readonly targetWeightKg: number; readonly targetDate?: string };
  readonly lifestyle?: ReminderInput["lifestyle"];
  readonly habits?: readonly HabitLike[];
  readonly meals?: readonly MealLike[];
  readonly eatingSessions?: readonly EatingSession[];
}

export function dailySummary(input: DailySummaryInput): DailySummary {
  const latest = latestWeight(input.weightEntries);
  const change = weightChangeOverDays(input.weightEntries, 7);
  const bmi =
    latest && input.heightCm ? computeBmi(input.heightCm, latest.kg) : null;

  const weekStart = addDays(input.date, -6);
  const habits = input.habits ?? [];
  const habitStats = weeklyHabitSummary(habits, weekStart, input.date);

  const todayMeals = (input.meals ?? []).filter((meal) => meal.date === input.date);
  const eating = input.eatingSessions
    ? eatingDurationTrend(input.eatingSessions, input.date)
    : null;

  const reminders = buildReminders({
    today: input.date,
    weightEntries: input.weightEntries,
    ...(input.goal ? { goal: input.goal } : {}),
    ...(input.lifestyle ? { lifestyle: input.lifestyle } : {}),
    habits,
    eating,
    weeklyTrendKgPerWeek: computeWeightTrend(input.weightEntries).weeklyRateKg,
  });

  return {
    date: input.date,
    latestWeightKg: latest?.kg ?? null,
    change7dKg: change?.deltaKg ?? null,
    bmi,
    habitCompletionPercent: habits.length === 0 ? null : habitStats.ratePercent,
    habitsCompleted: habitStats.completed,
    habitsExpected: habitStats.expected,
    sleepHours: input.lifestyle?.sleepHours ?? null,
    hydrationMl: input.lifestyle?.hydrationMl ?? null,
    steps: input.lifestyle?.steps ?? null,
    mealKcal: Math.round(todayMeals.reduce((sum, meal) => sum + meal.kcal, 0)),
    mealCount: todayMeals.length,
    reminders,
    generatedBy: "deterministic-analytics",
  };
}

export interface LifestyleDay {
  readonly date: string;
  readonly sleepHours?: number;
  readonly hydrationMl?: number;
  readonly steps?: number;
  readonly activeMinutes?: number;
}

export interface WeeklySummaryInput {
  readonly referenceDate: string;
  readonly weightEntries: readonly WeightPoint[];
  readonly goal?: { readonly targetWeightKg: number; readonly targetDate?: string };
  readonly lifestyleDays?: readonly LifestyleDay[];
  readonly habits?: readonly HabitLike[];
  readonly eatingSessions?: readonly EatingSession[];
  readonly meals?: readonly MealLike[];
}

function averageOf(
  days: readonly LifestyleDay[],
  pick: (day: LifestyleDay) => number | undefined,
): number | null {
  const values = days
    .map(pick)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const value = mean(values);
  return value === null ? null : round(value, 1);
}

export function weeklySummary(input: WeeklySummaryInput): WeeklySummary {
  const weekStart = addDays(input.referenceDate, -6);
  const weekEnd = input.referenceDate;

  const weekWeights = input.weightEntries
    .filter((entry) => entry.date >= weekStart && entry.date <= weekEnd)
    .sort((a, b) => a.date.localeCompare(b.date));
  const start = weekWeights[0] ?? null;
  const end = weekWeights.at(-1) ?? null;
  const change =
    start && end && start.date !== end.date ? round(end.kg - start.kg, 1) : null;

  const days = (input.lifestyleDays ?? []).filter(
    (day) => day.date >= weekStart && day.date <= weekEnd,
  );
  const habits = input.habits ?? [];
  const habitStats = weeklyHabitSummary(habits, weekStart, weekEnd);

  const weekMeals = (input.meals ?? []).filter(
    (meal) => meal.date >= weekStart && meal.date <= weekEnd,
  );
  const eatingSessions =
    input.eatingSessions ??
    weekMeals
      .filter((meal) => typeof meal.durationMinutes === "number")
      .map((meal) => ({
        date: meal.date,
        durationMinutes: meal.durationMinutes!,
      }));

  const eating = eatingSessions.length > 0
    ? eatingDurationTrend(eatingSessions, weekEnd)
    : null;

  const trend = computeWeightTrend(input.weightEntries);

  return {
    weekStart,
    weekEnd,
    weightStartKg: start?.kg ?? null,
    weightEndKg: end?.kg ?? null,
    weightChangeKg: change,
    weeklyTrendKgPerWeek:
      trend.direction === "insufficient-data" ? null : trend.weeklyRateKg,
    averageSleepHours: averageOf(days, (day) => day.sleepHours),
    averageHydrationMl: averageOf(days, (day) => day.hydrationMl),
    averageSteps: averageOf(days, (day) => day.steps),
    habitCompletionPercent: habits.length === 0 ? null : habitStats.ratePercent,
    eating,
    generatedBy: "deterministic-analytics",
  };
}
