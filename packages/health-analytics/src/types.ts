/** Shared deterministic analytics types. No language model is involved anywhere here. */

export interface WeightPoint {
  readonly date: string;
  readonly kg: number;
}

export type BmiCategory = "underweight" | "healthy-range" | "above-range" | "well-above-range";

export interface BmiResult {
  readonly bmi: number;
  readonly category: BmiCategory;
  readonly healthyWeightMinKg: number;
  readonly healthyWeightMaxKg: number;
  readonly note: string;
}

export interface MovingAveragePoint extends WeightPoint {
  readonly average: number;
  readonly samples: number;
}

export type TrendDirection = "losing" | "gaining" | "stable" | "insufficient-data";

export interface WeightTrend {
  readonly direction: TrendDirection;
  readonly weeklyRateKg: number;
  readonly totalChangeKg: number;
  readonly dataPoints: number;
  readonly spanDays: number;
  readonly note: string;
}

export interface TrendSeriesPoint extends MovingAveragePoint {
  readonly baselineKg: number;
}

export interface GoalProgress {
  readonly startWeightKg: number;
  readonly currentWeightKg: number;
  readonly targetWeightKg: number;
  readonly remainingKg: number;
  readonly progressPercent: number;
  readonly direction: "loss" | "gain" | "none";
  readonly reached: boolean;
}

export type EstimateConfidence = "low" | "medium" | "high";

export interface GoalProjection {
  readonly kind: "estimate";
  readonly estimatedDate: string | null;
  readonly daysRemaining: number | null;
  readonly weeklyRateKg: number;
  readonly confidence: EstimateConfidence;
  readonly basis: string;
  readonly disclaimer: string;
}

export interface HabitCompletion {
  readonly habitId: string;
  readonly completed: number;
  readonly expected: number;
  readonly ratePercent: number;
  readonly remaining: number;
}

export interface HabitStreak {
  readonly current: number;
  readonly longest: number;
  readonly lastCompletedDate: string | null;
}

export interface EatingDurationStats {
  readonly count: number;
  readonly meanMinutes: number | null;
  readonly medianMinutes: number | null;
  readonly p90Minutes: number | null;
  readonly minMinutes: number | null;
  readonly maxMinutes: number | null;
  readonly totalMinutes: number;
  readonly trendMinutes: number | null;
}

export type ReminderSeverity = "info" | "attention";

export interface Reminder {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly severity: ReminderSeverity;
  readonly rule: string;
}

export interface DailySummary {
  readonly date: string;
  readonly latestWeightKg: number | null;
  readonly change7dKg: number | null;
  readonly bmi: BmiResult | null;
  readonly habitCompletionPercent: number | null;
  readonly habitsCompleted: number;
  readonly habitsExpected: number;
  readonly sleepHours: number | null;
  readonly hydrationMl: number | null;
  readonly steps: number | null;
  readonly mealKcal: number;
  readonly mealCount: number;
  readonly reminders: readonly Reminder[];
  readonly generatedBy: "deterministic-analytics";
}

export interface WeeklySummary {
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly weightStartKg: number | null;
  readonly weightEndKg: number | null;
  readonly weightChangeKg: number | null;
  readonly weeklyTrendKgPerWeek: number | null;
  readonly averageSleepHours: number | null;
  readonly averageHydrationMl: number | null;
  readonly averageSteps: number | null;
  readonly habitCompletionPercent: number | null;
  readonly eating: EatingDurationStats | null;
  readonly generatedBy: "deterministic-analytics";
}
