import type { EatingDurationStats, Reminder, WeightPoint } from "./types.js";
import type { HabitLike } from "./habits.js";
import { daysBetween, parseIsoDate } from "./dates.js";
import { habitCompletion } from "./habits.js";
import { latestWeight } from "./body.js";

export interface ReminderInput {
  readonly today: string;
  readonly weightEntries: readonly WeightPoint[];
  readonly goal?: { readonly targetWeightKg: number; readonly targetDate?: string };
  readonly lifestyle?: {
    readonly sleepHours?: number;
    readonly hydrationMl?: number;
    readonly steps?: number;
    readonly activeMinutes?: number;
  };
  readonly habits?: readonly HabitLike[];
  readonly eating?: EatingDurationStats | null;
  readonly weeklyTrendKgPerWeek?: number | null;
}

function daysLeftInWeek(today: string): number {
  const day = parseIsoDate(today).getUTCDay(); // 0 = Sunday
  return (7 - day) % 7;
}

/**
 * Deterministic, rule-based reminders. No model, no network, no consent needed.
 */
export function buildReminders(input: ReminderInput): Reminder[] {
  const reminders: Reminder[] = [];

  const latest = latestWeight(input.weightEntries);
  if (!latest) {
    reminders.push({
      id: "weight-first-entry",
      rule: "weight-log-gap",
      severity: "info",
      title: "Log your first weight",
      detail: "A baseline measurement makes trends and goal progress available.",
    });
  } else {
    const gap = daysBetween(latest.date, input.today);
    if (Number.isFinite(gap) && gap >= 3) {
      reminders.push({
        id: "weight-log-gap",
        rule: "weight-log-gap",
        severity: "attention",
        title: "Weight log is stale",
        detail: `Last entry was ${gap} days ago. Trends pause while there are no new measurements.`,
      });
    }
  }

  const hydration = input.lifestyle?.hydrationMl;
  if (typeof hydration === "number" && hydration < 1500) {
    reminders.push({
      id: "hydration-low",
      rule: "hydration-minimum",
      severity: "attention",
      title: "Hydration below your daily minimum",
      detail: `${hydration} ml logged so far. Your local target is 1500 ml.`,
    });
  }

  const sleep = input.lifestyle?.sleepHours;
  if (typeof sleep === "number" && sleep < 6.5) {
    reminders.push({
      id: "sleep-low",
      rule: "sleep-minimum",
      severity: "attention",
      title: "Short sleep last night",
      detail: `${sleep.toFixed(1)} hours logged. Consider protecting sleep before adding intensity.`,
    });
  }

  const steps = input.lifestyle?.steps;
  if (typeof steps === "number" && steps < 4000) {
    reminders.push({
      id: "steps-low",
      rule: "movement-minimum",
      severity: "info",
      title: "Movement is low today",
      detail: `${steps} steps logged. A short walk would close part of the gap.`,
    });
  }

  if (input.habits && input.habits.length > 0) {
    const remainingDays = daysLeftInWeek(input.today);
    if (remainingDays <= 2) {
      const weekStart = new Date(
        parseIsoDate(input.today).getTime() - 6 * 86_400_000,
      )
        .toISOString()
        .slice(0, 10);
      for (const habit of input.habits) {
        const summary = habitCompletion(habit, weekStart, input.today);
        if (summary.remaining > 0) {
          reminders.push({
            id: `habit-at-risk-${habit.id}`,
            rule: "habit-week-at-risk",
            severity: "info",
            title: `${habit.name}: ${summary.remaining} to go`,
            detail: `${remainingDays === 0 ? "Today is the last day" : `${remainingDays} day(s) left`} this week to reach ${habit.targetPerWeek} completions.`,
          });
        }
      }
    }
  }

  const eating = input.eating;
  if (eating && eating.count >= 3 && eating.medianMinutes !== null && eating.medianMinutes < 10) {
    reminders.push({
      id: "eating-fast",
      rule: "eating-duration-minimum",
      severity: "info",
      title: "Meals are short",
      detail: `Median eating duration is ${eating.medianMinutes} minutes across ${eating.count} sessions.`,
    });
  }

  const trend = input.weeklyTrendKgPerWeek;
  if (input.goal && typeof trend === "number" && latest) {
    const needsLoss = latest.kg > input.goal.targetWeightKg;
    const movingAway = (needsLoss && trend > 0.15) || (!needsLoss && trend < -0.15);
    if (movingAway) {
      reminders.push({
        id: "goal-pace-away",
        rule: "goal-direction",
        severity: "attention",
        title: "Trend is moving away from your goal",
        detail: `Recent trend is ${trend > 0 ? "+" : ""}${trend.toFixed(2)} kg/week. Adjust the plan or the goal in Settings.`,
      });
    }
  }

  const order: Record<Reminder["severity"], number> = { attention: 0, info: 1 };
  return reminders.sort(
    (a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id),
  );
}
